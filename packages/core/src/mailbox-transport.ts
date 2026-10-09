import { createHash, randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import {
  type MailboxOutboundOutcome,
  mailboxOutboundEvents,
  mailboxOutboundOutcomes,
  mailboxOutbox,
  mailboxRecipientBlocks,
} from "../../db/src/schema/mailbox-transport.js";
import {
  BOUND_ENVELOPE_VERSION_OFFSET,
  decryptPayload,
  encryptPayload,
} from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import { appendMailboxActivity } from "./mailbox-activity.js";
import {
  MailboxAgentAccessError,
  type MailboxAgentCredential,
  type MailboxSelector,
  withMailboxAgentAccess,
  withMailboxAgentQueuedSendAccess,
} from "./mailbox-agent-access.js";
import {
  type MailboxInboundAssessment,
  validateMailboxInboundAssessment,
} from "./mailbox-inbound-safety.js";
import { mailboxMessageId } from "./mailbox-message-id.js";
import {
  type MailboxContentActor,
  MailboxContentError,
  withMailboxWriteAccess,
} from "./mailbox-private-store.js";
import {
  assertMailboxStorage,
  lockMailboxService,
  MailboxServiceError,
  mailboxSubscriptionUsagePeriod,
  requireMailboxSeat,
} from "./mailbox-service.js";
import { mailboxProviderThreadKeys, mailboxThreadKeys } from "./mailbox-thread.js";
import { parseMailbox } from "./sender-address.js";
import { hashRecipient } from "./suppressions.js";

export interface MailboxTransportMimeAdapter {
  /** Trusted MIME parser; implementation belongs to the runtime with mailparser.
   * It must reject ambiguous/multiple From headers and returns decoded addr-specs,
   * never client-supplied routing metadata.
   */
  parse(raw: Buffer): Promise<{
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    attachmentBytes: number[];
  }>;
}

export interface MailboxOutboxSender {
  /** One provider attempt, with SDK automatic retries disabled. A stable key
   * correlates provider events; it does not imply provider-side deduplication.
   */
  send(input: {
    idempotencyKey: string;
    outboxId: string;
    attemptId: string;
    teamId: string;
    mailboxId: string;
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    raw: Buffer;
  }): Promise<{ messageId: string }>;
}

/** An adapter may throw this only when the provider definitely refused delivery.
 * Timeouts, disconnects, 5xx and missing acknowledgements are always ambiguous.
 */
export class MailboxSendRejectedError extends Error {
  constructor() {
    super("mailbox_provider_rejected");
  }
}
/** Trusted adapter preflight only: no provider.send has been invoked yet.
 * This must never wrap a provider timeout, disconnect, 5xx or lost response.
 */
export class MailboxSendDeferredError extends Error {
  constructor() {
    super("mailbox_provider_preflight_deferred");
  }
}
class MailboxReservationExpiredError extends MailboxServiceError {
  constructor() {
    super("not_entitled");
  }
}

type Outbox = typeof mailboxOutbox.$inferSelect;

export type { MailboxOutboundOutcome };

/** Internal trusted SNS boundary, never a client/API payload. The worker must
 * authenticate the topic, tags, provider attempt and approved MIME recipients.
 */
export interface MailboxOutboundEvidence {
  topicArn: string;
  snsMessageId: string;
  outcome: MailboxOutboundOutcome;
  recipientHashes: readonly string[];
  approvedRecipientHashes: readonly string[];
  occurredAt: Date;
}

export interface MailboxOutboundSummary {
  totalRecipients: number;
  delivered: number;
  delayed: number;
  hardBounce: number;
  complaint: number;
  softBounce: number;
  rejected: number;
  renderingFailed: number;
  unconfirmed: number;
  lastObservedAt: Date | null;
}

const OUTCOMES = new Set<MailboxOutboundOutcome>([
  "send",
  "delivered",
  "delayed",
  "soft_bounce",
  "undetermined_bounce",
  "hard_bounce",
  "complaint",
  "rejected",
  "rendering_failed",
]);
const MAX_MIME_BYTES = 1024 * 1024;
const MAX_RECIPIENTS = 20;
const MAX_ATTACHMENT_BYTES = 256 * 1024;

function hasAsciiControl(value: string, includeSpace = false) {
  const limit = includeSpace ? 32 : 31;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= limit || code === 127) return true;
  }
  return false;
}

function copyRaw(value: Buffer) {
  if (!Buffer.isBuffer(value) || !value.length || value.length > MAX_MIME_BYTES)
    throw new MailboxContentError("invalid");
  return Buffer.from(value);
}
function hash(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}
function addr(value: string) {
  const parsed = typeof value === "string" ? parseMailbox(value) : null;
  if (!parsed || parsed.name || !/^[\x21-\x7e]+$/.test(parsed.address))
    throw new MailboxContentError("invalid");
  return parsed.address.toLowerCase();
}

/** Private domain separation avoids correlating a recipient across teams or
 * with Envio's public suppression hash. Only canonical bare addresses enter.
 */
export function mailboxRecipientHash(teamId: string, address: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(teamId))
    throw new MailboxContentError("invalid");
  return hash(
    `mepmail-private-recipient-v1\0${teamId.toLowerCase()}\0${hashRecipient(addr(address))}`,
  );
}

function checkedHashes(values: readonly string[]): string[] {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > MAX_RECIPIENTS ||
    values.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
  )
    throw new MailboxContentError("invalid");
  const sorted = [...new Set(values)].sort();
  if (sorted.length !== values.length) throw new MailboxContentError("invalid");
  return sorted;
}

