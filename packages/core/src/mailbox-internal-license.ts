import { createHash } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, asc, eq } from "drizzle-orm";
import type { MailboxSubscription } from "./mailbox-service.js";

/** Operator-only internal pilot access. Never a public/free Stripe SKU. */
export interface InternalMailboxTerms {
  seats: 2;
  storageBytesPerMailbox: number;
  includedOutboundPerMailbox: number;
  periodStart: Date;
  periodEnd: Date;
}
export interface InternalMailboxGrant {
  grantId: string;
  teamId: string;
  ownerUserId: string;
  reason: string;
  terms: InternalMailboxTerms;
}
export class InternalMailboxLicenseError extends Error {
  constructor(public readonly code: "invalid" | "forbidden" | "conflict") {
    super(code);
  }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FORMAT = "internal-mailbox-license-v1";
function fail(code: InternalMailboxLicenseError["code"]): never {
  throw new InternalMailboxLicenseError(code);
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function reason(value: string) {
  if (typeof value !== "string" || value.trim().length < 3 || value.trim().length > 240)
    fail("invalid");
  return value.trim();
}
function terms(value: InternalMailboxTerms) {
  if (
    value.seats !== 2 ||
    !Number.isSafeInteger(value.storageBytesPerMailbox) ||
    value.storageBytesPerMailbox < 1 ||
    value.storageBytesPerMailbox > 10995116277760 ||
    !Number.isSafeInteger(value.includedOutboundPerMailbox) ||
    value.includedOutboundPerMailbox < 0 ||
    value.includedOutboundPerMailbox > 1000000 ||
    !(value.periodStart instanceof Date) ||
    !(value.periodEnd instanceof Date) ||
    !Number.isFinite(value.periodStart.getTime()) ||
    !Number.isFinite(value.periodEnd.getTime()) ||
    value.periodEnd.getTime() <= value.periodStart.getTime()
  )
    fail("invalid");
  return {
    seats: value.seats,
    storageBytesPerMailbox: value.storageBytesPerMailbox,
    includedOutboundPerMailbox: value.includedOutboundPerMailbox,
    periodStart: value.periodStart.toISOString(),
    periodEnd: value.periodEnd.toISOString(),
  };
}
function planFingerprint(plan: MailboxSubscription) {
  return hash({
    teamId: plan.teamId,
    status: plan.status,
    seats: plan.seats,
    storageBytesPerMailbox: plan.storageBytesPerMailbox,
    includedOutboundPerMailbox: plan.includedOutboundPerMailbox,
    periodStart: plan.periodStart.toISOString(),
    periodEnd: plan.periodEnd.toISOString(),
    stripeCustomerId: plan.stripeCustomerId,
    stripeSubscriptionId: plan.stripeSubscriptionId,
    stripePriceId: plan.stripePriceId,
    stripeSubscriptionItemId: plan.stripeSubscriptionItemId,
    currency: plan.currency,
    unitAmount: plan.unitAmount,
    interval: plan.interval,
    cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
    cancelAt: plan.cancelAt?.toISOString() ?? null,
    stripeSubscriptionCreated: plan.stripeSubscriptionCreated,
    livemode: plan.livemode,
    lastEventCreated: plan.lastEventCreated,
    updatedAt: plan.updatedAt.toISOString(),
  });
}
async function authority(db: Db, teamId: string, operatorUserId: string) {
  // Team serializes absent subscriptions with Customer/Checkout provisioning.
  // Registry mutations use team -> membership -> subscription in the same order.
  const [team] = await db
    .select({ id: schema.teams.id, suspendedAt: schema.teams.suspendedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId))
    .for("update");
  if (!team) fail("forbidden");
  const [operator] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .orderBy(asc(schema.user.createdAt), asc(schema.user.id))
    .limit(1)
    .for("share");
  if (!operator || operator.id !== operatorUserId) fail("forbidden");
  return team;
}
async function grantRecord(db: Db, teamId: string, grantId: string) {
  const [record] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.id, grantId));
  if (
    record &&
    (record.teamId !== teamId ||
      record.action !== "mailbox.license_granted" ||
      record.target !== `mailbox_license:${grantId}` ||
      record.data?.format !== FORMAT)
  )
    fail("conflict");
  return record;
}

/** No defaults for dates/allowances, provider call, or public mutation endpoint.
 * The immutable audit row and the entitlement must commit together or not at all.
 */
