import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { decryptPayload, encryptPayload } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";

// Local product qualification. Authentication and a production mailbox core are
// separate adapters; caller-supplied principal IDs must never be trusted over HTTP.
export type MailboxPermission = "read" | "draft" | "send" | "manage";
export interface MailboxActor {
  teamId: string;
  principalId: string;
}
export interface PilotMailbox {
  id: string;
  address: string;
  label: string;
  kind: "person" | "agent";
  grants: Record<string, MailboxPermission[]>;
}
export interface PilotAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  cid?: string;
  disposition?: string;
}
export interface PilotMime {
  messageId: string;
  subject: string;
  from: string;
  to: string[];
  replyTo: string;
  text: string;
  references: string[];
  attachments: PilotAttachment[];
}
export interface PilotMimeAdapter {
  parse(raw: Buffer): Promise<PilotMime>;
  compose(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    messageId: string;
    inReplyTo: string;
    references: string[];
    attachments: PilotAttachment[];
  }): Promise<Buffer>;
}
interface Message {
  id: string;
  mailboxId: string;
  sourceId: string;
  threadId: string;
  receivedAt: string;
  folder: "inbox" | "sent";
  raw: string;
}
interface Draft {
  id: string;
  mailboxId: string;
  originalId: string;
  threadId: string;
  text: string;
  raw: string;
  status: "draft" | "sent";
  createdBy?: string;
  createdAt?: string;
}
interface State {
  version: 1;
  teamId: string;
  mailboxes: PilotMailbox[];
  messages: Message[];
  drafts: Draft[];
}
export class MailboxPilotError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "too_large") {
    super(code);
  }
}

/** One process serializes changes. Encrypt metadata, MIME and drafts together;
 * atomic replacement means a failed write leaves the previous snapshot usable.
 * This bounded fixture store does not claim distributed production durability.
 */