function approvedHashes(teamId: string, recipients: readonly string[], count: number) {
  const hashes = checkedHashes(
    recipients.map((recipient) => mailboxRecipientHash(teamId, recipient)),
  );
  if (hashes.length !== count) throw new MailboxContentError("invalid");
  return hashes;
}

/** Admission/pre-provider check only. A database failure throws so callers can
 * defer before the provider call; it must never imply permission to send.
 */
export async function checkMailboxRecipientBlocks(
  db: Db,
  input: { teamId: string; recipients: readonly string[] },
): Promise<boolean> {
  const teamId = input.teamId;
  const recipients = [...input.recipients];
  if (!recipients.length || recipients.length > MAX_RECIPIENTS)
    throw new MailboxContentError("invalid");
  const hashes = [
    ...new Set(recipients.map((recipient) => mailboxRecipientHash(teamId, recipient))),
  ];
  const [blocked] = await db
    .select({ recipientHash: mailboxRecipientBlocks.recipientHash })
    .from(mailboxRecipientBlocks)
    .where(
      and(
        eq(mailboxRecipientBlocks.teamId, teamId),
        inArray(mailboxRecipientBlocks.recipientHash, hashes),
      ),
    )
    .limit(1);
  return !blocked;
}

function copyOutboundEvidence(value: MailboxOutboundEvidence): MailboxOutboundEvidence {
  if (
    !/^arn:aws(?:-[a-z]+)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(value.topicArn) ||
    !/^[\x21-\x7e]{1,128}$/.test(value.snsMessageId) ||
    !OUTCOMES.has(value.outcome) ||
    !(value.occurredAt instanceof Date) ||
    !Number.isFinite(value.occurredAt.getTime())
  )
    throw new MailboxContentError("invalid");
  const approved = checkedHashes(value.approvedRecipientHashes);
  const recipients = checkedHashes(value.recipientHashes);
  if (recipients.some((recipient) => !approved.includes(recipient)))
    throw new MailboxContentError("conflict");
  return {
    ...value,
    recipientHashes: recipients,
    approvedRecipientHashes: approved,
    occurredAt: new Date(value.occurredAt),
  };
}

/** Runs under acceptMailboxOutbox's outbox lock/transaction. No subscription or
 * credential check: an already-established external fact remains recordable.
 */
async function recordOutboundEvidence(
  tx: Db,
  row: Outbox,
  messageId: string,
  evidence: MailboxOutboundEvidence,
  now: Date,
) {
  if (
    row.recipientCount !== evidence.approvedRecipientHashes.length ||
    (row.recipientHashes !== null &&
      JSON.stringify(checkedHashes(row.recipientHashes)) !==
        JSON.stringify(evidence.approvedRecipientHashes))
  )
    throw new MailboxContentError("conflict");
  if (row.recipientHashes === null) {
    await tx
      .update(mailboxOutbox)
      .set({ recipientHashes: [...evidence.approvedRecipientHashes] })
      .where(eq(mailboxOutbox.id, row.id));
  }
  const id = hash(`mepmail-private-sns-v1\0${evidence.topicArn}\0${evidence.snsMessageId}`);
  const fingerprint = hash(
    JSON.stringify([
      row.id,
      row.teamId,
      row.mailboxId,
      row.attemptId,
      messageId,
      evidence.outcome,
      evidence.approvedRecipientHashes,
      evidence.recipientHashes,
      evidence.occurredAt.toISOString(),
    ]),
  );
  const [inserted] = await tx
    .insert(mailboxOutboundEvents)
    .values({
      id,
      outboxId: row.id,
      attemptId: row.attemptId!,
      providerMessageId: messageId,
      fingerprint,
      outcome: evidence.outcome,
      occurredAt: evidence.occurredAt,
      receivedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: mailboxOutboundEvents.id });
  if (!inserted) {
    const [previous] = await tx
      .select()
      .from(mailboxOutboundEvents)
      .where(eq(mailboxOutboundEvents.id, id));
    if (
      !previous ||
      previous.fingerprint !== fingerprint ||
      previous.outboxId !== row.id ||
      previous.attemptId !== row.attemptId ||
      previous.providerMessageId !== messageId
    )
      throw new MailboxContentError("conflict");
    return;
  }
  await tx
    .insert(mailboxOutboundOutcomes)
    .values(evidence.recipientHashes.map((recipientHash) => ({ eventId: id, recipientHash })));
  if (evidence.outcome === "hard_bounce" || evidence.outcome === "complaint") {
    for (const recipientHash of evidence.recipientHashes) {
      await tx
        .insert(mailboxRecipientBlocks)
        .values({
          teamId: row.teamId,
          recipientHash,
          reason: evidence.outcome,
          sourceEventId: id,
          blockedAt: now,
        })
        .onConflictDoUpdate({
          target: [mailboxRecipientBlocks.teamId, mailboxRecipientBlocks.recipientHash],
          // A later replay/Delivery never clears a block; Complaint takes precedence.
          set: { reason: evidence.outcome, sourceEventId: id },
          setWhere: eq(mailboxRecipientBlocks.reason, "hard_bounce"),
        });
    }
  }
}

/** Scoped private DTO for an already-authorized caller. Eight disjoint counts
 * sum to the captured recipient count. Missing/legacy evidence is unconfirmed.
 * Delivery supersedes a delayed/soft-bounce fact independent of arrival order;
 * complaints/hard bounces remain sticky and never turn into "all delivered".
 */
