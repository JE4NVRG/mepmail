import { createHash } from "node:crypto";
import {
  acceptMailboxOutbox,
  BOUND_ENVELOPE_VERSION_OFFSET,
  decryptPayload,
  type Keyring,
  type MailboxOutboundEvidence,
  type MailboxTransportMimeAdapter,
  mailboxRecipientHash,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { mailboxMessageId } from "../../../packages/core/src/mailbox-message-id.js";
import {
  assertMailboxNotificationTopic,
  MailboxProviderEventError,
  mailboxProviderAddress,
  providerRecord,
  type TrustedMailboxNotification,
} from "./mailbox-receiver.js";
import type { SesFailover } from "./ses-failover.js";

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

/** Deliberately allowlisted provider facts. No diagnostic text, raw event,
 * address or subject leaves this boundary; hashes are scoped to the owning team.
 */
function outcomeEvidence(
  event: Record<string, unknown>,
  eventType: string,
  teamId: string,
  destination: string[],
  input: TrustedMailboxNotification,
): MailboxOutboundEvidence {
  let outcome: MailboxOutboundEvidence["outcome"];
  let section: Record<string, unknown> | null = null;
  let selected = destination;
  switch (eventType) {
    case "Send":
      outcome = "send";
      section = providerRecord(event.send);
      break;
    case "Delivery":
      outcome = "delivered";
      section = providerRecord(event.delivery);
      selected = recipients(section?.recipients);
      break;
    case "DeliveryDelay":
      outcome = "delayed";
      section = providerRecord(event.deliveryDelay);
      selected = recipients(
        Array.isArray(section?.delayedRecipients)
          ? section.delayedRecipients.map((value) => providerRecord(value)?.emailAddress)
          : null,
      );
      break;
    case "Bounce":
      section = providerRecord(event.bounce);
      if (
        section?.bounceType !== "Permanent" &&
        section?.bounceType !== "Transient" &&
        section?.bounceType !== "Undetermined"
      )
        throw new MailboxProviderEventError("evidence");
      // Undetermined is not a confirmed hard bounce and must not silently block.
      outcome =
        section.bounceType === "Permanent"
          ? "hard_bounce"
          : section.bounceType === "Transient"
            ? "soft_bounce"
            : "undetermined_bounce";
      selected = recipients(
        Array.isArray(section.bouncedRecipients)
          ? section.bouncedRecipients.map((value) => providerRecord(value)?.emailAddress)
          : null,
      );
      break;
    case "Complaint":
      outcome = "complaint";
      section = providerRecord(event.complaint);
      selected = recipients(
        Array.isArray(section?.complainedRecipients)
          ? section.complainedRecipients.map((value) => providerRecord(value)?.emailAddress)
          : null,
      );
      break;
    case "Reject":
      outcome = "rejected";
      section = providerRecord(event.reject);
      break;
    case "Rendering Failure":
      outcome = "rendering_failed";
      section = providerRecord(event.failure);
      break;
    default:
      throw new MailboxProviderEventError("evidence");
  }
  if (!section || selected.some((recipient) => !destination.includes(recipient)))
    throw new MailboxProviderEventError("evidence");
  const timestamp = section.timestamp ?? providerRecord(event.mail)?.timestamp;
  if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(timestamp))
    throw new MailboxProviderEventError("evidence");
  const occurredAt = new Date(timestamp);
  if (!Number.isFinite(occurredAt.getTime())) throw new MailboxProviderEventError("evidence");
  return {
    topicArn: input.topicArn,
    snsMessageId: input.snsMessageId,
    outcome,
    recipientHashes: selected.map((recipient) => mailboxRecipientHash(teamId, recipient)).sort(),
    approvedRecipientHashes: destination
      .map((recipient) => mailboxRecipientHash(teamId, recipient))
      .sort(),
    occurredAt,
  };
}

/** Authenticated provider facts, never a user/API command. Acceptance and
 * recipient outcomes commit atomically before ACK. No fact authorizes a resend.
 */
export function createMailboxEvidenceHandler(options: {
  db: Db;
  keys: Keyring;
  mime: MailboxTransportMimeAdapter;
  enabled: boolean;
  topics: readonly string[];
  /** A listed domain's mail may also report from the failover region it sent from. */
  failover?: SesFailover | undefined;
}) {
  const topics = [...options.topics];
  const failover = options.failover;
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
        domainName: schema.domains.name,
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
      (bound.region !== topic.region &&
        !(
          failover &&
          topic.region === failover.region &&
          failover.domains.has(bound.domainName)
        )) ||
      bound.outbox.recipientCount !== destination.length ||
      (bound.outbox.status === "accepted" && bound.outbox.providerMessageId !== messageId)
    )
      throw new MailboxProviderEventError("evidence");
    const outboundEvidence = outcomeEvidence(
      event,
      eventType,
      bound.outbox.teamId,
      destination,
      input,
    );
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
    const captured = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    const originalId = mailboxMessageId(captured.messageId);
    // headers contains the submitted headers, not SES's final Message-ID.
    // It can bind evidence to the captured revision but must never be an alias.
    if (Array.isArray(mail.headers)) {
      const originalHeaders = mail.headers
        .map(providerRecord)
        .filter(
          (header) =>
            typeof header?.name === "string" && header.name.toLowerCase() === "message-id",
        );
      if (
        originalHeaders.length > 1 ||
        (originalHeaders.length === 1 &&
          (!originalId || mailboxMessageId(originalHeaders[0]!.value) !== originalId))
      )
        throw new MailboxProviderEventError("evidence");
    }
    // Legacy notification commonHeaders is also original. Event publishing
    // reports the assigned ID, often bare; only an observed complete RFC value
    // distinct from the submitted ID can close the alias gap. No API derivation.
    const observedId =
      typeof event.eventType === "string"
        ? mailboxMessageId(providerRecord(mail.commonHeaders)?.messageId)
        : null;
    const rfcMessageId = observedId && observedId !== originalId ? observedId : undefined;
    await acceptMailboxOutbox(options.db, outboxId, {
      attemptId,
      messageId,
      ...(rfcMessageId ? { rfcMessageId } : {}),
      outboundEvidence,
    });
    return true;
  };
}
