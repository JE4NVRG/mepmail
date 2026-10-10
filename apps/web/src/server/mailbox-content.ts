import { randomUUID } from "node:crypto";
import {
  countMailboxSchedules,
  countMailboxViews,
  countUnreadMailboxItems,
  getMailboxOutboundSummary,
  listMailboxFolders,
  listMailboxItems,
  listMailboxRegistry,
  listMailboxThread,
  type MailboxContentActor,
  MailboxContentError,
  type MailboxListPosition,
  type MailboxOutboundSummary,
  saveMailboxDraft,
  storeMailboxListSummaries,
  summarizeMailboxThreads,
  withMailboxContentAccess,
  withMailboxItem,
  withMailboxItems,
  withMailboxListContents,
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
import { mailboxHtmlPreviewText } from "../lib/mailbox-html-preview";
import { mailboxPreview } from "../lib/mailbox-inbox-presentation";
import { decodeMailboxListSummary, encodeMailboxListSummary } from "../lib/mailbox-list-summary";
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

/** Runs `work` over `items` with at most `limit` at a time, keeping their order. */
async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!, index);
      }
    }),
  );
  return results;
}
/**
 * The list parse: the same limits as parse(), without converting HTML to text,
 * which costs several times the rest of the parse on an HTML-only message.
 */
async function parseForList(raw: Buffer) {
  if (!raw.length || raw.length > MAX_MIME) throw new MailboxContentError("invalid");
  const mime = await simpleParser(raw, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipHtmlToText: true,
  });
  if (
    mime.attachments.length > MAX_ATTACHMENTS ||
    mime.attachments.some((a) => a.content.length > MAX_ATTACHMENT)
  )
    throw new MailboxContentError("invalid");
  return mime;
}
/** What a list row shows: no HTML projection, image probing or reply lookups. */
function listDto(mime: Awaited<ReturnType<typeof parseForList>>) {
  return {
    subject: mime.subject ?? "",
    from: mime.from?.value[0]?.address ?? "",
    fromName: mime.from?.value[0]?.name ?? "",
    to: addresses(mime.to),
    // An HTML-only message gets a cheap preview from the start of its markup.
    text: mime.text || mailboxHtmlPreviewText(mime.html),
    date: mime.date && !Number.isNaN(mime.date.getTime()) ? mime.date : null,
    attachmentCount: mime.attachments.length,
  };
}
type OutboundResults = NonNullable<Awaited<ReturnType<typeof getMailboxOutboundSummary>>>;
/** Keep the private ledger behind the server boundary, including if its internal
 * contract later acquires correlation or recipient metadata. */