export async function getMailboxOutboundSummary(
  db: Db,
  input: { teamId: string; mailboxId: string; outboxId: string },
): Promise<MailboxOutboundSummary | null> {
  const scope = { ...input };
  const [row] = await db
    .select()
    .from(mailboxOutbox)
    .where(
      and(
        eq(mailboxOutbox.id, scope.outboxId),
        eq(mailboxOutbox.teamId, scope.teamId),
        eq(mailboxOutbox.mailboxId, scope.mailboxId),
      ),
    );
  if (!row) return null;
  const summary: MailboxOutboundSummary = {
    totalRecipients: row.recipientCount,
    delivered: 0,
    delayed: 0,
    hardBounce: 0,
    complaint: 0,
    softBounce: 0,
    rejected: 0,
    renderingFailed: 0,
    unconfirmed: row.recipientCount,
    lastObservedAt: null,
  };
  if (!row.recipientHashes || !row.attemptId) return summary;
  const approved = checkedHashes(row.recipientHashes);
  const facts = await db
    .select({
      recipientHash: mailboxOutboundOutcomes.recipientHash,
      outcome: mailboxOutboundEvents.outcome,
      receivedAt: mailboxOutboundEvents.receivedAt,
    })
    .from(mailboxOutboundEvents)
    .innerJoin(
      mailboxOutboundOutcomes,
      eq(mailboxOutboundOutcomes.eventId, mailboxOutboundEvents.id),
    )
    .where(
      and(
        eq(mailboxOutboundEvents.outboxId, row.id),
        eq(mailboxOutboundEvents.attemptId, row.attemptId),
      ),
    );
  const states = new Map<string, Set<MailboxOutboundOutcome>>();
  for (const fact of facts) {
    if (!approved.includes(fact.recipientHash)) throw new MailboxContentError("conflict");
    const state = states.get(fact.recipientHash) ?? new Set<MailboxOutboundOutcome>();
    state.add(fact.outcome);
    states.set(fact.recipientHash, state);
    if (!summary.lastObservedAt || fact.receivedAt > summary.lastObservedAt)
      summary.lastObservedAt = fact.receivedAt;
  }
  for (const state of states.values()) {
    const category = state.has("complaint")
      ? "complaint"
      : state.has("hard_bounce")
        ? "hardBounce"
        : state.has("rejected")
          ? "rejected"
          : state.has("rendering_failed")
            ? "renderingFailed"
            : state.has("delivered")
              ? "delivered"
              : state.has("soft_bounce")
                ? "softBounce"
                : state.has("delayed")
                  ? "delayed"
                  : null;
    if (category) {
      summary[category]++;
      summary.unconfirmed--;
    }
  }
  return summary;
}
function binding(row: { teamId: string; mailboxId: string; id: string }) {
  return {
    teamId: row.teamId,
    rowId: `mailbox-private-v1:${row.mailboxId}:${row.id}`,
    kind: "email_body" as const,
  };
}
async function open(
  row: {
    teamId: string;
    mailboxId: string;
    id: string;
    ciphertext: Buffer | null;
    iv: Buffer | null;
    wrappedDek: Buffer | null;
    keyVersion: number | null;
    rawBytes: number;
  },
  keys: Keyring,
) {
  if (
    !row.ciphertext ||
    !row.iv ||
    !row.wrappedDek ||
    !row.keyVersion ||
    row.keyVersion < BOUND_ENVELOPE_VERSION_OFFSET
  )
    throw new MailboxContentError("invalid");
  const raw = await decryptPayload(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      wrappedDek: row.wrappedDek,
      keyVersion: row.keyVersion,
    },
    keys,
    binding(row),
  );
  if (raw.length !== row.rawBytes || raw.length > MAX_MIME_BYTES)
    throw new MailboxContentError("invalid");
  return raw;
}
async function envelope(adapter: MailboxTransportMimeAdapter, raw: Buffer, outbound: boolean) {
  const parsed = await adapter.parse(Buffer.from(raw));
  if (
    !Array.isArray(parsed.attachmentBytes) ||
    parsed.attachmentBytes.length > 10 ||
    parsed.attachmentBytes.some(
      (n) => !Number.isSafeInteger(n) || n < 0 || n > MAX_ATTACHMENT_BYTES,
    )
  )
    throw new MailboxContentError("invalid");
  const from = addr(parsed.from);
  const to = [...new Set(parsed.to.map(addr))];
  const cc = [...new Set((parsed.cc ?? []).map(addr))].filter((a) => !to.includes(a));
  const bcc = [...new Set((parsed.bcc ?? []).map(addr))].filter(
    (a) => !to.includes(a) && !cc.includes(a),
  );
  const count = to.length + cc.length + bcc.length;
  // The pilot composer has no Bcc contract. Passing a raw Bcc header through
  // could expose hidden recipients, so require explicit future stripping support.
  if (outbound && (!to.length || count > MAX_RECIPIENTS || bcc.length))
    throw new MailboxContentError("invalid");
  return { from, to, cc, bcc, count };
}
function outboxDto(row: Outbox, duplicate: boolean) {
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    draftId: row.draftId,
    draftRevision: row.draftRevision,
    status: row.status,
    recipientCount: row.recipientCount,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    createdAt: row.createdAt,
    attemptedAt: row.attemptedAt,
    acceptedAt: row.acceptedAt,
    errorCode: row.errorCode,
    duplicate,
  };
}

/** Internal ingress adapter contract. No browser actor, API key or forged owner
 * identity is accepted here. The runtime must authenticate the upstream transport.
 * RCPT TO selects boxes; visible MIME To, Message-ID and body never select a team.
 */
