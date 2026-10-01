import { randomUUID } from "node:crypto";
import {
  listMailboxItems,
  listMailboxRegistry,
  MailboxContentError,
  type MailboxContentActor,
  saveMailboxDraft,
  withMailboxItem,
  withMailboxContentAccess,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { pilotImageMetadata } from "../../../../packages/core/src/mailbox-pilot-images";
import { getKeyring } from "./keyring";

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
  return (
    (value ?? "attachment").replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 160) || "attachment"
  );
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
    .filter((v) => v.length <= 512 && !/[\r\n]/.test(v))
    .slice(-50);
}
function dto(mime: Awaited<ReturnType<typeof parse>>) {
  return {
    subject: mime.subject ?? "",
    from: mime.from?.value[0]?.address ?? "",
    fromName: mime.from?.value[0]?.name ?? "",
    to: addresses(mime.to),
    replyTo: mime.replyTo?.value[0]?.address ?? mime.from?.value[0]?.address ?? "",
    text: mime.text ?? "",
    date: mime.date && !Number.isNaN(mime.date.getTime()) ? mime.date : null,
    attachments: mime.attachments.map((a, index) => {
      const image = pilotImageMetadata(a.content);
      return { index, filename: filename(a.filename), bytes: a.content.length, image };
    }),
  };
}

export async function getMailboxContent(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string },
) {
  return withMailboxItem(db, getKeyring(), actor, input, async ({ raw, ...item }) => ({
    ...item,
    ...dto(await parse(raw)),
  }));
}

/** Bounded unified view; every decrypted row rechecks live mailbox access. */
export async function getMailboxContentList(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string | null; folder: "inbox" | "drafts" | "sent" },
) {
  const registry = await listMailboxRegistry(db, actor);
  const readable = registry.mailboxes.filter(
    (b) => b.canRead && b.status === "planned" && (!input.mailboxId || b.id === input.mailboxId),
  );
  if (input.mailboxId && !readable.length) throw new MailboxContentError("forbidden");
  if (input.folder === "sent") return { items: [], limited: false };
  const kind = input.folder === "drafts" ? "draft" : "inbox";
  const metadata = [];
  let limited = readable.length > 20;
  for (const box of readable.slice(0, 20)) {
    const rows = await listMailboxItems(db, actor, box.id);
    if (rows.length === 100) limited = true;
    for (const row of rows)
      if (row.kind === kind)
        metadata.push({ ...row, address: box.address, mailboxLabel: box.label });
  }
  metadata.sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id),
  );
  if (metadata.length > 50) limited = true;
  const items: {
    id: string;
    mailboxId: string;
    address: string;
    mailboxLabel: string;
    kind: "inbox" | "draft";
    revision: number;
    subject: string;
    from: string;
    fromName: string;
    to: string[];
    snippet: string;
    date: Date;
    attachmentCount: number;
  }[] = [];
  for (const row of metadata.slice(0, 50)) {
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
      snippet: item.text.slice(0, 160),
      date: item.date ?? row.updatedAt,
      attachmentCount: item.attachments.length,
    });
  }
  return withMailboxContentAccess(
    db,
    actor,
    items.map((item) => item.mailboxId),
    async () => ({ items, limited }),
  );
}

export interface MailboxDraftInput {
  mailboxId: string;
  id?: string | undefined;
  expectedRevision: number;
  sourceItemId?: string | undefined;
  to: string[];
  subject: string;
  text: string;
  retainedAttachments: number[];
  uploads: { filename: string; base64: string }[];
}
export async function saveMailboxContentDraft(
  db: Db,
  actor: MailboxContentActor,
  input: MailboxDraftInput,
) {
  const registry = await listMailboxRegistry(db, actor);
  const box = registry.mailboxes.find(
    (b) => b.id === input.mailboxId && b.canDraft && b.status === "planned",
  );
  if (!box) throw new MailboxContentError("forbidden");
  // Existing draft attachments/headers always come from the item being updated.
  if (input.id && input.sourceItemId !== input.id) throw new MailboxContentError("invalid");
  const source = input.sourceItemId
    ? await withMailboxItem(
        db,
        getKeyring(),
        actor,
        { mailboxId: box.id, id: input.sourceItemId },
        async (item) => {
          if (input.id && item.revision !== input.expectedRevision)
            throw new MailboxContentError("conflict");
          return { kind: item.kind, mime: await parse(item.raw) };
        },
      )
    : null;
  if (input.id && source?.kind !== "draft") throw new MailboxContentError("conflict");
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
  const reply = source?.kind === "inbox" ? source.mime : null;
  const refs = source ? references(source.mime) : [];
  const originalId =
    source?.mime.messageId &&
    !/[\r\n]/.test(source.mime.messageId) &&
    source.mime.messageId.length <= 512
      ? source.mime.messageId
      : undefined;
  // streamTransport buffers a MIME capture. It never connects to SMTP/SES.
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
  });
  const result = await transport.sendMail({
    from: box.address,
    to: input.to,
    subject: input.subject,
    text: input.text,
    messageId: input.id ? originalId : `<${randomUUID()}@${box.address.split("@")[1]}>`,
    inReplyTo: reply ? originalId : source?.mime.inReplyTo,
    references: reply && originalId ? [...refs, originalId] : refs,
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