export async function grantInternalMailboxLicense(
  db: Db,
  operatorUserId: string,
  input: InternalMailboxGrant,
) {
  if (!UUID.test(input.grantId) || !UUID.test(input.teamId) || !input.ownerUserId) fail("invalid");
  const grantId = input.grantId;
  const teamId = input.teamId;
  const ownerUserId = input.ownerUserId;
  const normalized = {
    teamId: input.teamId,
    ownerUserId: input.ownerUserId,
    reason: reason(input.reason),
    terms: terms(input.terms),
  };
  return db.transaction(async (tx) => {
    const transaction = tx as unknown as Db;
    const team = await authority(transaction, teamId, operatorUserId);
    if (team.suspendedAt) fail("forbidden");
    const [owner] = await tx
      .select({ id: schema.teamMembers.id, role: schema.teamMembers.role })
      .from(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, ownerUserId)))
      .for("share");
    if (!owner || owner.role !== "owner") fail("forbidden");
    const requestFingerprint = hash({ ...normalized, ownerMembershipId: owner.id });
    const previous = await grantRecord(transaction, teamId, grantId);
    const [current] = await tx
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId))
      .for("update");
    if (previous) {
      if (
        previous.actorId !== `user:${operatorUserId}` ||
        previous.data?.requestFingerprint !== requestFingerprint ||
        !current ||
        previous.data?.planFingerprint !== planFingerprint(current)
      )
        fail("conflict");
      return { grantId: grantId, teamId: teamId, applied: false };
    }
    if (
      current ||
      new Date(normalized.terms.periodStart).getTime() > Date.now() ||
      new Date(normalized.terms.periodEnd).getTime() <= Date.now()
    )
      fail("conflict");
    const [customer] = await tx
      .select({ id: schema.mailboxCustomerRequests.teamId })
      .from(schema.mailboxCustomerRequests)
      .where(eq(schema.mailboxCustomerRequests.teamId, teamId));
    const [checkout] = await tx
      .select({ id: schema.mailboxCheckouts.id })
      .from(schema.mailboxCheckouts)
      .where(eq(schema.mailboxCheckouts.teamId, teamId))
      .limit(1);
    if (customer || checkout) fail("conflict");
    const [plan] = await tx
      .insert(schema.mailboxSubscriptions)
      .values({
        teamId: teamId,
        status: "active",
        ...normalized.terms,
        periodStart: new Date(normalized.terms.periodStart),
        periodEnd: new Date(normalized.terms.periodEnd),
      })
      .returning();
    if (!plan) fail("conflict");
    await tx.insert(schema.auditLog).values({
      id: grantId,
      teamId: teamId,
      actorId: `user:${operatorUserId}`,
      action: "mailbox.license_granted",
      target: `mailbox_license:${grantId}`,
      data: {
        format: FORMAT,
        ...normalized,
        ownerMembershipId: owner.id,
        requestFingerprint,
        planFingerprint: planFingerprint(plan),
      },
    });
    return { grantId: grantId, teamId: teamId, applied: true };
  });
}

/** Cancel only the exact audited grant. Mailboxes, content, quotas and outbox stay recoverable. */
export async function revokeInternalMailboxLicense(
  db: Db,
  operatorUserId: string,
  input: { teamId: string; grantId: string; operationId: string; reason: string },
) {
  if (
    !UUID.test(input.teamId) ||
    !UUID.test(input.grantId) ||
    !UUID.test(input.operationId) ||
    input.operationId === input.grantId
  )
    fail("invalid");
  const normalizedReason = reason(input.reason);
  const teamId = input.teamId;
  const grantId = input.grantId;
  const operationId = input.operationId;
  return db.transaction(async (tx) => {
    const transaction = tx as unknown as Db;
    await authority(transaction, teamId, operatorUserId);
    const grant = await grantRecord(transaction, teamId, grantId);
    if (!grant) fail("conflict");
    const [current] = await tx
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId))
      .for("update");
    const [previous] = await tx
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, operationId));
    const requestFingerprint = hash({ teamId: teamId, grantId: grantId, reason: normalizedReason });
    if (previous) {
      if (
        previous.teamId !== teamId ||
        previous.actorId !== `user:${operatorUserId}` ||
        previous.action !== "mailbox.license_revoked" ||
        previous.target !== `mailbox_license:${grantId}` ||
        previous.data?.format !== FORMAT ||
        previous.data?.requestFingerprint !== requestFingerprint ||
        !current ||
        previous.data?.planFingerprint !== planFingerprint(current)
      )
        fail("conflict");
      return { grantId: grantId, teamId: teamId, applied: false };
    }
    if (!current || grant.data?.planFingerprint !== planFingerprint(current)) fail("conflict");
    const [revoked] = await tx
      .update(schema.mailboxSubscriptions)
      .set({ status: "canceled", seats: 0, updatedAt: new Date() })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId))
      .returning();
    if (!revoked) fail("conflict");
    await tx.insert(schema.auditLog).values({
      id: operationId,
      teamId: teamId,
      actorId: `user:${operatorUserId}`,
      action: "mailbox.license_revoked",
      target: `mailbox_license:${grantId}`,
      data: {
        format: FORMAT,
        grantId: grantId,
        reason: normalizedReason,
        requestFingerprint,
        planFingerprint: planFingerprint(revoked),
      },
    });
    return { grantId: grantId, teamId: teamId, applied: true };
  });
}