export async function receiveMailboxMime(
  db: Db,
  keys: Keyring,
  input: {
    sourceId: string;
    recipients: string[];
    raw: Buffer;
    assessment?: MailboxInboundAssessment;
  },
  mime: MailboxTransportMimeAdapter,
  now = new Date(),
) {
  input = { ...input, recipients: [...input.recipients], raw: copyRaw(input.raw) };
  const assessment =
    input.assessment === undefined ? null : validateMailboxInboundAssessment(input.assessment);
  if (
    typeof input.sourceId !== "string" ||
    !input.sourceId ||
    input.sourceId.length > 512 ||
    hasAsciiControl(input.sourceId)
  )
    throw new MailboxContentError("invalid");
  const recipients = [...new Set(input.recipients.map(addr))].sort();
  if (!recipients.length || recipients.length > MAX_RECIPIENTS)
    throw new MailboxContentError("invalid");
  // Unsafe bytes are durably sealed without parsing or exposing their content.
  if (assessment?.decision !== "quarantine") await envelope(mime, input.raw, false);
  const sourceId = `ingress:${hash(input.sourceId)}`;
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // Each RCPT resolves to one mailbox, by its own address or by an alias of it;
    // a mailbox reached through several of them receives the message once.
    const direct = await tx
      .select({ id: schema.mailboxes.id, address: schema.mailboxes.address })
      .from(schema.mailboxes)
      .where(inArray(schema.mailboxes.address, recipients));
    const aliased = await tx
      .select({
        mailboxId: schema.mailboxAliases.mailboxId,
        address: schema.mailboxAliases.address,
      })
      .from(schema.mailboxAliases)
      .where(inArray(schema.mailboxAliases.address, recipients));
    const resolved = new Map<string, string>(direct.map((box) => [box.address, box.id]));
    for (const alias of aliased)
      if (!resolved.has(alias.address)) resolved.set(alias.address, alias.mailboxId);
    if (resolved.size !== recipients.length) throw new MailboxContentError("not_found");
    const targets = [...new Set(resolved.values())];
    const boxes = await tx
      .select({
        id: schema.mailboxes.id,
        teamId: schema.mailboxes.teamId,
        address: schema.mailboxes.address,
      })
      .from(schema.mailboxes)
      .where(inArray(schema.mailboxes.id, targets))
      .orderBy(asc(schema.mailboxes.teamId), asc(schema.mailboxes.id));
    if (boxes.length !== targets.length) throw new MailboxContentError("not_found");
    // No membership is needed for trusted ingress. Lock subscriptions by team
    // before any box so cross-team fanout cannot reverse the mutation order.
    const plans = new Map<string, Awaited<ReturnType<typeof lockMailboxService>>>();
    for (const teamId of [...new Set(boxes.map((b) => b.teamId))].sort())
      plans.set(teamId, await lockMailboxService(tx, teamId, now));
    const items: { id: string; mailboxId: string; duplicate: boolean }[] = [];
    for (const box of boxes) {
      const plan = plans.get(box.teamId)!;
      await requireMailboxSeat(tx, box.teamId, box.id, plan);
      const [current] = await tx
        .select()
        .from(schema.mailboxes)
        .where(and(eq(schema.mailboxes.id, box.id), eq(schema.mailboxes.teamId, box.teamId)))
        .for("update");
      if (!current || current.status !== "planned" || current.address !== box.address)
        throw new MailboxContentError("forbidden");
      const [domain] = await tx
        .select({ status: schema.domains.status })
        .from(schema.domains)
        .where(
          and(eq(schema.domains.id, current.domainId), eq(schema.domains.teamId, current.teamId)),
        )
        .for("share");
      if (domain?.status !== "verified") throw new MailboxContentError("forbidden");
      const [previous] = await tx
        .select()
        .from(schema.mailboxItems)
        .where(
          and(
            eq(schema.mailboxItems.mailboxId, box.id),
            eq(schema.mailboxItems.teamId, box.teamId),
            eq(schema.mailboxItems.sourceId, sourceId),
          ),
        );
      if (previous) {
        if (!(await open(previous, keys)).equals(input.raw))
          throw new MailboxContentError("conflict");
        if (
          JSON.stringify(
            previous.inboundAssessment === null
              ? null
              : validateMailboxInboundAssessment(previous.inboundAssessment),
          ) !== JSON.stringify(assessment)
        )
          throw new MailboxContentError("conflict");
        items.push({ id: previous.id, mailboxId: box.id, duplicate: true });
        continue;
      }
      await assertMailboxStorage(tx, box.teamId, box.id, input.raw.length, plan);
      const id = randomUUID();
      const sealed = await encryptPayload(
        input.raw,
        keys,
        binding({ teamId: box.teamId, mailboxId: box.id, id }),
      );
      await tx.insert(schema.mailboxItems).values({
        id,
        teamId: box.teamId,
        mailboxId: box.id,
        kind: "inbox",
        deliveryFolder: assessment?.decision ?? "inbox",
        inboundAssessment: assessment,
        sourceId,
        rawBytes: input.raw.length,
        ...mailboxThreadKeys(input.raw),
        ...sealed,
      });
      items.push({ id, mailboxId: box.id, duplicate: false });
    }
    return { items };
  });
}

/** Owner approval freezes one exact private revision. Recipient reservations
 * belong to Correio's box/period, independent of every Envio quota or API key.
 * Admission commits before a runtime enqueues the returned outbox ID.
 */
export async function queueMailboxDraft(
  db: Db,
  keys: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number },
  mime: MailboxTransportMimeAdapter,
  now = new Date(),
) {
  actor = { ...actor };
  input = { ...input };
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new MailboxContentError("invalid");
  return withMailboxWriteAccess(db, actor, input.mailboxId, (tx) =>
    queueAuthorizedMailboxDraft(tx, keys, actor, input, mime, now, {
      kind: "human",
      agentKeyId: null,
    }),
  );
}

