import { randomUUID } from "node:crypto";
import {
  countUnreadMailboxItems,
  getMailboxOutboundSummary,
  listMailboxFolders,
  listMailboxItems,
  listMailboxRegistry,
  type MailboxContentActor,
  MailboxContentError,
  type MailboxOutboundSummary,
  saveMailboxDraft,
  withMailboxContentAccess,
  withMailboxItem,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import {
  mailboxMessageId,
  mailboxReplyIds,
} from "../../../../packages/core/src/mailbox-message-id";
import { pilotImageMetadata } from "../../../../packages/core/src/mailbox-pilot-images";
import { mailboxSignature } from "../lib/mailbox-compose-signature";
import { mailboxPreview } from "../lib/mailbox-inbox-presentation";
import { mailboxDraftHtml, mailboxSignatureText } from "../lib/mailbox-signature";
import { getKeyring } from "./keyring";
import { projectMailboxHtml } from "./mailbox-html";
import { publicStorageOrigin, publicStoragePrefix } from "./storage";

const MAX_MIME = 1024 * 1024;
const MAX_ATTACHMENT = 256 * 1024;
const MAX_ATTACHMENTS = 10;
export const MAILBOX_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  Vary: "Cookie",
};

function filename(value: string | undefined) {
  const original = value ?? "attachment";
  let sanitized = "";
  for (let index = 0; index < original.length && index < 160; index++) {
    const character = original.charAt(index);
    const code = original.charCodeAt(index);
    sanitized +=
      code < 32 || code === 127 || character === "/" || character === "\\" ? "_" : character;
  }
  return sanitized || "attachment";
}
async function parse(raw: Buffer) {
  if (!raw.length || raw.length > MAX_MIME) throw new MailboxContentError("invalid");
  const mime = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  if (
    mime.attachments.length > MAX_ATTACHMENTS ||
    mime.attachments.some((a) => a.content.length > MAX_ATTACHMENT)
  )
    throw new MailboxContentError("invalid");
  return mime;
}
function addresses(value: Awaited<ReturnType<typeof simpleParser>>["to"]) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((v) => v.value)
    .map((v) => v.address)
    .filter((v): v is string => !!v);
}
function references(mime: Awaited<ReturnType<typeof parse>>) {
  return [
    ...new Set([
      ...(Array.isArray(mime.references)
        ? mime.references
        : mime.references
          ? [mime.references]
          : []),
      ...(mime.inReplyTo ? [mime.inReplyTo] : []),
    ]),
  ]
    .map(mailboxMessageId)
    .filter((v): v is string => v !== null)
    .slice(-50);
}
function dto(mime: Awaited<ReturnType<typeof parse>>) {
  return {
    subject: mime.subject ?? "",
    from: mime.from?.value[0]?.address ?? "",
    fromName: mime.from?.value[0]?.name ?? "",
    to: addresses(mime.to),
    cc: addresses(mime.cc),
    replyTo: mime.replyTo?.value[0]?.address ?? mime.from?.value[0]?.address ?? "",
    text: mime.text ?? "",
    hasHtmlBody: typeof mime.html === "string" && mime.html.length > 0,
    ...projectMailboxHtml(mime.html, mime.attachments, {
      trustedImagePrefix: publicStoragePrefix(),
    }),
    trustedImageOrigin: publicStorageOrigin(),
    date: mime.date && !Number.isNaN(mime.date.getTime()) ? mime.date : null,
    attachments: mime.attachments.map((a, index) => {
      const image = pilotImageMetadata(a.content);
      return { index, filename: filename(a.filename), bytes: a.content.length, image };
    }),
  };
}

/** Metadata is a correlation hint, never authority. Only accepted outboxes with
 * an actual Sent item in this exact team/box can supply a confirmed alias.
 */
