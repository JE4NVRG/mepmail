import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

export class MailboxServiceError extends Error {
  constructor(public readonly code: "not_entitled" | "quota" | "invalid") {
    super(code);
  }
}
export type MailboxSubscription = typeof schema.mailboxSubscriptions.$inferSelect;

export function mailboxServiceActive(plan: MailboxSubscription | undefined, now = new Date()) {
  return (
    !!plan &&
    (plan.status === "active" || plan.status === "trialing") &&
    plan.seats > 0 &&
    plan.periodStart.getTime() <= now.getTime() &&
    plan.periodEnd.getTime() > now.getTime()
  );
}

/** Public plan/usage DTO contains neither customer IDs nor provider credentials. */
export async function mailboxServiceState(db: Db, teamId: string) {
  const [team] = await db
    .select({ suspendedAt: schema.teams.suspendedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  const [plan] = await db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
  const [usage] = await db
    .select({ boxes: sql<number>`count(*)::int` })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.teamId, teamId));
  return {
    active: !!team && !team.suspendedAt && mailboxServiceActive(plan),
    status: plan?.status ?? "inactive",
    seats: plan?.seats ?? 0,
    reservedSeats: usage?.boxes ?? 0,
    storageBytesPerMailbox: plan?.storageBytesPerMailbox ?? 0,
    includedOutboundPerMailbox: plan?.includedOutboundPerMailbox ?? 0,
    periodStart: plan?.periodStart ?? null,
    periodEnd: plan?.periodEnd ?? null,
    cancelAtPeriodEnd: plan?.cancelAtPeriodEnd ?? false,
    cancelAt: plan?.cancelAt ?? null,
  };
}

/** Membership -> subscription -> domain/mailbox is the shared mutation lock order.
 * The subscription row serializes provisioning and storage admission across boxes.
 * Expiry never deletes data or denies already-authorized reads/export.
 */
export async function lockMailboxService(db: Db, teamId: string, now = new Date()) {
  const [team] = await db
    .select({ suspendedAt: schema.teams.suspendedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId))
    .for("share");
  if (!team || team.suspendedAt) throw new MailboxServiceError("not_entitled");
  const [plan] = await db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId))
    .for("update");
  if (!mailboxServiceActive(plan, now)) throw new MailboxServiceError("not_entitled");
  return plan!;
}

export async function reserveMailboxSeat(db: Db, teamId: string) {
  const plan = await lockMailboxService(db, teamId);
  const [usage] = await db
    .select({ boxes: sql<number>`count(*)::int` })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.teamId, teamId));
  if ((usage?.boxes ?? 0) >= plan.seats) throw new MailboxServiceError("quota");
  return plan;
}

/** Quantity reductions keep content recoverable; only licensed boxes may write/send.
 * Allocation is stable by creation/ID rather than the request's chosen box.
 */
export async function requireMailboxSeat(
  db: Db,
  teamId: string,
  mailboxId: string,
  plan: MailboxSubscription,
) {
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