/** Authenticate the exact agent approval at capture. An external caller can choose only
 * the draft revision; mailbox, owner, membership and credential come from the bearer.
 */
export async function queueMailboxAgentDraft(
  db: Db,
  keys: Keyring,
  token: MailboxAgentCredential,
  input: { id: string; expectedRevision: number },
  mime: MailboxTransportMimeAdapter,
  now = new Date(),
  /** The mailbox a team credential sends from (id or address); see withMailboxAgentAccess. */
  mailbox: MailboxSelector | null = null,
) {
  input = { ...input };
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new MailboxContentError("invalid");
  return withMailboxAgentAccess(
    db,
    token,
    "send",
    (context) =>
      queueAuthorizedMailboxDraft(
        context.db,
        keys,
        context.actor,
        { ...input, mailboxId: context.mailboxId },
        mime,
        now,
        {
          kind: "agent",
          agentKeyId: context.keyId,
          ownerMembershipId: context.ownerMembershipId,
          expiresAt: context.expiresAt,
        },
      ),
    mailbox,
  );
}

/** Shared snapshot/reservation capture runs only inside the caller's authorization locks. */
async function queueAuthorizedMailboxDraft(
  tx: Db,
  keys: Keyring,
  actor: { teamId: string; userId: string },
  input: { mailboxId: string; id: string; expectedRevision: number },
  mime: MailboxTransportMimeAdapter,
  now: Date,
  approval:
    | { kind: "human"; agentKeyId: null }
    | { kind: "agent"; agentKeyId: string; ownerMembershipId: string; expiresAt: Date | null },
) {
  const [box] = await tx
    .select()
    .from(schema.mailboxes)
    .where(
      and(eq(schema.mailboxes.id, input.mailboxId), eq(schema.mailboxes.teamId, actor.teamId)),
    );
  if (
    !box ||
    !box.ownerMembershipId ||
    box.ownerUserId !== actor.userId ||
    (approval.kind === "agent" && box.ownerMembershipId !== approval.ownerMembershipId)
  )
    throw new MailboxContentError("forbidden");
  const [previous] = await tx
    .select()
    .from(mailboxOutbox)
    .where(
      and(
        eq(mailboxOutbox.mailboxId, input.mailboxId),
        eq(mailboxOutbox.teamId, actor.teamId),
        eq(mailboxOutbox.draftId, input.id),
        eq(mailboxOutbox.draftRevision, input.expectedRevision),
      ),
    )
    .for("update");
  if (previous) {
    if (
      previous.approvalKind !== approval.kind ||
      previous.agentKeyId !== approval.agentKeyId ||
      previous.approvedBy !== actor.userId ||
      previous.approvedMembershipId !== box.ownerMembershipId
    )
      throw new MailboxContentError("conflict");
    return outboxDto(previous, true);
  }
  const [draft] = await tx
    .select()
    .from(schema.mailboxItems)
    .where(
      and(
        eq(schema.mailboxItems.id, input.id),
        eq(schema.mailboxItems.mailboxId, input.mailboxId),
        eq(schema.mailboxItems.teamId, actor.teamId),
      ),
    )
    .for("update");
  if (!draft) throw new MailboxContentError("not_found");
  if (
    draft.kind !== "draft" ||
    draft.revision !== input.expectedRevision ||
    draft.trashedAt !== null
  )
    throw new MailboxContentError("conflict");
  const [domain] = await tx
    .select({ status: schema.domains.status })
    .from(schema.domains)
    .where(and(eq(schema.domains.id, box!.domainId), eq(schema.domains.teamId, actor.teamId)))
    .for("share");
  if (domain?.status !== "verified") throw new MailboxContentError("forbidden");
  const raw = await open(draft, keys);
  const parsed = await envelope(mime, raw, true);
  if (parsed.from !== box!.address) throw new MailboxContentError("invalid");
  const recipients = [...parsed.to, ...parsed.cc, ...parsed.bcc];
  const recipientHashes = approvedHashes(actor.teamId, recipients, parsed.count);
  if (!(await checkMailboxRecipientBlocks(tx, { teamId: actor.teamId, recipients })))
    throw new MailboxContentError("forbidden");
  const plan = await lockMailboxService(tx, actor.teamId, now);
  if (!plan.unlimitedOutbound) {
    const [usage] = await tx
      .select({ recipients: sql<string>`coalesce(sum(${mailboxOutbox.recipientCount}),0)::text` })
      .from(mailboxOutbox)
      .where(
        and(
          eq(mailboxOutbox.mailboxId, input.mailboxId),
          eq(mailboxOutbox.teamId, actor.teamId),
          eq(mailboxOutbox.periodStart, plan.usagePeriod.start),
          ne(mailboxOutbox.status, "failed"),
        ),
      );
    if (
      BigInt(usage?.recipients ?? "0") + BigInt(parsed.count) >
      BigInt(plan.includedOutboundPerMailbox)
    )
      throw new MailboxServiceError("quota");
  }
  await assertMailboxStorage(tx, actor.teamId, input.mailboxId, raw.length, plan);
  const id = randomUUID();
  const sealed = await encryptPayload(
    raw,
    keys,
    binding({ teamId: actor.teamId, mailboxId: input.mailboxId, id }),
  );
  if (approval.kind === "agent" && approval.expiresAt && approval.expiresAt.getTime() <= Date.now())
    throw new MailboxAgentAccessError("forbidden");
  const [row] = await tx
    .insert(mailboxOutbox)
    .values({
      id,
      teamId: actor.teamId,
      mailboxId: input.mailboxId,
      draftId: draft.id,
      draftRevision: draft.revision,
      approvedBy: actor.userId,
      approvedMembershipId: box.ownerMembershipId,
      approvalKind: approval.kind,
      agentKeyId: approval.agentKeyId,
      recipientCount: parsed.count,
      recipientHashes,
      periodStart: plan.usagePeriod.start,
      periodEnd: plan.usagePeriod.end,
      rawBytes: raw.length,
      rawSha256: hash(raw),
      ...mailboxThreadKeys(raw),
      ...sealed,
    })
    .returning();
  await appendMailboxActivity(
    tx,
    {
      teamId: actor.teamId,
      mailboxId: input.mailboxId,
      actor:
        approval.kind === "agent"
          ? { kind: "mailbox_agent", keyId: approval.agentKeyId }
          : { kind: "user", userId: actor.userId },
    },
    {
      action: "mailbox.send_approved",
      itemId: draft.id,
      revision: draft.revision,
      outboxId: row!.id,
    },
  );
  return outboxDto(row!, false);
}

