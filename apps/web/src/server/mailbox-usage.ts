import {
  listMailboxRegistry,
  MAILBOX_TRIAL_DAILY_RECIPIENTS,
  MAILBOX_TRIAL_TOTAL_RECIPIENTS,
  MailboxContentError,
  mailboxInboundPauseAt,
  mailboxPlanUsage,
  mailboxServiceEntitlement,
  mailboxTrialUsage,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

/** Uses the same physical bytes and recipient reservations as admission checks; no message opens. */
export async function getMailboxUsage(
  db: Db,
  actor: { teamId: string; userId: string },
  input: { mailboxId: string | null },
) {
  const registry = await listMailboxRegistry(db, actor);
  const readable = registry.mailboxes.filter(
    (box) =>
      box.canRead && box.status === "planned" && (!input.mailboxId || box.id === input.mailboxId),
  );
  if (input.mailboxId && !readable.length) throw new MailboxContentError("not_found");
  if (!readable.length) return { mailboxes: [] };
  const entitlement = await mailboxServiceEntitlement(db, actor.teamId);
  const plan = entitlement.plan;
  const ids = readable.map((box) => box.id);
  const stored = await db
    .select({
      mailboxId: schema.mailboxItems.mailboxId,
      bytes: sql<string>`coalesce(sum(${schema.mailboxItems.rawBytes}),0)::text`,
    })
    .from(schema.mailboxItems)
    .where(
      and(
        eq(schema.mailboxItems.teamId, actor.teamId),
        inArray(schema.mailboxItems.mailboxId, ids),
      ),
    )
    .groupBy(schema.mailboxItems.mailboxId);
  const queued = await db
    .select({
      mailboxId: schema.mailboxOutbox.mailboxId,
      bytes: sql<string>`coalesce(sum(${schema.mailboxOutbox.rawBytes}),0)::text`,
    })
    .from(schema.mailboxOutbox)
    .where(
      and(
        eq(schema.mailboxOutbox.teamId, actor.teamId),
        inArray(schema.mailboxOutbox.mailboxId, ids),
        isNotNull(schema.mailboxOutbox.ciphertext),
      ),
    )
    .groupBy(schema.mailboxOutbox.mailboxId);
  const outbound = await db
    .select({
      mailboxId: schema.mailboxOutbox.mailboxId,
      recipients: sql<string>`coalesce(sum(${schema.mailboxOutbox.recipientCount}),0)::text`,
    })
    .from(schema.mailboxOutbox)
    .where(
      and(
        eq(schema.mailboxOutbox.teamId, actor.teamId),
        inArray(schema.mailboxOutbox.mailboxId, ids),
        ne(schema.mailboxOutbox.status, "failed"),
        entitlement.unlimitedOutbound
          ? undefined
          : entitlement.usagePeriod
            ? eq(schema.mailboxOutbox.periodStart, entitlement.usagePeriod.start)
            : sql`false`,
      ),
    )
    .groupBy(schema.mailboxOutbox.mailboxId);
  const storage = new Map(stored.map((row) => [row.mailboxId, Number(row.bytes)]));
  const queue = new Map(queued.map((row) => [row.mailboxId, Number(row.bytes)]));
  const recipients = new Map(outbound.map((row) => [row.mailboxId, Number(row.recipients)]));
  // A "team" quota is one allowance for every mailbox of the team, readable or not.
  const team =
    plan?.quotaScope === "team"
      ? await teamUsage(db, actor.teamId, entitlement.usagePeriod?.start ?? null)
      : null;
  return {
    quotaScope: plan?.quotaScope ?? ("mailbox" as const),
    plan:
      plan?.planCode && entitlement.usagePeriod
        ? await planUsage(db, plan, entitlement.usagePeriod, entitlement.active)
        : null,
    team: team && {
      ...team,
      storageLimitBytes: plan?.storageBytesPerMailbox ?? 0,
      outboundLimitRecipients: entitlement.unlimitedOutbound
        ? null
        : (plan?.includedOutboundPerMailbox ?? 0),
    },
    mailboxes: readable.map((box) => ({
      mailboxId: box.id,
      address: box.address,
      label: box.label,
      kind: box.kind,
      storageUsedBytes: (storage.get(box.id) ?? 0) + (queue.get(box.id) ?? 0),
      storageLimitBytes: plan?.storageBytesPerMailbox ?? 0,
      outboundUsedRecipients: recipients.get(box.id) ?? 0,
      outboundLimitRecipients: entitlement.unlimitedOutbound
        ? null
        : (plan?.includedOutboundPerMailbox ?? 0),
      periodStart: entitlement.usagePeriod?.start ?? null,
      periodEnd: entitlement.usagePeriod?.end ?? null,
    })),
  };
}

/** The whole team's storage and this period's recipients, for a shared ("team") quota. */
async function teamUsage(db: Db, teamId: string, periodStart: Date | null) {
  const [items] = await db
    .select({ bytes: sql<string>`coalesce(sum(${schema.mailboxItems.rawBytes}),0)::text` })
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.teamId, teamId));
  const [outbox] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${schema.mailboxOutbox.rawBytes}) filter (where ${schema.mailboxOutbox.ciphertext} is not null),0)::text`,
      recipients: periodStart
        ? sql<string>`coalesce(sum(${schema.mailboxOutbox.recipientCount}) filter (where ${schema.mailboxOutbox.periodStart} = ${periodStart} and ${schema.mailboxOutbox.status} <> 'failed'),0)::text`
        : sql<string>`'0'`,
    })
    .from(schema.mailboxOutbox)
    .where(eq(schema.mailboxOutbox.teamId, teamId));
  return {
    storageUsedBytes: Number(items?.bytes ?? 0) + Number(outbox?.bytes ?? 0),
    outboundUsedRecipients: Number(outbox?.recipients ?? 0),
  };
}

const PLAN_ORDER = ["solo", "duo", "equipe"] as const;
type PlanCode = (typeof PLAN_ORDER)[number];
const PLAN_NAMES: Record<PlanCode, string> = { solo: "Solo", duo: "Duo", equipe: "Equipe" };

/** The next plan up, or null on the largest: every allowance grows with it. */
function upgradeFor(code: PlanCode) {
  const next = PLAN_ORDER[PLAN_ORDER.indexOf(code) + 1];
  return next ? { planId: next, name: PLAN_NAMES[next] } : null;
}

type Plan = NonNullable<Awaited<ReturnType<typeof mailboxServiceEntitlement>>["plan"]>;

/**
 * A Correio plan's whole-team usage, limits and receiving state, for the Correio and
 * desktop screens (no price logic on the client: the upgrade target comes from here).
 */
async function planUsage(db: Db, plan: Plan, period: { start: Date; end: Date }, active: boolean) {
  const code = plan.planCode as PlanCode;
  const used = await mailboxPlanUsage(db, plan.teamId, period.start);
  const [boxes] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.teamId, plan.teamId));
  const [hold] = await db
    .select()
    .from(schema.mailboxReceivingHolds)
    .where(eq(schema.mailboxReceivingHolds.teamId, plan.teamId));
  const upgrade = upgradeFor(code);
  const periodEndsAt = period.end.toISOString();
  const metric = (usedValue: number, limit: number | null, resets: boolean) => ({
    used: usedValue,
    limit,
    periodEndsAt: resets ? periodEndsAt : null,
    upgrade,
  });
  const trial =
    plan.status === "trialing" && active
      ? {
          active: true,
          endsAt: plan.periodEnd.toISOString(),
          dailyLimit: MAILBOX_TRIAL_DAILY_RECIPIENTS,
          totalLimit: MAILBOX_TRIAL_TOTAL_RECIPIENTS,
          ...(await mailboxTrialUsage(db, plan.teamId, plan.periodStart).then((u) => ({
            sentToday: u.today,
            sentTotal: u.total,
          }))),
        }
      : null;
  return {
    code,
    name: PLAN_NAMES[code],
    status: plan.status,
    periodStart: period.start.toISOString(),
    periodEndsAt,
    trial,
    upgrade,
    metrics: {
      mailboxes: metric(boxes?.count ?? 0, plan.seats, false),
      storageBytes: metric(used.storageBytes, plan.storageBytesPerMailbox, false),
      outboundRecipients: metric(used.outboundRecipients, plan.includedOutboundPerMailbox, true),
      outboundBytes: metric(used.outboundBytes, plan.outboundBytesPerPeriod, true),
      inboundDeliveries: {
        ...metric(used.inboundDeliveries, plan.inboundDeliveriesPerPeriod, true),
        pauseAt:
          plan.inboundDeliveriesPerPeriod === null
            ? null
            : mailboxInboundPauseAt(plan.inboundDeliveriesPerPeriod),
      },
      inboundBytes: {
        ...metric(used.inboundBytes, plan.inboundBytesPerPeriod, true),
        pauseAt:
          plan.inboundBytesPerPeriod === null
            ? null
            : mailboxInboundPauseAt(plan.inboundBytesPerPeriod),
      },
    },
    receiving: hold
      ? {
          // "pausing" is wanted but not yet confirmed in SES; mail may still arrive.
          state:
            hold.state === "paused"
              ? ("paused_quota" as const)
              : (hold.state as "pausing" | "resuming"),
          reason: hold.reason,
          since: hold.createdAt.toISOString(),
          resumesAt: hold.reason === "storage" ? null : hold.periodEnd.toISOString(),
        }
      : { state: "active" as const, reason: null, since: null, resumesAt: null },
  };
}