function acceptedSent(db: Db, actor: MailboxContentActor, mailboxId: string, match: SQL) {
  return db
    .select({
      id: schema.mailboxOutbox.id,
      messageId: schema.mailboxOutbox.providerRfcMessageId,
      approvalKind: schema.mailboxOutbox.approvalKind,
      agentLabel: schema.mailboxAgentKeys.label,
    })
    .from(schema.mailboxOutbox)
    .innerJoin(
      schema.mailboxItems,
      and(
        eq(schema.mailboxItems.id, schema.mailboxOutbox.id),
        eq(schema.mailboxItems.mailboxId, schema.mailboxOutbox.mailboxId),
        eq(schema.mailboxItems.teamId, schema.mailboxOutbox.teamId),
        eq(schema.mailboxItems.kind, "sent"),
      ),
    )
    .leftJoin(
      schema.mailboxAgentKeys,
      and(
        eq(schema.mailboxAgentKeys.id, schema.mailboxOutbox.agentKeyId),
        eq(schema.mailboxAgentKeys.mailboxId, schema.mailboxOutbox.mailboxId),
        eq(schema.mailboxAgentKeys.teamId, schema.mailboxOutbox.teamId),
      ),
    )
    .where(
      and(
        eq(schema.mailboxOutbox.teamId, actor.teamId),
        eq(schema.mailboxOutbox.mailboxId, mailboxId),
        eq(schema.mailboxOutbox.status, "accepted"),
        match,
      ),
    );
}

export async function getMailboxContent(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string },
) {
  actor = { ...actor };
  input = { ...input };
  const { replyIds, ...content } = await withMailboxItem(
    db,
    getKeyring(),
    actor,
    input,
    async ({ raw, ...item }) => {
      const mime = await parse(raw);
      const metadata = dto(mime);
      return {
        ...item,
        ...metadata,
        // Captured MIME ID; for Sent this is not a claim about SES's final ID.
        messageId: mailboxMessageId(mime.messageId),
        replyTo: item.kind === "sent" ? addresses(mime.to).join(", ") : metadata.replyTo,
        replyIds: item.kind === "inbox" ? mailboxReplyIds(mime) : [],
      };
    },
  );
  // Do not use a second connection inside withMailboxItem's read transaction.
  // Recheck current access before returning the content and correlated metadata.
  let transportMessageId: string | null = null;
  let replyToSentItemId: string | null = null;
  let sendStatus: (typeof schema.mailboxOutbox.$inferSelect)["status"] | null = null;
  let sentBy: { kind: "human" | "agent"; label: string | null } | null = null;
  let outboxId: string | null = null;
  if (content.kind === "sent") {
    const [sent] = await acceptedSent(
      db,
      actor,
      input.mailboxId,
      eq(schema.mailboxOutbox.id, input.id),
    );
    transportMessageId = mailboxMessageId(sent?.messageId);
    if (sent) {
      outboxId = sent.id;
      sendStatus = "accepted";
      sentBy = {
        kind: sent.approvalKind,
        label: sent.approvalKind === "agent" ? sent.agentLabel : null,
      };
    }
  } else if (replyIds.length) {
    const matches = await acceptedSent(
      db,
      actor,
      input.mailboxId,
      inArray(schema.mailboxOutbox.providerRfcMessageId, replyIds),
    );
    for (const id of replyIds) {
      const match = matches.find((sent) => sent.messageId === id);
      if (match) {
        replyToSentItemId = match.id;
        break;
      }
    }
  }
  if (content.kind === "draft") {
    const [submitted] = await db
      .select({ id: schema.mailboxOutbox.id, status: schema.mailboxOutbox.status })
      .from(schema.mailboxOutbox)
      .where(
        and(
          eq(schema.mailboxOutbox.teamId, actor.teamId),
          eq(schema.mailboxOutbox.mailboxId, input.mailboxId),
          eq(schema.mailboxOutbox.draftId, input.id),
          eq(schema.mailboxOutbox.draftRevision, content.revision),
        ),
      )
      .limit(1);
    sendStatus = submitted?.status ?? null;
    outboxId = submitted?.id ?? null;
  }
  const results = outboxId
    ? await getMailboxOutboundSummary(db, {
        teamId: actor.teamId,
        mailboxId: input.mailboxId,
        outboxId,
      })
    : null;
  // Keep the private ledger behind the server boundary, including if its
  // internal contract later acquires correlation or recipient metadata.
  const outboundSummary: MailboxOutboundSummary | null = results
    ? {
        totalRecipients: results.totalRecipients,
        delivered: results.delivered,
        delayed: results.delayed,
        hardBounce: results.hardBounce,
        complaint: results.complaint,
        softBounce: results.softBounce,
        rejected: results.rejected,
        renderingFailed: results.renderingFailed,
        unconfirmed: results.unconfirmed,
        lastObservedAt: results.lastObservedAt,
      }
    : null;
  return withMailboxContentAccess(db, actor, [input.mailboxId], async () => ({
    ...content,
    contentTrust: "untrusted-message" as const,
    transportMessageId,
    replyToSentItemId,
    sendStatus,
    sentBy,
    outboundSummary,
  }));
}