/** Called only by authenticated provider evidence or the single-attempt worker.
 * An ambiguous attempt can be resolved later; it is never resent automatically.
 */
export async function acceptMailboxOutbox(
  db: Db,
  outboxId: string,
  evidence: {
    attemptId: string;
    messageId: string;
    rfcMessageId?: string;
    outboundEvidence?: MailboxOutboundEvidence;
    now?: Date;
  },
) {
  evidence = {
    ...evidence,
    ...(evidence.outboundEvidence
      ? { outboundEvidence: copyOutboundEvidence(evidence.outboundEvidence) }
      : {}),
    ...(evidence.now ? { now: new Date(evidence.now) } : {}),
  };
  if (
    !evidence.messageId ||
    evidence.messageId.length > 512 ||
    hasAsciiControl(evidence.messageId, true)
  )
    throw new MailboxContentError("invalid");
  const rfcMessageId =
    evidence.rfcMessageId === undefined ? null : mailboxMessageId(evidence.rfcMessageId);
  if (evidence.rfcMessageId !== undefined && !rfcMessageId)
    throw new MailboxContentError("invalid");
  const now = evidence.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new MailboxContentError("invalid");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [known] = await tx.select().from(mailboxOutbox).where(eq(mailboxOutbox.id, outboxId));
    if (!known) throw new MailboxContentError("not_found");
    // Final bookkeeping records an already-established external fact. It must
    // remain possible after subscription expiry, suspension or role changes.
    await tx
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(
        and(eq(schema.mailboxes.id, known.mailboxId), eq(schema.mailboxes.teamId, known.teamId)),
      )
      .for("update");
    const [row] = await tx
      .select()
      .from(mailboxOutbox)
      .where(eq(mailboxOutbox.id, outboxId))
      .for("update");
    if (row!.attemptId !== evidence.attemptId) throw new MailboxContentError("conflict");
    if (rfcMessageId) {
      if (row!.providerRfcMessageId && row!.providerRfcMessageId !== rfcMessageId)
        throw new MailboxContentError("conflict");
      const [collision] = await tx
        .select({ id: mailboxOutbox.id })
        .from(mailboxOutbox)
        .where(
          and(
            eq(mailboxOutbox.mailboxId, row!.mailboxId),
            eq(mailboxOutbox.teamId, row!.teamId),
            eq(mailboxOutbox.providerRfcMessageId, rfcMessageId),
            ne(mailboxOutbox.id, row!.id),
          ),
        );
      if (collision) throw new MailboxContentError("conflict");
    }
    if (row!.status === "accepted") {
      if (row!.providerMessageId !== evidence.messageId) throw new MailboxContentError("conflict");
      // A worker acknowledgement may arrive before a complete RFC header is
      // observed. Enrich metadata only; preserve MIME, acceptance and no-replay.
      if (rfcMessageId && !row!.providerRfcMessageId) {
        const keys = mailboxProviderThreadKeys(
          { messageKey: row!.messageKey, threadKey: row!.threadKey },
          rfcMessageId,
        );
        await tx
          .update(mailboxOutbox)
          .set({ providerRfcMessageId: rfcMessageId, ...keys, updatedAt: now })
          .where(eq(mailboxOutbox.id, row!.id));
        // Replies quote the provider's ID: keep the sent copy in their conversation.
        await tx
          .update(schema.mailboxItems)
          .set(keys)
          .where(
            and(
              eq(schema.mailboxItems.id, row!.id),
              eq(schema.mailboxItems.mailboxId, row!.mailboxId),
              eq(schema.mailboxItems.teamId, row!.teamId),
            ),
          );
      }
      if (evidence.outboundEvidence)
        await recordOutboundEvidence(tx, row!, evidence.messageId, evidence.outboundEvidence, now);
      return outboxDto(row!, true);
    }
    if (
      !["sending", "unknown"].includes(row!.status) ||
      !row!.ciphertext ||
      !row!.iv ||
      !row!.wrappedDek ||
      !row!.keyVersion
    )
      throw new MailboxContentError("conflict");
    const sentKeys = rfcMessageId
      ? mailboxProviderThreadKeys(
          { messageKey: row!.messageKey, threadKey: row!.threadKey },
          rfcMessageId,
        )
      : { messageKey: row!.messageKey, threadKey: row!.threadKey };
    await tx.insert(schema.mailboxItems).values({
      id: row!.id,
      teamId: row!.teamId,
      mailboxId: row!.mailboxId,
      kind: "sent",
      sourceId: `sent:${row!.id}`,
      ...sentKeys,
      rawBytes: row!.rawBytes,
      ciphertext: row!.ciphertext,
      iv: row!.iv,
      wrappedDek: row!.wrappedDek,
      keyVersion: row!.keyVersion,
      createdAt: now,
      updatedAt: now,
    });
    const [accepted] = await tx
      .update(mailboxOutbox)
      .set({
        status: "accepted",
        providerMessageId: evidence.messageId,
        providerRfcMessageId: rfcMessageId,
        ...sentKeys,
        acceptedAt: now,
        updatedAt: now,
        ciphertext: null,
        iv: null,
        wrappedDek: null,
        keyVersion: null,
        errorCode: null,
      })
      .where(eq(mailboxOutbox.id, row!.id))
      .returning();
    if (evidence.outboundEvidence)
      await recordOutboundEvidence(
        tx,
        accepted!,
        evidence.messageId,
        evidence.outboundEvidence,
        now,
      );
    return outboxDto(accepted!, false);
  });
}

