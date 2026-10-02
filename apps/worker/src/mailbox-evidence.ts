import { createHash } from "node:crypto";
import {
  acceptMailboxOutbox,
  BOUND_ENVELOPE_VERSION_OFFSET,
  decryptPayload,
  type Keyring,
  type MailboxTransportMimeAdapter,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import {
  assertMailboxNotificationTopic,
  mailboxProviderAddress,
  MailboxProviderEventError,
  providerRecord,
  type TrustedMailboxNotification,
} from "./mailbox-receiver.js";

const OUTBOX_TAG = "mepmail_outbox_id";
const ATTEMPT_TAG = "mepmail_attempt_id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCEPTANCE_EVENTS = new Set([
  "Send",
  "Delivery",
  "DeliveryDelay",
  "Bounce",
  "Complaint",
  "Reject",
  "Rendering Failure",
]);

/** Fail closed even when the private tags are malformed: the existing Envio
 * parser must never persist private message metadata to public campaign events.
 */
export function isPrivateMailboxEvent(event: unknown): boolean {
  const tags = providerRecord(providerRecord(providerRecord(event)?.mail)?.tags);
  return !!tags && (Object.hasOwn(tags, OUTBOX_TAG) || Object.hasOwn(tags, ATTEMPT_TAG));
}

function uuidTag(tags: Record<string, unknown>, name: string) {
  const value = tags[name];
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    typeof value[0] !== "string" ||
    !UUID.test(value[0])
  )
    throw new MailboxProviderEventError("evidence");
  return value[0];
}

function recipients(values: unknown) {
  if (!Array.isArray(values) || !values.length || values.length > 20)
    throw new MailboxProviderEventError("evidence");
  const result = [...new Set(values.map(mailboxProviderAddress))].sort();
  if (result.length !== values.length) throw new MailboxProviderEventError("evidence");
  return result;
}

/** Authenticated provider fact, never a user/API command. Proves submission
 * acceptance only; it does not claim recipient delivery and never resends.
 */
export function createMailboxEvidenceHandler(options: {
  db: Db;
  keys: Keyring;
  mime: MailboxTransportMimeAdapter;
  enabled: boolean;
  topics: readonly string[];
}) {
  const topics = [...options.topics];
  return async (input: TrustedMailboxNotification): Promise<boolean> => {
    if (!isPrivateMailboxEvent(input.event)) return false;
    if (!options.enabled) throw new MailboxProviderEventError("disabled");
    const topic = assertMailboxNotificationTopic(input, topics);
    const event = providerRecord(input.event)!;
    const mail = providerRecord(event.mail)!;
    const tags = providerRecord(mail.tags)!;
    const eventType = event.eventType ?? event.notificationType;
    if (typeof eventType !== "string" || !ACCEPTANCE_EVENTS.has(eventType))
      throw new MailboxProviderEventError("evidence");
    const outboxId = uuidTag(tags, OUTBOX_TAG);
    const attemptId = uuidTag(tags, ATTEMPT_TAG);
    const messageId = mail.messageId;
    if (
      typeof messageId !== "string" ||
      !/^[\x21-\x7e]{1,512}$/.test(messageId) ||
      (mail.sendingAccountId !== undefined && mail.sendingAccountId !== topic.accountId)
    )
      throw new MailboxProviderEventError("evidence");
    const from = mailboxProviderAddress(mail.source);
    const destination = recipients(mail.destination);
    const [bound] = await options.db
      .select({
        outbox: schema.mailboxOutbox,
        address: schema.mailboxes.address,
        region: schema.domains.region,
      })
      .from(schema.mailboxOutbox)
      .innerJoin(
        schema.mailboxes,
        and(
          eq(schema.mailboxes.id, schema.mailboxOutbox.mailboxId),
          eq(schema.mailboxes.teamId, schema.mailboxOutbox.teamId),
        ),
      )
      .innerJoin(
        schema.domains,
        and(
          eq(schema.domains.id, schema.mailboxes.domainId),
          eq(schema.domains.teamId, schema.mailboxOutbox.teamId),
        ),
      )
      .where(eq(schema.mailboxOutbox.id, outboxId));
    if (
      !bound ||
      bound.outbox.attemptId !== attemptId ||
      !["sending", "unknown", "accepted"].includes(bound.outbox.status) ||
      bound.address !== from ||
      bound.region !== topic.region ||
      bound.outbox.recipientCount !== destination.length ||
      (bound.outbox.status === "accepted" && bound.outbox.providerMessageId !== messageId)
    )
      throw new MailboxProviderEventError("evidence");
    let envelope = {
      ciphertext: bound.outbox.ciphertext,
      iv: bound.outbox.iv,
      wrappedDek: bound.outbox.wrappedDek,
      keyVersion: bound.outbox.keyVersion,
    };
    if (bound.outbox.status === "accepted") {
      const [sent] = await options.db
        .select()
        .from(schema.mailboxItems)
        .where(
          and(
            eq(schema.mailboxItems.id, outboxId),
            eq(schema.mailboxItems.mailboxId, bound.outbox.mailboxId),
            eq(schema.mailboxItems.teamId, bound.outbox.teamId),
            eq(schema.mailboxItems.kind, "sent"),
            eq(schema.mailboxItems.sourceId, `sent:${outboxId}`),
          ),
        );
      if (!sent) throw new MailboxProviderEventError("evidence");
      envelope = sent;
    }
    if (
      !envelope.ciphertext ||
      !envelope.iv ||
      !envelope.wrappedDek ||
      !envelope.keyVersion ||
      envelope.keyVersion < BOUND_ENVELOPE_VERSION_OFFSET
    )
      throw new MailboxProviderEventError("evidence");
    const raw = await decryptPayload(
      {
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        wrappedDek: envelope.wrappedDek,
        keyVersion: envelope.keyVersion,
      },
      options.keys,
      {
        teamId: bound.outbox.teamId,
        rowId: `mailbox-private-v1:${bound.outbox.mailboxId}:${outboxId}`,
        kind: "email_body",
      },
    );
    if (
      raw.length !== bound.outbox.rawBytes ||
      createHash("sha256").update(raw).digest("hex") !== bound.outbox.rawSha256
    )
      throw new MailboxProviderEventError("evidence");
    const parsed = await options.mime.parse(raw);
    const expected = [
      ...new Set(
        [...parsed.to, ...(parsed.cc ?? []), ...(parsed.bcc ?? [])].map(mailboxProviderAddress),
      ),
    ].sort();
    if (
      mailboxProviderAddress(parsed.from) !== from ||
      JSON.stringify(expected) !== JSON.stringify(destination)
    )
      throw new MailboxProviderEventError("evidence");
    await acceptMailboxOutbox(options.db, outboxId, { attemptId, messageId });
    return true;
  };
}