function outboundDto(results: OutboundResults | null): MailboxOutboundSummary | null {
  return results
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
  const outboundSummary = outboundDto(results);
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

/**
 * The content of a page of list rows, mailbox by mailbox: one authorization per
 * mailbox, envelopes opened a few at a time, and the send state of drafts and
 * sent messages read in one query each. The reader keeps getMailboxContent.
 */
async function listRowContents(
  db: Db,
  actor: MailboxContentActor,
  rows: { id: string; mailboxId: string }[],
) {
  type Content = ReturnType<typeof listDto> & {
    sentBy: { kind: "human" | "agent"; label: string | null } | null;
    sendStatus: (typeof schema.mailboxOutbox.$inferSelect)["status"] | null;
    outboundSummary: MailboxOutboundSummary | null;
  };
  const contents = new Map<string, Content>();
  const byMailbox = new Map<string, string[]>();
  for (const row of rows)
    byMailbox.set(row.mailboxId, [...(byMailbox.get(row.mailboxId) ?? []), row.id]);
  await runLimited([...byMailbox], 8, async ([mailboxId, ids]) => {
    const keyring = getKeyring();
    // Rows read from the message this time, sealed afterwards as list summaries.
    const fresh: { id: string; revision: number; summary: Buffer }[] = [];
    // Summaries that opened but no longer decode: read from the message below.
    const stale: string[] = [];
    const fromSummaries = await withMailboxListContents(
      db,
      keyring,
      actor,
      { mailboxId, ids },
      (items) =>
        runLimited(items, 8, async (item) => {
          const head = { id: item.id, kind: item.kind, revision: item.revision };
          if (item.listSummary) {
            const stored = decodeMailboxListSummary(item.listSummary);
            if (stored) return { ...head, ...stored };
            stale.push(item.id);
            return null;
          }
          const content = listDto(await parseForList(item.raw));
          const summary = encodeMailboxListSummary(content);
          if (summary) fresh.push({ id: item.id, revision: item.revision, summary });
          return { ...head, ...content };
        }),
    );
    const reread = stale.length
      ? await withMailboxItems(db, keyring, actor, { mailboxId, ids: stale }, (items) =>
          runLimited(items, 8, async (item) => ({
            id: item.id,
            kind: item.kind,
            revision: item.revision,
            ...listDto(await parseForList(item.raw)),
          })),
        )
      : [];
    const parsed = [
      ...fromSummaries.filter((item): item is NonNullable<typeof item> => item !== null),
      ...reread,
    ];
    if (fresh.length) {
      try {
        await storeMailboxListSummaries(db, keyring, actor, { mailboxId, entries: fresh });
      } catch {
        // A cache: the next listing reads these rows from the message again.
      }
    }
    const draftIds = parsed.filter((item) => item.kind === "draft").map((item) => item.id);
    const sentIds = parsed.filter((item) => item.kind === "sent").map((item) => item.id);
    const drafts = draftIds.length
      ? await db
          .select({
            id: schema.mailboxOutbox.id,
            draftId: schema.mailboxOutbox.draftId,
            draftRevision: schema.mailboxOutbox.draftRevision,
            status: schema.mailboxOutbox.status,
          })
          .from(schema.mailboxOutbox)
          .where(
            and(
              eq(schema.mailboxOutbox.teamId, actor.teamId),
              eq(schema.mailboxOutbox.mailboxId, mailboxId),
              inArray(schema.mailboxOutbox.draftId, draftIds),
            ),
          )
      : [];
    const sent = sentIds.length
      ? await acceptedSent(db, actor, mailboxId, inArray(schema.mailboxOutbox.id, sentIds))
      : [];
    await runLimited(parsed, 8, async ({ id, kind, revision, ...content }) => {
      let sendStatus: Content["sendStatus"] = null;
      let sentBy: Content["sentBy"] = null;
      let outboxId: string | null = null;
      if (kind === "sent") {
        const match = sent.find((entry) => entry.id === id);
        if (match) {
          outboxId = match.id;
          sendStatus = "accepted";
          sentBy = {
            kind: match.approvalKind,
            label: match.approvalKind === "agent" ? match.agentLabel : null,
          };
        }
      } else if (kind === "draft") {
        const match = drafts.find(
          (entry) => entry.draftId === id && entry.draftRevision === revision,
        );
        sendStatus = match?.status ?? null;
        outboxId = match?.id ?? null;
      }
      const results = outboxId
        ? await getMailboxOutboundSummary(db, { teamId: actor.teamId, mailboxId, outboxId })
        : null;
      contents.set(`${mailboxId}:${id}`, {
        ...content,
        sendStatus,
        sentBy,
        outboundSummary: outboundDto(results),
      });
    });
  });
  return contents;
}

/** A message's conversation in its mailbox, oldest first, each entry read with live access. */
export async function getMailboxThread(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string },
) {
  actor = { ...actor };
  input = { ...input };
  const members = await listMailboxThread(db, actor, input);
  const entries = [];
  for (const member of members) {
    const item = await getMailboxContent(db, actor, { mailboxId: member.mailboxId, id: member.id });
    entries.push({
      id: member.id,
      mailboxId: member.mailboxId,
      kind: member.kind,
      from: item.from,
      fromName: item.fromName,
      to: item.to,
      date: item.date ?? member.createdAt,
      snippet: mailboxPreview(item.text),
      text: item.text.slice(0, 20000),
      current: member.id === input.id,
    });
  }
  return { entries, contentTrust: "untrusted-message" as const };
}