/** Bounded unified view; every decrypted row rechecks live mailbox access. */
export async function getMailboxContentList(
  db: Db,
  actor: MailboxContentActor,
  input: {
    mailboxId: string | null;
    folder:
      | "inbox"
      | "drafts"
      | "sent"
      | "spam"
      | "quarantine"
      | "trash"
      | "favorites"
      | "archive"
      | "custom";
    customFolderId?: string | undefined;
    mailboxKind?: "person" | "agent" | undefined;
  },
) {
  actor = { ...actor };
  input = { ...input };
  if (actor.agentAccess && ["spam", "quarantine", "trash", "archive"].includes(input.folder))
    throw new MailboxContentError("forbidden");
  if (
    (input.folder === "custom" && (!input.mailboxId || !input.customFolderId)) ||
    (input.folder !== "custom" && input.customFolderId !== undefined)
  )
    throw new MailboxContentError("invalid");
  if (input.folder === "custom") {
    const folders = await listMailboxFolders(db, actor, { mailboxId: input.mailboxId! });
    if (!folders.some((folder) => folder.id === input.customFolderId))
      throw new MailboxContentError("not_found");
  }
  const registry = await listMailboxRegistry(db, actor);
  const readable = registry.mailboxes.filter(
    (b) =>
      b.canRead &&
      b.status === "planned" &&
      (!input.mailboxId || b.id === input.mailboxId) &&
      (!input.mailboxKind || b.kind === input.mailboxKind),
  );
  if (input.mailboxId && !readable.length) throw new MailboxContentError("forbidden");
  const kind = ["trash", "favorites", "archive", "custom"].includes(input.folder)
    ? undefined
    : input.folder === "drafts"
      ? "draft"
      : input.folder === "sent"
        ? "sent"
        : "inbox";
  const metadata = [];
  let limited = readable.length > 20;
  for (const box of readable.slice(0, 20)) {
    const rows = await listMailboxItems(db, actor, box.id, {
      ...(kind ? { kind } : {}),
      trashed: input.folder === "trash",
      ...(input.folder === "favorites" ? { starred: true, safeOnly: true } : {}),
      ...(input.folder === "custom" ? { folderId: input.customFolderId!, safeOnly: true } : {}),
      ...(input.folder === "archive" ? { archived: true, safeOnly: true } : {}),
      // Filed and archived messages leave the ordinary views (agents see them all).
      ...(!actor.agentAccess && ["inbox", "drafts", "sent"].includes(input.folder)
        ? { folderId: null, archived: false }
        : {}),
      ...(kind === "inbox"
        ? { deliveryFolder: input.folder as "inbox" | "spam" | "quarantine" }
        : {}),
    });
    if (rows.length === 100) limited = true;
    for (const row of rows)
      if (!kind || row.kind === kind)
        metadata.push({
          ...row,
          address: box.address,
          mailboxLabel: box.label,
          mailboxKind: box.kind,
        });
  }
  // Newest arrival first, like every box's own listing; a draft by its last edit.
  // Starring, filing or archiving never reorders the list.
  const order = (row: { kind: string; createdAt: Date; updatedAt: Date }) =>
    (row.kind === "draft" ? row.updatedAt : row.createdAt).getTime();
  metadata.sort((a, b) => order(b) - order(a) || b.id.localeCompare(a.id));
  if (metadata.length > 50) limited = true;
  const items: {
    id: string;
    mailboxId: string;
    address: string;
    mailboxLabel: string;
    kind: "inbox" | "draft" | "sent";
    revision: number;
    subject: string;
    from: string;
    fromName: string;
    to: string[];
    snippet: string;
    date: Date;
    attachmentCount: number;
    mailboxKind: "person" | "agent";
    deliveryFolder: "inbox" | "spam" | "quarantine";
    trashedAt: Date | null;
    starredAt: Date | null;
    seenAt: Date | null;
    archivedAt: Date | null;
    folderId: string | null;
    inboundAssessment: (typeof schema.mailboxItems.$inferSelect)["inboundAssessment"];
    sentBy: { kind: "human" | "agent"; label: string | null } | null;
    sendStatus: (typeof schema.mailboxOutbox.$inferSelect)["status"] | null;
    outboundSummary: MailboxOutboundSummary | null;
    blocked: boolean;
  }[] = [];
  for (const row of metadata.slice(0, 50)) {
    if (row.deliveryFolder === "quarantine" || row.inboundAssessment?.decision === "quarantine") {
      items.push({
        ...row,
        subject: "",
        from: "",
        fromName: "",
        to: [],
        snippet: "",
        date: row.createdAt,
        attachmentCount: 0,
        sentBy: null,
        sendStatus: null,
        outboundSummary: null,
        blocked: true,
      });
      continue;
    }
    const item = await getMailboxContent(db, actor, { mailboxId: row.mailboxId, id: row.id });
    items.push({
      id: row.id,
      mailboxId: row.mailboxId,
      address: row.address,
      mailboxLabel: row.mailboxLabel,
      kind: row.kind,
      revision: item.revision,
      subject: item.subject,
      from: item.from,
      fromName: item.fromName,
      to: item.to,
      snippet: mailboxPreview(item.text),
      date: item.date ?? row.updatedAt,
      attachmentCount: item.attachments.length,
      mailboxKind: row.mailboxKind,
      deliveryFolder: row.deliveryFolder,
      trashedAt: item.trashedAt,
      starredAt: item.starredAt,
      seenAt: item.seenAt,
      archivedAt: item.archivedAt,
      folderId: item.folderId,
      inboundAssessment: item.inboundAssessment,
      sentBy: item.sentBy,
      sendStatus: item.sendStatus,
      outboundSummary: item.outboundSummary,
      blocked: false,
    });
  }
  const requests = await draftApprovalRequests(db, actor.teamId, items);
  const withRequests = items.map((item) => ({
    ...item,
    // An agent without the send permission asked the owner to send this revision.
    approvalRequested: requests.get(`${item.id}:${item.revision}`) ?? null,
  }));
  return withMailboxContentAccess(
    db,
    actor,
    items.map((item) => item.mailboxId),
    async () => ({ items: withRequests, limited }),
  );
}