export class MailboxPilot {
  private state!: State;
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly file: string,
    private readonly teamId: string,
    private readonly keyring: Keyring,
    private readonly mime: PilotMimeAdapter,
  ) {}
  static async open(
    file: string,
    teamId: string,
    keyring: Keyring,
    mime: PilotMimeAdapter,
    mailboxes: PilotMailbox[] = [],
  ): Promise<MailboxPilot> {
    if (!isAbsolute(file) || !teamId) throw new MailboxPilotError("invalid");
    const service = new MailboxPilot(file, teamId, keyring, mime);
    try {
      const raw = await readFile(file);
      if (raw.length > 8 * 1024 * 1024) throw new MailboxPilotError("too_large");
      const envelope = JSON.parse(raw.toString("utf8"));
      const plain = await decryptPayload(
        {
          keyVersion: envelope.keyVersion,
          iv: Buffer.from(envelope.iv, "base64"),
          wrappedDek: Buffer.from(envelope.wrappedDek, "base64"),
          ciphertext: Buffer.from(envelope.ciphertext, "base64"),
        },
        keyring,
        service.binding(),
      );
      service.state = JSON.parse(plain.toString("utf8"));
      if (service.state.version !== 1 || service.state.teamId !== teamId)
        throw new MailboxPilotError("invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const addresses = mailboxes.map((box) => address(box.address));
      if (
        !mailboxes.length ||
        new Set(addresses).size !== mailboxes.length ||
        new Set(mailboxes.map((box) => box.id)).size !== mailboxes.length
      )
        throw new MailboxPilotError("invalid");
      service.state = {
        version: 1,
        teamId,
        mailboxes: structuredClone(mailboxes),
        messages: [],
        drafts: [],
      };
      await service.persist(service.state);
    }
    return service;
  }
  private binding() {
    return { teamId: this.teamId, rowId: "mailbox-pilot-state-v1", kind: "email_body" as const };
  }
  private async persist(state: State) {
    const plain = this.serialize(state);
    const sealed = await encryptPayload(plain, this.keyring, this.binding());
    const data = JSON.stringify({
      keyVersion: sealed.keyVersion,
      iv: sealed.iv.toString("base64"),
      wrappedDek: sealed.wrappedDek.toString("base64"),
      ciphertext: sealed.ciphertext.toString("base64"),
    });
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  private serialize(state: State) {
    const plain = Buffer.from(JSON.stringify(state));
    if (plain.length > 4 * 1024 * 1024) throw new MailboxPilotError("too_large");
    return plain;
  }
  private async change<T>(operation: (state: State) => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      const next = structuredClone(this.state);
      const result = await operation(next);
      await this.persist(next);
      this.state = next;
      return result;
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
  private allow(actor: MailboxActor, mailboxId: string, permission: MailboxPermission) {
    const box = this.state.mailboxes.find((item) => item.id === mailboxId);
    const grants =
      box && Object.hasOwn(box.grants, actor.principalId) ? box.grants[actor.principalId] : [];
    if (!box || actor.teamId !== this.teamId || !grants?.includes(permission))
      throw new MailboxPilotError("forbidden");
    return box;
  }
  async mailboxes(actor: MailboxActor) {
    await this.tail;
    if (actor.teamId !== this.teamId) throw new MailboxPilotError("forbidden");
    return this.state.mailboxes
      .filter(
        (box) =>
          Object.hasOwn(box.grants, actor.principalId) &&
          box.grants[actor.principalId]?.includes("read"),
      )
      .map(({ grants, ...box }) => ({
        ...box,
        permissions: [...(grants[actor.principalId] ?? [])],
      }));
  }
  /** The trusted transport supplies sourceId and RCPT TO; MIME To never routes a mailbox. */
  async receive(input: { sourceId: string; recipients: string[]; raw: Buffer }) {
    if (!input.sourceId || input.sourceId.length > 256 || /[\r\n]/.test(input.sourceId))
      throw new MailboxPilotError("invalid");
    if (input.raw.length > 1024 * 1024) throw new MailboxPilotError("too_large");
    const recipients = new Set(input.recipients.map(address));
    const parsed = await this.mime.parse(input.raw);
    validateMime(parsed);
    return this.change(async (state) => {
      const matched = state.mailboxes.filter((box) => recipients.has(address(box.address)));
      if (!matched.length) throw new MailboxPilotError("not_found");
      let added = 0;
      for (const box of matched) {
        const duplicate = state.messages.find(
          (item) => item.mailboxId === box.id && item.sourceId === input.sourceId,
        );
        if (duplicate) {
          if (duplicate.raw !== input.raw.toString("base64"))
            throw new MailboxPilotError("invalid");
          continue;
        }
        // Link through Message-ID only inside the same mailbox, never across grants.
        let threadId: string | undefined;
        if (!threadId)
          for (const item of state.messages.filter((item) => item.mailboxId === box.id)) {
            const prior = await this.mime.parse(Buffer.from(item.raw, "base64"));
            if (parsed.references.includes(prior.messageId)) {
              threadId = item.threadId;
              break;
            }
          }
        const id = randomUUID();
        state.messages.push({
          id,
          mailboxId: box.id,
          sourceId: input.sourceId,
          threadId: threadId ?? id,
          receivedAt: new Date().toISOString(),
          folder: "inbox",
          raw: input.raw.toString("base64"),
        });
        added++;
      }
      return { accepted: added, duplicate: added === 0 };
    });
  }
  async list(actor: MailboxActor, mailboxId: string) {
    await this.tail;
    this.allow(actor, mailboxId, "read");
    const result = await Promise.all(
      this.state.messages
        .filter((item) => item.mailboxId === mailboxId)
        .map(async (item) => {
          const parsed = await this.mime.parse(Buffer.from(item.raw, "base64"));
          return {
            id: item.id,
            threadId: item.threadId,
            folder: item.folder,
            receivedAt: item.receivedAt,
            subject: parsed.subject,
            from: parsed.from,
            preview: parsed.text.slice(0, 120),
            attachments: parsed.attachments.length,
          };
        }),
    );
    await this.tail;
    this.allow(actor, mailboxId, "read");
    return result;
  }
  async read(actor: MailboxActor, mailboxId: string, messageId: string) {
    await this.tail;
    this.allow(actor, mailboxId, "read");
    const item = this.state.messages.find(
      (value) => value.id === messageId && value.mailboxId === mailboxId,
    );
    if (!item) throw new MailboxPilotError("not_found");
    const parsed = await this.mime.parse(Buffer.from(item.raw, "base64"));
    await this.tail;
    this.allow(actor, mailboxId, "read");
    return {
      id: item.id,
      threadId: item.threadId,
      folder: item.folder,
      receivedAt: item.receivedAt,
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      replyTo: parsed.replyTo,
      text: parsed.text,
      messageId: parsed.messageId,
      untrustedContent: true as const,
      attachments: parsed.attachments.map((attachment, index) => ({
        id: index,
        filename: attachment.filename,
        contentType: attachment.contentType,
        bytes: attachment.content.length,
        cid: attachment.cid,
        disposition: attachment.disposition,
      })),
    };
  }
  async attachment(actor: MailboxActor, mailboxId: string, messageId: string, index: number) {
    await this.read(actor, mailboxId, messageId);
    const item = this.state.messages.find(
      (value) => value.id === messageId && value.mailboxId === mailboxId,
    )!;
    const parsed = await this.mime.parse(Buffer.from(item.raw, "base64"));
    await this.tail;
    this.allow(actor, mailboxId, "read");
    if (!Number.isInteger(index) || index < 0 || !parsed.attachments[index])
      throw new MailboxPilotError("not_found");
    return parsed.attachments[index];
  }
  async drafts(actor: MailboxActor, mailboxId: string) {
    await this.tail;
    this.allow(actor, mailboxId, "read");
    const result = await Promise.all(
      this.state.drafts
        .filter((item) => item.mailboxId === mailboxId)
        .map(async ({ raw, ...item }) => {
          const mime = await this.mime.parse(Buffer.from(raw, "base64"));
          return {
            ...item,
            from: mime.from,
            to: mime.to,
            subject: mime.subject,
            attachments: mime.attachments.map((attachment) => ({
              filename: attachment.filename,
              contentType: attachment.contentType,
              bytes: attachment.content.length,
            })),
          };
        }),
    );
    await this.tail;
    this.allow(actor, mailboxId, "read");
    return result;
  }
  async reply(
    actor: MailboxActor,
    mailboxId: string,
    messageId: string,
    text: string,
    attachmentIds: number[] = [],
  ) {
    await this.tail;
    const box = this.allow(actor, mailboxId, "draft");
    this.allow(actor, mailboxId, "read");
    if (!text.trim() || Buffer.byteLength(text) > 32 * 1024 || attachmentIds.length > 10)
      throw new MailboxPilotError("invalid");
    const item = this.state.messages.find(
      (value) => value.id === messageId && value.mailboxId === mailboxId,
    );
    if (!item) throw new MailboxPilotError("not_found");
    const parsed = await this.mime.parse(Buffer.from(item.raw, "base64"));
    const attachments = attachmentIds.map((index) => {
      if (!Number.isInteger(index) || index < 0 || !parsed.attachments[index])
        throw new MailboxPilotError("not_found");
      return parsed.attachments[index];
    });
    const id = randomUUID();
    const messageIdOut = `<${id}@${address(box.address).split("@")[1]}>`;
    const raw = await this.mime.compose({
      from: address(box.address),
      to: address(parsed.replyTo || parsed.from),
      subject: /^re:/i.test(parsed.subject) ? parsed.subject : `Re: ${parsed.subject}`,
      text,
      messageId: messageIdOut,
      inReplyTo: parsed.messageId,
      references: [...new Set([...parsed.references, parsed.messageId])].filter(Boolean),
      attachments,
    });
    return this.change(async (state) => {
      this.allow(actor, mailboxId, "draft");
      this.allow(actor, mailboxId, "read");
      state.drafts.push({
        id,
        mailboxId,
        originalId: messageId,
        threadId: item.threadId,
        text,
        raw: raw.toString("base64"),
        status: "draft",
        createdBy: actor.principalId,
        createdAt: new Date().toISOString(),
      });
      return {
        id,
        status: "draft" as const,
        threadId: item.threadId,
        canSend: box.grants[actor.principalId]?.includes("send") ?? false,
      };
    });
  }
  /** Exercise MIME handoff only; an idempotent capture replaces SES in this pilot. */
  async send(
    actor: MailboxActor,
    mailboxId: string,
    draftId: string,
    transport: (input: { idempotencyKey: string; raw: Buffer }) => Promise<void>,
  ) {
    return this.change(async (state) => {
      this.allow(actor, mailboxId, "send");
      const draft = state.drafts.find(
        (item) => item.id === draftId && item.mailboxId === mailboxId,
      );
      if (!draft) throw new MailboxPilotError("not_found");
      if (draft.status === "sent") return { status: "sent" as const, duplicate: true };
      draft.status = "sent";
      state.messages.push({
        id: draft.id,
        mailboxId,
        sourceId: `sent:${draft.id}`,
        threadId: draft.threadId,
        receivedAt: new Date().toISOString(),
        folder: "sent",
        raw: draft.raw,
      });
      // Reject deterministic capacity failures before the capture/transport side effect.
      this.serialize(state);
      await transport({ idempotencyKey: draft.id, raw: Buffer.from(draft.raw, "base64") });
      return { status: "sent" as const, duplicate: false };
    });
  }
  async revoke(actor: MailboxActor, mailboxId: string, principalId: string) {
    return this.change(async (state) => {
      this.allow(actor, mailboxId, "manage");
      const box = state.mailboxes.find((item) => item.id === mailboxId)!;
      delete box.grants[principalId];
    });
  }
}
function address(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(normalized) || normalized.length > 254)
    throw new MailboxPilotError("invalid");
  return normalized;
}
function validateMime(value: PilotMime) {
  address(value.from);
  if (value.replyTo) address(value.replyTo);
  if (
    value.subject.length > 998 ||
    /[\r\n]/.test(value.subject) ||
    value.messageId.length > 998 ||
    value.references.length > 100 ||
    value.attachments.length > 10
  )
    throw new MailboxPilotError("invalid");
  if (value.attachments.some((item) => item.content.length > 256 * 1024))
    throw new MailboxPilotError("too_large");
}
