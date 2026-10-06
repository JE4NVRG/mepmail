import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

export class MailboxServiceError extends Error {
  constructor(public readonly code: "not_entitled" | "quota" | "invalid") {
    super(code);
  }
}
export type MailboxSubscription = typeof schema.mailboxSubscriptions.$inferSelect;
/** Internal capacity for the verified platform operator; never a paid-plan allowance. */
export const SYSTEM_MAILBOX_STORAGE_BYTES = 50 * 1024 ** 3;
export type MailboxOperationalPlan = MailboxSubscription & {
  unlimitedSeats: boolean;
  unlimitedOutbound: boolean;
};

export function mailboxServiceActive(plan: MailboxSubscription | undefined, now = new Date()) {
  return (
    !!plan &&
    (plan.status === "active" || plan.status === "trialing") &&
    plan.seats > 0 &&
    plan.periodStart.getTime() <= now.getTime() &&
    plan.periodEnd.getTime() > now.getTime()
  );
}

/** System is the platform operator's own team, not an ordinary tenant administrator.
 * Resolve current database authority; session roles and request fields cannot grant it.
 * The team lock stabilizes plan changes, and the owner lock stabilizes this privilege.
 */
export async function mailboxServiceEntitlement(
  db: Db,
  teamId: string,
  lock = false,
  now = new Date(),
) {
  const teamQuery = db
    .select({ plan: schema.teams.plan, suspendedAt: schema.teams.suspendedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  const [team] = await (lock ? teamQuery.for("share") : teamQuery);
  let system = false;
  if (team?.plan === "system" && !team.suspendedAt) {
    const [operator] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .orderBy(asc(schema.user.createdAt), asc(schema.user.id))
      .limit(1);
    if (operator) {
      const ownerQuery = db
        .select({ id: schema.teamMembers.id })
        .from(schema.teamMembers)
        .where(
          and(
            eq(schema.teamMembers.teamId, teamId),
            eq(schema.teamMembers.userId, operator.id),
            eq(schema.teamMembers.role, "owner"),
          ),
        );
      const [owner] = await (lock ? ownerQuery.for("share") : ownerQuery);
      system = !!owner;
    }
  }
  const planQuery = db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
  const [plan] = await (lock ? planQuery.for("update") : planQuery);
  const allowed = !!team && !team.suspendedAt;
  const resourcePolicyActive = allowed && !!plan && (system || mailboxServiceActive(plan, now));
  return {
    // Preserve the audited grant row; only the authority-derived operational view changes.
    plan: system && plan ? { ...plan, storageBytesPerMailbox: SYSTEM_MAILBOX_STORAGE_BYTES } : plan,
    licenseKind: system
      ? ("system" as const)
      : plan
        ? ("subscription" as const)
        : ("none" as const),
    unlimitedSeats: system,
    unlimitedOutbound: system,
    active: allowed && (system || mailboxServiceActive(plan, now)),
    resourcePolicyActive,
  };
}

/** The effective policy preserves the audited row and System's internal capacity. */
export function requireMailboxOperationalPlan(
  entitlement: Awaited<ReturnType<typeof mailboxServiceEntitlement>> | null,
): MailboxOperationalPlan {
  if (!entitlement || !entitlement.active || !entitlement.resourcePolicyActive || !entitlement.plan)
    throw new MailboxServiceError("not_entitled");
  return {
    ...entitlement.plan,
    unlimitedSeats: entitlement.unlimitedSeats,
    unlimitedOutbound: entitlement.unlimitedOutbound,
  };
}

/** Public plan/usage DTO contains neither customer IDs nor provider credentials. */
export async function mailboxServiceState(db: Db, teamId: string) {
  const entitlement = await mailboxServiceEntitlement(db, teamId);
  const { plan } = entitlement;
  const [usage] = await db
    .select({ boxes: sql<number>`count(*)::int` })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.teamId, teamId));
  return {
    active: entitlement.active,
    licenseKind: entitlement.licenseKind,
    unlimitedSeats: entitlement.unlimitedSeats,
    unlimitedOutbound: entitlement.unlimitedOutbound,
    resourcePolicyActive: entitlement.resourcePolicyActive,
    status: plan?.status ?? "inactive",
    seats: plan?.seats ?? 0,
    reservedSeats: usage?.boxes ?? 0,
    storageBytesPerMailbox: plan?.storageBytesPerMailbox ?? 0,
    includedOutboundPerMailbox: plan?.includedOutboundPerMailbox ?? 0,
    periodStart: entitlement.unlimitedOutbound ? null : (plan?.periodStart ?? null),
    periodEnd: entitlement.unlimitedOutbound ? null : (plan?.periodEnd ?? null),
    cancelAtPeriodEnd: plan?.cancelAtPeriodEnd ?? false,
    cancelAt: plan?.cancelAt ?? null,
  };
}