/** Approval requests recorded for these drafts, keyed by id and revision, with the agent's label. */
async function draftApprovalRequests(
  db: Db,
  teamId: string,
  items: readonly { id: string; kind: string; revision: number; blocked: boolean }[],
): Promise<Map<string, { agentLabel: string | null }>> {
  const drafts = items.filter((item) => item.kind === "draft" && !item.blocked);
  const found = new Map<string, { agentLabel: string | null }>();
  if (!drafts.length) return found;
  const rows = await db
    .select({ data: schema.auditLog.data, label: schema.mailboxAgentKeys.label })
    .from(schema.auditLog)
    .leftJoin(
      schema.mailboxAgentKeys,
      sql`${schema.mailboxAgentKeys.id}::text = ${schema.auditLog.data}->>'keyId'`,
    )
    .where(
      and(
        eq(schema.auditLog.teamId, teamId),
        eq(schema.auditLog.action, "mailbox.send_requested"),
        inArray(
          sql<string>`${schema.auditLog.data}->>'itemId'`,
          drafts.map((item) => item.id),
        ),
      ),
    );
  for (const row of rows) {
    const data = row.data as { itemId?: string; revision?: number } | null;
    if (data?.itemId && typeof data.revision === "number")
      found.set(`${data.itemId}:${data.revision}`, { agentLabel: row.label ?? null });
  }
  return found;
}

