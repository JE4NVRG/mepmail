import { type Db, schema } from "@millionsend/db";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { mailboxOutbox } from "../../db/src/schema/mailbox-transport.js";
import { MailboxServiceError, type MailboxSubscription } from "./mailbox-service.js";

/**
 * Correio plans (Solo, Duo, Equipe) meter the whole team per billing period. Outbound
 * recipients and bytes are read from mailbox_outbox (a failed admission never counts,
 * a bounce after the provider accepted still does); inbound deliveries and bytes are
 * counted per provider receipt in mailbox_usage_periods, so deleting mail never gives
 * the allowance back.
 *
 * Inbound mail is metered after SES accepted it, which no limit here can undo. A team
 * past its inbound allowance by MAILBOX_INBOUND_PAUSE_RATIO, or out of storage, gets a
 * receiving hold: its addresses leave the SES receipt rules, and SES then refuses new
 * mail before accepting (and billing) it. Mail already accepted is always stored.
 */
export const MAILBOX_INBOUND_PAUSE_RATIO = 1.1;

export type MailboxHoldReason = "inbound_deliveries" | "inbound_bytes" | "storage";

export interface MailboxPlanUsage {
  storageBytes: number;
  outboundRecipients: number;
  outboundBytes: number;
  inboundDeliveries: number;
  inboundBytes: number;
}

type Plan = Pick<
  MailboxSubscription,
  | "teamId"
  | "planCode"
  | "storageBytesPerMailbox"
  | "includedOutboundPerMailbox"
  | "inboundDeliveriesPerPeriod"
  | "inboundBytesPerPeriod"
  | "outboundBytesPerPeriod"
>;

/** Encrypted MIME the team stores: every item plus outbound copies still held for sending. */
export async function mailboxTeamStoredBytes(db: Db, teamId: string): Promise<number> {
  const [items] = await db
    .select({ bytes: sql<string>`coalesce(sum(${schema.mailboxItems.rawBytes}),0)::text` })
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.teamId, teamId));
  const [held] = await db
    .select({ bytes: sql<string>`coalesce(sum(${mailboxOutbox.rawBytes}),0)::text` })
    .from(mailboxOutbox)
    .where(and(eq(mailboxOutbox.teamId, teamId), isNotNull(mailboxOutbox.ciphertext)));
  return Number(BigInt(items?.bytes ?? "0") + BigInt(held?.bytes ?? "0"));
}

/** Recipients and MIME bytes (size × recipients) the team queued in the period. */
export async function mailboxOutboundUsage(db: Db, teamId: string, periodStart: Date) {
  const [usage] = await db
    .select({
      recipients: sql<string>`coalesce(sum(${mailboxOutbox.recipientCount}),0)::text`,
      bytes: sql<string>`coalesce(sum(${mailboxOutbox.rawBytes}::bigint * ${mailboxOutbox.recipientCount}),0)::text`,
    })
    .from(mailboxOutbox)
    .where(
      and(
        eq(mailboxOutbox.teamId, teamId),
        eq(mailboxOutbox.periodStart, periodStart),
        ne(mailboxOutbox.status, "failed"),
      ),
    );
  return { recipients: Number(usage?.recipients ?? 0), bytes: Number(usage?.bytes ?? 0) };
}

export async function mailboxInboundUsage(db: Db, teamId: string, periodStart: Date) {
  const [row] = await db
    .select({
      deliveries: schema.mailboxUsagePeriods.inboundDeliveries,
      bytes: schema.mailboxUsagePeriods.inboundBytes,
    })
    .from(schema.mailboxUsagePeriods)
    .where(
      and(
        eq(schema.mailboxUsagePeriods.teamId, teamId),
        eq(schema.mailboxUsagePeriods.periodStart, periodStart),
      ),
    );
  return { deliveries: row?.deliveries ?? 0, bytes: row?.bytes ?? 0 };
}