/** Membership -> subscription -> domain/mailbox is the shared mutation lock order.
 * The subscription row serializes provisioning and storage admission across boxes.
 * Expiry never deletes data or denies already-authorized reads/export.
 */
export async function lockMailboxService(db: Db, teamId: string, now = new Date()) {
  return requireMailboxOperationalPlan(await mailboxServiceEntitlement(db, teamId, true, now));
}

export async function reserveMailboxSeat(db: Db, teamId: string) {
  const entitlement = await mailboxServiceEntitlement(db, teamId, true);
  if (!entitlement.active) throw new MailboxServiceError("not_entitled");
  if (entitlement.unlimitedSeats) return entitlement;
  const plan = entitlement.plan;
  if (!plan) throw new MailboxServiceError("not_entitled");
  const [usage] = await db
    .select({ boxes: sql<number>`count(*)::int` })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.teamId, teamId));
  if ((usage?.boxes ?? 0) >= plan.seats) throw new MailboxServiceError("quota");
  return entitlement;
}

/** Quantity reductions keep content recoverable; only licensed boxes may write/send.
 * Allocation is stable by creation/ID rather than the request's chosen box.
 */
export async function requireMailboxSeat(
  db: Db,
  teamId: string,
  mailboxId: string,
  plan: MailboxSubscription & { unlimitedSeats?: boolean },
) {
  if (plan.teamId !== teamId) throw new MailboxServiceError("not_entitled");
  if (plan.unlimitedSeats) {
    const [box] = await db
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(and(eq(schema.mailboxes.id, mailboxId), eq(schema.mailboxes.teamId, teamId)));
    if (!box) throw new MailboxServiceError("not_entitled");
    return;
  }
  const licensed = await db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.teamId, teamId))
    .orderBy(asc(schema.mailboxes.createdAt), asc(schema.mailboxes.id))
    .limit(plan.seats);
  if (!licensed.some((b) => b.id === mailboxId)) throw new MailboxServiceError("not_entitled");
}

/** All encrypted MIME, including drafts, counts toward the box's included storage.
 * Call while holding the subscription and mailbox locks. Updates charge only delta.
 */
export async function assertMailboxStorage(
  db: Db,
  teamId: string,
  mailboxId: string,
  delta: number,
  plan: MailboxSubscription,
) {
  if (!Number.isSafeInteger(delta)) throw new MailboxServiceError("invalid");
  const [usage] = await db
    .select({ bytes: sql<string>`coalesce(sum(${schema.mailboxItems.rawBytes}),0)::text` })
    .from(schema.mailboxItems)
    .where(
      and(eq(schema.mailboxItems.teamId, teamId), eq(schema.mailboxItems.mailboxId, mailboxId)),
    );
  const total = BigInt(usage?.bytes ?? "0") + BigInt(delta);
  const [submitted] = await db
    .select({ bytes: sql<string>`coalesce(sum(${schema.mailboxOutbox.rawBytes}),0)::text` })
    .from(schema.mailboxOutbox)
    .where(
      and(
        eq(schema.mailboxOutbox.teamId, teamId),
        eq(schema.mailboxOutbox.mailboxId, mailboxId),
        isNotNull(schema.mailboxOutbox.ciphertext),
      ),
    );
  const stored = total + BigInt(submitted?.bytes ?? "0");
  if (stored < 0n || stored > BigInt(plan.storageBytesPerMailbox))
    throw new MailboxServiceError("quota");
}