export interface MailboxDraftInput {
  mailboxId: string;
  id?: string | undefined;
  expectedRevision: number;
  sourceItemId?: string | undefined;
  mode?: "reply" | "forward" | undefined;
  to: string[];
  cc?: string[] | undefined;
  subject: string;
  text: string;
  retainedAttachments: number[];
  uploads: { filename: string; base64: string }[];
}
/**
 * Unread Inbox messages per mailbox the actor may read (the first 20, like
 * the list), for the folder rail. Agents have no rail and get nothing.
 */
export async function getMailboxUnreadCounts(db: Db, actor: MailboxContentActor) {
  actor = { ...actor };
  if (actor.agentAccess) throw new MailboxContentError("forbidden");
  const registry = await listMailboxRegistry(db, actor);
  const readable = registry.mailboxes
    .filter((box) => box.canRead && box.status === "planned")
    .slice(0, 20);
  const counts: Record<string, number> = {};
  for (const box of readable) counts[box.id] = await countUnreadMailboxItems(db, actor, box.id);
  return { counts };
}

export async function saveMailboxContentDraft(
  db: Db,
  actor: MailboxContentActor,
  input: MailboxDraftInput,
) {
  actor = { ...actor };
  input = {
    ...input,
    to: [...input.to],
    ...(input.cc ? { cc: [...input.cc] } : {}),
    retainedAttachments: [...input.retainedAttachments],
    uploads: input.uploads.map((upload) => ({ ...upload })),
  };
  const registry = await listMailboxRegistry(db, actor);
  const box = registry.mailboxes.find(
    (b) => b.id === input.mailboxId && b.canDraft && b.status === "planned",
  );
  if (!box) throw new MailboxContentError("forbidden");
  const cc = input.cc ?? [];
  // Sending counts To and Cc together against the same 20-recipient cap.
  if (input.to.length + cc.length > 20) throw new MailboxContentError("invalid");
  const signature = { profile: box.signatureProfile, text: box.signatureText };
  const footer = mailboxSignature(mailboxSignatureText(signature));
  // Agents write plain text through the API; their mailbox's signature is
  // added the way the composer adds it for people, once.
  const text =
    actor.agentAccess && footer && !input.text.includes(footer)
      ? `${input.text.replace(/\s+$/, "")}${footer}`
      : input.text;
  const mode = input.mode ?? "reply";
  if (mode !== "reply" && mode !== "forward") throw new MailboxContentError("invalid");
  // Forward creates a new message from an authorized Inbox/Sent item. Editing
  // a draft keeps that draft's own headers instead of reusing an earlier source.
  if (mode === "forward" && (input.id || !input.sourceItemId))
    throw new MailboxContentError("invalid");
  // Existing draft attachments/headers always come from the item being updated.
  if (input.id && input.sourceItemId !== input.id) throw new MailboxContentError("invalid");
  const source = input.sourceItemId
    ? await withMailboxItem(
        db,
        getKeyring(),
        actor,
        { mailboxId: box.id, id: input.sourceItemId },
        async (item) => {
          if (item.trashedAt !== null) throw new MailboxContentError("conflict");
          if (item.kind === "inbox" && item.deliveryFolder !== "inbox")
            throw new MailboxContentError("forbidden");
          if (input.id && item.revision !== input.expectedRevision)
            throw new MailboxContentError("conflict");
          return { kind: item.kind, mime: await parse(item.raw) };
        },
      )
    : null;
  if (input.id && source?.kind !== "draft") throw new MailboxContentError("conflict");
  if (mode === "forward" && source?.kind === "draft") throw new MailboxContentError("invalid");
  if (
    (!source && input.retainedAttachments.length) ||
    new Set(input.retainedAttachments).size !== input.retainedAttachments.length
  )
    throw new MailboxContentError("invalid");
  const attachments = input.retainedAttachments.map((index) => {
    const a = source?.mime.attachments[index];
    if (!a) throw new MailboxContentError("invalid");
    return {
      filename: filename(a.filename),
      content: a.content,
      contentType: a.contentType,
      cid: a.cid,
      contentDisposition: a.contentDisposition === "inline" ? "inline" : "attachment",
    };
  });
  for (const upload of input.uploads) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(upload.base64))
      throw new MailboxContentError("invalid");
    const content = Buffer.from(upload.base64, "base64");
    if (!content.length || content.length > MAX_ATTACHMENT)
      throw new MailboxContentError("invalid");
    attachments.push({
      filename: filename(upload.filename),
      content,
      contentType: "application/octet-stream",
      cid: undefined,
      contentDisposition: "attachment",
    });
  }
  if (attachments.length > MAX_ATTACHMENTS) throw new MailboxContentError("invalid");
  const reply = mode === "reply" && source && source.kind !== "draft" ? source.mime : null;
  const refs = mode === "reply" && source ? references(source.mime) : [];
  const originalId = mailboxMessageId(source?.mime.messageId) ?? undefined;
  let replyId = originalId;
  if (mode === "reply" && source?.kind === "sent") {
    const [sent] = await acceptedSent(
      db,
      actor,
      box.id,
      eq(schema.mailboxOutbox.id, input.sourceItemId!),
    );
    replyId = mailboxMessageId(sent?.messageId) ?? undefined;
    // A submitted ID cannot thread a reply to SES's overwritten Sent header.
    if (!replyId) throw new MailboxContentError("conflict");
  }
  // streamTransport buffers a MIME capture. It never connects to SMTP/SES.
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
  });
  const result = await transport.sendMail({
    from: box.address,
    to: input.to,
    ...(cc.length ? { cc } : {}),
    subject: input.subject,
    text,
    // The same words as HTML, with the mailbox's signature formatted where the
    // composer placed it. Rebuilt from the text on every save.
    html: mailboxDraftHtml(text, signature),
    messageId: input.id ? originalId : `<${randomUUID()}@${box.address.split("@")[1]}>`,
    inReplyTo:
      mode === "forward"
        ? undefined
        : reply
          ? replyId
          : (mailboxMessageId(source?.mime.inReplyTo) ?? undefined),
    references:
      mode === "forward"
        ? undefined
        : reply && replyId
          ? [...new Set([...refs, replyId])].slice(-50)
          : refs,
    attachments,
  });
  if (!Buffer.isBuffer(result.message) || result.message.length > MAX_MIME)
    throw new MailboxContentError("invalid");
  return saveMailboxDraft(db, getKeyring(), actor, {
    mailboxId: box.id,
    ...(input.id ? { id: input.id } : {}),
    expectedRevision: input.expectedRevision,
    raw: result.message,
  });
}

export async function getMailboxAttachmentResponse(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; index: number; revision: number; preview: boolean },
) {
  actor = { ...actor };
  input = { ...input };
  return withMailboxItem(db, getKeyring(), actor, input, async ({ raw, revision }) => {
    if (revision !== input.revision) throw new MailboxContentError("conflict");
    const mime = await parse(raw);
    const a = mime.attachments[input.index];
    if (!a) throw new MailboxContentError("not_found");
    const image = input.preview ? pilotImageMetadata(a.content) : null;
    if (input.preview && !image) throw new MailboxContentError("not_found");
    const safeName = encodeURIComponent(filename(a.filename)).replace(
      /['()]/g,
      (v) => "%" + v.charCodeAt(0).toString(16),
    );
    return new Response(new Uint8Array(a.content), {
      headers: {
        ...MAILBOX_PRIVATE_HEADERS,
        "Content-Type": image?.contentType ?? "application/octet-stream",
        "Content-Disposition": `${image ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${safeName}`,
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });
}