/** Internal worker. The durable claim precedes the external side effect. A job
 * replay, including after worker restart, never invokes a claimed row twice.
 */
export async function sendMailboxOutbox(
  db: Db,
  keys: Keyring,
  outboxId: string,
  sender: MailboxOutboxSender,
  mime: MailboxTransportMimeAdapter,
  now = new Date(),
) {
  const [known] = await db.select().from(mailboxOutbox).where(eq(mailboxOutbox.id, outboxId));
  if (!known) throw new MailboxContentError("not_found");
  if (known.status !== "queued") return outboxDto(known, true);
  let prepared: { row: Outbox; raw: Buffer; parsed: Awaited<ReturnType<typeof envelope>> };
  try {
    const prepare = async (tx: Db, credentialExpiresAt?: Date | null) => {
      const [member] = await tx
        .select({ id: schema.teamMembers.id })
        .from(schema.teamMembers)
        .where(
          and(
            eq(schema.teamMembers.teamId, known.teamId),
            eq(schema.teamMembers.userId, known.approvedBy),
          ),
        );
      if (member?.id !== known.approvedMembershipId) throw new MailboxContentError("forbidden");
      const [row] = await tx
        .select()
        .from(mailboxOutbox)
        .where(eq(mailboxOutbox.id, outboxId))
        .for("update");
      // The lock discovery snapshot is not authorization. Compare the immutable
      // provenance again after the outbox lock, before any provider claim.
      if (
        !row ||
        row.teamId !== known.teamId ||
        row.mailboxId !== known.mailboxId ||
        row.approvedBy !== known.approvedBy ||
        row.approvedMembershipId !== known.approvedMembershipId ||
        row.approvalKind !== known.approvalKind ||
        row.agentKeyId !== known.agentKeyId
      )
        throw new MailboxContentError("forbidden");
      if (row!.status !== "queued")
        return {
          row: row!,
          raw: Buffer.alloc(0),
          parsed: { from: "", to: [], cc: [], bcc: [], count: 0 },
        };
      const plan = await lockMailboxService(tx, row!.teamId, now);
      // The captured counter key survives a monthly boundary and a deferred retry.
      // Revalidate it against the still-current financial term, never move it to now.
      const reservedPeriod = plan.unlimitedOutbound
        ? null
        : mailboxSubscriptionUsagePeriod(plan, row.periodStart);
      if (
        !plan.unlimitedOutbound &&
        (!reservedPeriod ||
          row.periodStart.getTime() !== reservedPeriod.start.getTime() ||
          row.periodEnd.getTime() !== reservedPeriod.end.getTime())
      )
        throw new MailboxReservationExpiredError();
      const [box] = await tx
        .select()
        .from(schema.mailboxes)
        .where(eq(schema.mailboxes.id, row!.mailboxId));
      const [domain] = await tx
        .select({ status: schema.domains.status })
        .from(schema.domains)
        .where(and(eq(schema.domains.id, box!.domainId), eq(schema.domains.teamId, row!.teamId)))
        .for("share");
      if (domain?.status !== "verified") throw new MailboxContentError("forbidden");
      const raw = await open(row!, keys);
      if (hash(raw) !== row!.rawSha256) throw new MailboxContentError("invalid");
      const parsed = await envelope(mime, raw, true);
      if (parsed.from !== box!.address || parsed.count !== row!.recipientCount)
        throw new MailboxContentError("invalid");
      const recipients = [...parsed.to, ...parsed.cc, ...parsed.bcc];
      const recipientHashes = approvedHashes(row!.teamId, recipients, parsed.count);
      if (
        row!.recipientHashes !== null &&
        JSON.stringify(checkedHashes(row!.recipientHashes)) !== JSON.stringify(recipientHashes)
      )
        throw new MailboxContentError("conflict");
      if (!(await checkMailboxRecipientBlocks(tx, { teamId: row!.teamId, recipients })))
        throw new MailboxContentError("forbidden");
      // Time can advance during decryption/parsing even while credential rows are locked.
      if (credentialExpiresAt && credentialExpiresAt.getTime() <= Date.now())
        throw new MailboxAgentAccessError("forbidden");
      const [claimed] = await tx
        .update(mailboxOutbox)
        .set({
          status: "sending",
          recipientHashes,
          attemptId: randomUUID(),
          attemptedAt: now,
          updatedAt: now,
        })
        .where(and(eq(mailboxOutbox.id, outboxId), eq(mailboxOutbox.status, "queued")))
        .returning();
      return { row: claimed!, raw, parsed };
    };
    if (known.approvalKind === "agent") {
      if (!known.agentKeyId) throw new MailboxAgentAccessError("forbidden");
      prepared = await withMailboxAgentQueuedSendAccess(
        db,
        {
          keyId: known.agentKeyId,
          teamId: known.teamId,
          mailboxId: known.mailboxId,
          approvedBy: known.approvedBy,
          approvedMembershipId: known.approvedMembershipId,
        },
        ({ db: tx, expiresAt }) => prepare(tx, expiresAt),
      );
    } else if (known.approvalKind === "human" && known.agentKeyId === null) {
      prepared = await withMailboxWriteAccess(
        db,
        { teamId: known.teamId, userId: known.approvedBy },
        known.mailboxId,
        prepare,
      );
    } else {
      throw new MailboxAgentAccessError("forbidden");
    }
  } catch (error) {
    if (
      !(error instanceof MailboxContentError) &&
      !(error instanceof MailboxServiceError) &&
      !(error instanceof MailboxAgentAccessError)
    )
      throw error;
    const [failed] = await db
      .update(mailboxOutbox)
      .set({
        status: "failed",
        errorCode:
          error instanceof MailboxReservationExpiredError
            ? "reservation_expired"
            : error instanceof MailboxAgentAccessError
              ? "agent_authorization_refused"
              : "admission_refused",
        updatedAt: now,
      })
      .where(and(eq(mailboxOutbox.id, outboxId), eq(mailboxOutbox.status, "queued")))
      .returning();
    if (failed) return outboxDto(failed, false);
    const [current] = await db.select().from(mailboxOutbox).where(eq(mailboxOutbox.id, outboxId));
    if (!current) throw new MailboxContentError("not_found");
    return outboxDto(current!, true);
  }
  const { row, raw, parsed } = prepared;
  if (!raw.length) return outboxDto(row, true);
  try {
    const result = await sender.send({
      idempotencyKey: row.id,
      outboxId: row.id,
      attemptId: row.attemptId!,
      teamId: row.teamId,
      mailboxId: row.mailboxId,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      raw,
    });
    return await acceptMailboxOutbox(db, row.id, {
      attemptId: row.attemptId!,
      messageId: result.messageId,
    });
  } catch (error) {
    if (error instanceof MailboxSendDeferredError) {
      // The trusted adapter proves no external call occurred. Keep the exact
      // snapshot/reservation, clear only this claim, and let the runtime defer
      // its ID. A reconciled unknown/accepted row is never reset by a late job.
      const [deferred] = await db
        .update(mailboxOutbox)
        .set({
          status: "queued",
          attemptId: null,
          attemptedAt: null,
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mailboxOutbox.id, row.id),
            eq(mailboxOutbox.attemptId, row.attemptId!),
            eq(mailboxOutbox.status, "sending"),
          ),
        )
        .returning();
      if (deferred) return outboxDto(deferred, false);
      const [current] = await db.select().from(mailboxOutbox).where(eq(mailboxOutbox.id, row.id));
      return outboxDto(current!, true);
    }
    // The callback's throw, malformed response, or post-accept DB failure may
    // follow provider acceptance. Preserve the payload/reservation for evidence.
    const rejected = error instanceof MailboxSendRejectedError;
    const [changed] = await db
      .update(mailboxOutbox)
      .set({
        status: rejected ? "failed" : "unknown",
        errorCode: rejected ? "provider_rejected" : "provider_unknown",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mailboxOutbox.id, row.id),
          eq(mailboxOutbox.attemptId, row.attemptId!),
          inArray(mailboxOutbox.status, ["sending", "unknown"]),
        ),
      )
      .returning();
    if (changed) return outboxDto(changed, false);
    const [current] = await db.select().from(mailboxOutbox).where(eq(mailboxOutbox.id, row.id));
    return outboxDto(current!, true);
  }
}