export async function mailboxPlanUsage(
  db: Db,
  teamId: string,
  periodStart: Date,
): Promise<MailboxPlanUsage> {
  const [storageBytes, outbound, inbound] = await Promise.all([
    mailboxTeamStoredBytes(db, teamId),
    mailboxOutboundUsage(db, teamId, periodStart),
    mailboxInboundUsage(db, teamId, periodStart),
  ]);
  return {
    storageBytes,
    outboundRecipients: outbound.recipients,
    outboundBytes: outbound.bytes,
    inboundDeliveries: inbound.deliveries,
    inboundBytes: inbound.bytes,
  };
}

/** The point past which receiving pauses: the allowance plus MAILBOX_INBOUND_PAUSE_RATIO's margin. */
export function mailboxInboundPauseAt(allowance: number): number {
  return Math.ceil(allowance * MAILBOX_INBOUND_PAUSE_RATIO);
}

/** Why a plan's receiving must pause now, or null. Pre-plan terms never pause here. */
export function mailboxHoldReason(plan: Plan, usage: MailboxPlanUsage): MailboxHoldReason | null {
  if (!plan.planCode) return null;
  if (usage.storageBytes >= plan.storageBytesPerMailbox) return "storage";
  if (
    plan.inboundDeliveriesPerPeriod !== null &&
    usage.inboundDeliveries >= mailboxInboundPauseAt(plan.inboundDeliveriesPerPeriod)
  )
    return "inbound_deliveries";
  if (
    plan.inboundBytesPerPeriod !== null &&
    usage.inboundBytes >= mailboxInboundPauseAt(plan.inboundBytesPerPeriod)
  )
    return "inbound_bytes";
  return null;
}

/**
 * Count one accepted provider receipt for the team (call once per receipt and team,
 * in the transaction that stored it, under the subscription lock).
 */
export async function recordMailboxInboundReceipt(
  tx: Db,
  teamId: string,
  period: { start: Date; end: Date },
  rawBytes: number,
) {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) throw new MailboxServiceError("invalid");
  const u = schema.mailboxUsagePeriods;
  await tx
    .insert(u)
    .values({
      teamId,
      periodStart: period.start,
      periodEnd: period.end,
      inboundDeliveries: 1,
      inboundBytes: rawBytes,
    })
    .onConflictDoUpdate({
      target: [u.teamId, u.periodStart],
      set: {
        inboundDeliveries: sql`${u.inboundDeliveries} + 1`,
        inboundBytes: sql`${u.inboundBytes} + ${rawBytes}`,
        updatedAt: new Date(),
      },
    });
}

/** Ask for receiving to pause (the worker applies it in SES). True when newly requested. */
export async function requestMailboxReceivingHold(
  tx: Db,
  teamId: string,
  reason: MailboxHoldReason,
  periodEnd: Date,
): Promise<boolean> {
  const h = schema.mailboxReceivingHolds;
  const inserted = await tx
    .insert(h)
    .values({ teamId, reason, periodEnd, state: "pausing" })
    .onConflictDoNothing()
    .returning({ teamId: h.teamId });
  if (inserted.length) return true;
  // A hold that was resuming stays paused when the reason came back.
  const back = await tx
    .update(h)
    .set({ state: "pausing", reason, periodEnd, updatedAt: new Date() })
    .where(and(eq(h.teamId, teamId), eq(h.state, "resuming")))
    .returning({ teamId: h.teamId });
  return back.length > 0;
}

/** Call under the subscription lock before queueing `recipients` copies of `rawBytes`. */
export async function assertMailboxOutboundBytes(
  tx: Db,
  plan: Plan,
  periodStart: Date,
  rawBytes: number,
  recipients: number,
) {
  if (plan.outboundBytesPerPeriod === null) return;
  const usage = await mailboxOutboundUsage(tx, plan.teamId, periodStart);
  if (usage.bytes + rawBytes * recipients > plan.outboundBytesPerPeriod)
    throw new MailboxServiceError("quota");
}