const LIST_DEFAULT = 50;
const LIST_MAX = 100;
/** Opaque to clients: "<order time in epoch µs>.<item id>", base64url. */
/** Views of the owner's own organizing: snoozed, pinned, sending later, waiting for a reply. */
const ORGANIZING_VIEWS = ["snoozed", "pinned", "scheduled", "followups"];
export function encodeMailboxListCursor(position: MailboxListPosition) {
  return Buffer.from(`${position.at}.${position.id}`, "utf8").toString("base64url");
}
export function decodeMailboxListCursor(cursor: string): MailboxListPosition {
  if (typeof cursor !== "string" || cursor.length > 80 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new MailboxContentError("invalid");
  const match =
    /^([0-9]{1,17})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
  if (!match) throw new MailboxContentError("invalid");
  return { at: match[1]!, id: match[2]! };
}
const newerFirst = (a: MailboxListPosition, b: MailboxListPosition) => {
  const at = BigInt(b.at) - BigInt(a.at);
  return at > 0n ? 1 : at < 0n ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/**
 * Unified view, one page at a time; every decrypted row rechecks live mailbox
 * access. `cursor` continues after the previous page's last row, `nextCursor`
 * is null on the last page. With `groupByThread`, a conversation appears once,
 * as its newest message in this view.
 */
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
      | "custom"
      | "snoozed"
      | "pinned"
      | "scheduled"
      | "followups";
    customFolderId?: string | undefined;
    mailboxKind?: "person" | "agent" | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    groupByThread?: boolean | undefined;
  },
) {
  actor = { ...actor };
  input = { ...input };
  const pageSize = input.limit ?? LIST_DEFAULT;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIST_MAX)
    throw new MailboxContentError("invalid");
  const before = input.cursor === undefined ? undefined : decodeMailboxListCursor(input.cursor);
  // The owner's own organizing views (snoozed, pinned, scheduled, follow-ups) are not for agents.
  if (
    actor.agentAccess &&
    ["spam", "quarantine", "trash", "archive", ...ORGANIZING_VIEWS].includes(input.folder)
  )
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
    : input.folder === "drafts" || input.folder === "scheduled"
      ? "draft"
      : input.folder === "sent" || input.folder === "followups"
        ? "sent"
        : "inbox";
  const metadata = [];
  const mailboxesTruncated = readable.length > 20;
  const pages = await runLimited(readable.slice(0, 20), 8, async (box) => ({
    box,
    // One extra row per box tells whether anything follows this page.
    rows: await listMailboxItems(
      db,
      actor,
      box.id,
      {
        ...(kind ? { kind } : {}),
        trashed: input.folder === "trash",
        ...(input.folder === "favorites" ? { starred: true, safeOnly: true } : {}),
        ...(input.folder === "custom" ? { folderId: input.customFolderId!, safeOnly: true } : {}),
        ...(input.folder === "archive" ? { archived: true, safeOnly: true } : {}),
        // Filed and archived messages leave the ordinary views (agents see them all).
        ...(!actor.agentAccess && ["inbox", "drafts", "sent", "pinned"].includes(input.folder)
          ? { folderId: null, archived: false }
          : {}),
        ...(kind === "inbox"
          ? {
              deliveryFolder: (["snoozed", "pinned"].includes(input.folder)
                ? "inbox"
                : input.folder) as "inbox" | "spam" | "quarantine",
            }
          : {}),
        // A snoozed message leaves every view but Snoozed (and Trash) until it is due.
        ...(input.folder === "snoozed"
          ? { snoozed: true }
          : input.folder === "trash"
            ? {}
            : { snoozed: false }),
        ...(input.folder === "pinned" ? { pinned: true } : {}),
        ...(input.folder === "scheduled" ? { scheduled: true } : {}),
        ...(input.folder === "followups" ? { followUp: true } : {}),
      },
      {
        ...(before ? { before } : {}),
        limit: pageSize + 1,
        latestPerThread: input.groupByThread === true,
      },
    ),
  }));
  for (const { box, rows } of pages)
    for (const row of rows)
      if (!kind || row.kind === kind)
        metadata.push({
          ...row,
          address: box.address,
          mailboxLabel: box.label,
          mailboxKind: box.kind,
        });
  // Newest arrival first, like every box's own listing; a draft by its last edit.
  // Starring, filing or archiving never reorders the list. Same key as the store's
  // ORDER BY, so pages across mailboxes never skip or repeat a row.
  const position = (row: { orderAt: string; id: string }) => ({ at: row.orderAt, id: row.id });
  metadata.sort((a, b) => newerFirst(position(a), position(b)));
  const more = metadata.length > pageSize;
  const shown = metadata.slice(0, pageSize);
  const last = shown.at(-1);
  const nextCursor = more && last ? encodeMailboxListCursor(position(last)) : null;
  const limited = mailboxesTruncated || nextCursor !== null;
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
    snoozedUntil: Date | null;
    pinnedAt: Date | null;
    sendAt: Date | null;
    sendFailure: (typeof schema.mailboxItems.$inferSelect)["sendFailure"];
    remindAt: Date | null;
    remindedAt: Date | null;
    inboundAssessment: (typeof schema.mailboxItems.$inferSelect)["inboundAssessment"];
    sentBy: { kind: "human" | "agent"; label: string | null } | null;
    sendStatus: (typeof schema.mailboxOutbox.$inferSelect)["status"] | null;
    outboundSummary: MailboxOutboundSummary | null;
    blocked: boolean;
    threadKey: string | null;
    threadCount: number;
    threadUnread: number;
  }[] = [];
  // Messages per conversation, counted inside each listed mailbox.
  const threadStates = new Map<string, { count: number; unread: number }>();
  await runLimited([...new Set(shown.map((row) => row.mailboxId))], 8, async (mailboxId) => {
    const states = await summarizeMailboxThreads(
      db,
      actor,
      mailboxId,
      shown.filter((row) => row.mailboxId === mailboxId).map((row) => row.threadKey),
    );
    for (const [key, state] of states) threadStates.set(`${mailboxId}:${key}`, state);
  });
  const blockedRow = (row: (typeof shown)[number]) =>
    row.deliveryFolder === "quarantine" || row.inboundAssessment?.decision === "quarantine";
  const contents = await listRowContents(
    db,
    actor,
    shown.filter((row) => !blockedRow(row)),
  );
  // Without a conversation (or outside one, e.g. a draft) a row stands for itself.
  const threadState = (row: {
    mailboxId: string;
    threadKey: string | null;
    kind: string;
    seenAt: Date | null;
  }) =>
    (row.threadKey ? threadStates.get(`${row.mailboxId}:${row.threadKey}`) : undefined) ?? {
      count: 1,
      unread: row.kind === "inbox" && row.seenAt === null ? 1 : 0,
    };
  for (const row of shown) {
    if (blockedRow(row)) {
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
        threadKey: null,
        threadCount: 1,
        threadUnread: 0,
      });
      continue;
    }
    const thread = threadState(row);
    const item = contents.get(`${row.mailboxId}:${row.id}`);
    // Gone between the listing and the read (deleted, or access changed): skip it.
    if (!item) continue;
    items.push({
      id: row.id,
      mailboxId: row.mailboxId,
      address: row.address,
      mailboxLabel: row.mailboxLabel,
      kind: row.kind,
      revision: row.revision,
      subject: item.subject,
      from: item.from,
      fromName: item.fromName,
      to: item.to,
      snippet: mailboxPreview(item.text),
      date: item.date ?? row.updatedAt,
      attachmentCount: item.attachmentCount,
      mailboxKind: row.mailboxKind,
      deliveryFolder: row.deliveryFolder,
      trashedAt: row.trashedAt,
      starredAt: row.starredAt,
      seenAt: row.seenAt,
      archivedAt: row.archivedAt,
      folderId: row.folderId,
      snoozedUntil: row.snoozedUntil,
      pinnedAt: row.pinnedAt,
      sendAt: row.sendAt,
      sendFailure: row.sendFailure,
      remindAt: row.remindAt,
      remindedAt: row.remindedAt,
      inboundAssessment: row.inboundAssessment,
      sentBy: item.sentBy,
      sendStatus: item.sendStatus,
      outboundSummary: item.outboundSummary,
      blocked: false,
      threadKey: row.threadKey,
      threadCount: thread.count,
      threadUnread: thread.unread,
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
    async () => ({ items: withRequests, limited, mailboxesTruncated, nextCursor }),
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

/** Mailboxes the folder rail spans: one, or every mailbox the actor owns (first 20). */
async function railMailboxes(db: Db, actor: MailboxContentActor, mailboxId: string | null) {
  if (actor.agentAccess) throw new MailboxContentError("forbidden");
  const registry = await listMailboxRegistry(db, actor);
  const readable = registry.mailboxes.filter(
    (box) =>
      box.canRead &&
      box.status === "planned" &&
      (mailboxId ? box.id === mailboxId : box.ownerUserId === actor.userId),
  );
  if (mailboxId && !readable.length) throw new MailboxContentError("forbidden");
  return { boxes: readable.slice(0, 20), mailboxesTruncated: readable.length > 20 };
}

/**
 * How many messages wait in Snoozed, Scheduled and Follow-ups across the rail's
 * mailboxes (one, or every mailbox the actor owns), for the rail's counts.
 */
export async function getMailboxScheduleCounts(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string | null },
) {
  actor = { ...actor };
  const { boxes } = await railMailboxes(db, actor, input.mailboxId);
  const total = { snoozed: 0, scheduled: 0, followUps: 0 };
  for (const box of boxes) {
    const counts = await countMailboxSchedules(db, actor, box.id);
    total.snoozed += counts.snoozed;
    total.scheduled += counts.scheduled;
    total.followUps += counts.followUps;
  }
  return total;
}

/**
 * Named folders for the rail. With a mailbox, that mailbox's folders; with null,
 * the folders of every mailbox the actor owns, each carrying its mailboxId, in
 * mailbox order and then each mailbox's own manual order.
 */
export async function getMailboxRailFolders(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string | null },
) {
  actor = { ...actor };
  const { boxes } = await railMailboxes(db, actor, input.mailboxId);
  const folders = [];
  for (const box of boxes)
    folders.push(...(await listMailboxFolders(db, actor, { mailboxId: box.id })));
  return folders;
}

/**
 * Unread and total per view for the rail. With null, Inbox and Spam add up over the
 * actor's own mailboxes and every folder appears under its own id.
 */
export async function getMailboxFolderCounts(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string | null },
) {
  actor = { ...actor };
  const { boxes, mailboxesTruncated } = await railMailboxes(db, actor, input.mailboxId);
  const inbox = { unread: 0, total: 0 };
  const spam = { unread: 0, total: 0 };
  const folders: Record<string, { unread: number; total: number }> = {};
  for (const box of boxes) {
    const counts = await countMailboxViews(db, actor, box.id);
    inbox.unread += counts.inbox.unread;
    inbox.total += counts.inbox.total;
    spam.unread += counts.spam.unread;
    spam.total += counts.spam.total;
    for (const [id, count] of counts.folders) folders[id] = count;
  }
  return { inbox, spam, folders, mailboxesTruncated };
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