/** Recover commit->enqueue gaps. Interrupted claims become unknown, including
 * a process killed before it could call the provider: there is no safe proof of
 * non-delivery. Queue dedupe is helpful but never the durable idempotency gate.
 */
export async function reconcileMailboxOutbox(
  db: Db,
  opts: { enqueue: (outboxId: string) => Promise<void>; now?: Date },
) {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - 15 * 60 * 1000);
  const interrupted = await db
    .update(mailboxOutbox)
    .set({ status: "unknown", errorCode: "attempt_interrupted", updatedAt: now })
    .where(
      and(
        eq(mailboxOutbox.status, "sending"),
        isNotNull(mailboxOutbox.attemptedAt),
        lt(mailboxOutbox.attemptedAt, cutoff),
      ),
    )
    .returning({ id: mailboxOutbox.id });
  const pending = await db
    .select({ id: mailboxOutbox.id })
    .from(mailboxOutbox)
    .where(eq(mailboxOutbox.status, "queued"))
    .orderBy(asc(mailboxOutbox.createdAt), asc(mailboxOutbox.id))
    .limit(1000);
  for (const row of pending) await opts.enqueue(row.id);
  return { requeued: pending.length, unknown: interrupted.length };
}

/** A queue's dead-letter handler can fail a row only before a provider claim.
 * A claimed/ambiguous row must keep its reservation until provider evidence.
 */
export async function failQueuedMailboxOutbox(db: Db, outboxId: string) {
  const rows = await db
    .update(mailboxOutbox)
    .set({ status: "failed", errorCode: "preflight_exhausted", updatedAt: new Date() })
    .where(and(eq(mailboxOutbox.id, outboxId), eq(mailboxOutbox.status, "queued")))
    .returning({ id: mailboxOutbox.id });
  return rows.length > 0;
}
