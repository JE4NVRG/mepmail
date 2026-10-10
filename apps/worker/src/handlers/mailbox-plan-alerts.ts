import {
  accountMailPhrase,
  buildAccountMail,
  claimNotification,
  formatMailDate,
  type MailboxPlanUsage,
  type MailLocale,
  mailboxPlanUsage,
  mailboxSubscriptionUsagePeriod,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { mailOwners, type SystemMailer } from "../system-mail.js";

/** Share of a plan limit at which owners are told it is getting close. */
export const MAILBOX_PLAN_NEAR_RATIO = 0.8;

const NEAR = "mailbox.usage_near" as const;
const REACHED = "mailbox.usage_reached" as const;
const PAUSED = "mailbox.receiving_paused" as const;

type Subscription = typeof schema.mailboxSubscriptions.$inferSelect;
type Metric = {
  key:
    | "outboundRecipients"
    | "outboundBytes"
    | "inboundDeliveries"
    | "inboundBytes"
    | "storageBytes";
  limit: (plan: Subscription) => number | null;
  used: (usage: MailboxPlanUsage) => number;
  bytes: boolean;
};

const METRICS: Metric[] = [
  {
    key: "outboundRecipients",
    limit: (p) => p.includedOutboundPerMailbox,
    used: (u) => u.outboundRecipients,
    bytes: false,
  },
  {
    key: "outboundBytes",
    limit: (p) => p.outboundBytesPerPeriod,
    used: (u) => u.outboundBytes,
    bytes: true,
  },
  {
    key: "inboundDeliveries",
    limit: (p) => p.inboundDeliveriesPerPeriod,
    used: (u) => u.inboundDeliveries,
    bytes: false,
  },
  {
    key: "inboundBytes",
    limit: (p) => p.inboundBytesPerPeriod,
    used: (u) => u.inboundBytes,
    bytes: true,
  },
  {
    key: "storageBytes",
    limit: (p) => p.storageBytesPerMailbox,
    used: (u) => u.storageBytes,
    bytes: true,
  },
];

const PLAN_NAMES: Record<string, string> = { solo: "Solo", duo: "Duo", equipe: "Equipe" };
const NEXT_PLAN: Record<string, string | null> = { solo: "Duo", duo: "Equipe", equipe: null };

function amount(locale: MailLocale, value: number, bytes: boolean): string {
  if (!bytes) return value.toLocaleString(locale);
  const gib = value / 1024 ** 3;
  const [n, unit] = gib >= 1 ? [gib, "GiB"] : [value / 1024 ** 2, "MiB"];
  const digits = n >= 10 || Number.isInteger(n) ? 0 : 1;
  return `${n.toLocaleString(locale, { maximumFractionDigits: digits })} ${unit}`;
}

/**
 * Every 10 minutes with notifications.sweep: owners and admins of a team on a Correio plan
 * hear once per billing month and limit when it passes 80% and when it reaches 100%, and
 * once per receiving pause (senders get a bounce until it ends). Claims make each notice
 * fire once even across replicas; a failed send is not retried.
 */
export async function warnMailboxPlanUsage(
  db: Db,
  deps: { mailer: SystemMailer; appBaseUrl?: string | undefined; now?: Date | undefined },
): Promise<{ near: number; reached: number; paused: number }> {
  const now = deps.now ?? new Date();
  const url = `${deps.appBaseUrl ?? ""}/mail/settings`;
  const result = { near: 0, reached: 0, paused: 0 };
  const plans = await db
    .select({ plan: schema.mailboxSubscriptions, team: schema.teams.name })
    .from(schema.mailboxSubscriptions)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.mailboxSubscriptions.teamId))
    .where(
      and(
        isNotNull(schema.mailboxSubscriptions.planCode),
        inArray(schema.mailboxSubscriptions.status, ["active", "trialing"]),
      ),
    );
  for (const { plan, team } of plans) {
    const code = plan.planCode!;
    const period = mailboxSubscriptionUsagePeriod(plan, now) ?? {
      start: plan.periodStart,
      end: plan.periodEnd,
    };
    const usage = await mailboxPlanUsage(db, plan.teamId, period.start);
    const upgrade = (kind: typeof NEAR | typeof REACHED | typeof PAUSED, locale: MailLocale) =>
      NEXT_PLAN[code]
        ? accountMailPhrase({ locale, kind, key: "upgrade", values: { next: NEXT_PLAN[code]! } })
        : accountMailPhrase({ locale, kind, key: "largest" });
    for (const metric of METRICS) {
      const limit = metric.limit(plan);
      if (limit === null || limit <= 0) continue;
      const used = metric.used(usage);
      const level = used >= limit ? REACHED : used >= limit * MAILBOX_PLAN_NEAR_RATIO ? NEAR : null;
      if (!level) continue;
      const periodKey = `${metric.key}:${period.start.toISOString()}`;
      // Reaching the limit first also settles the 80% notice of this month.
      const claimedNear = await claimNotification(db, {
        teamId: plan.teamId,
        kind: NEAR,
        periodKey,
      });
      const claimed =
        level === NEAR
          ? claimedNear
          : await claimNotification(db, { teamId: plan.teamId, kind: REACHED, periodKey });
      if (!claimed) continue;
      try {
        await mailOwners(db, deps.mailer, plan.teamId, level, (locale) => {
          const values = {
            team,
            plan: PLAN_NAMES[code] ?? code,
            used: amount(locale, used, metric.bytes),
            limit: amount(locale, limit, metric.bytes),
            share: `${Math.min(100, Math.floor((used / limit) * 100))}%`,
            date: formatMailDate(locale, period.end),
          };
          return buildAccountMail({
            kind: level,
            locale,
            url,
            values: {
              ...values,
              title: accountMailPhrase({ locale, kind: level, key: `title_${metric.key}` }),
              detail: accountMailPhrase({ locale, kind: level, key: metric.key, values }),
              upgradeLine: upgrade(level, locale),
            },
          });
        });
        result[level === NEAR ? "near" : "reached"] += 1;
      } catch (err) {
        console.error(`notifications.sweep: ${level} for team ${plan.teamId} failed`, err);
      }
    }
    const [hold] = await db
      .select()
      .from(schema.mailboxReceivingHolds)
      .where(
        and(
          eq(schema.mailboxReceivingHolds.teamId, plan.teamId),
          eq(schema.mailboxReceivingHolds.state, "paused"),
        ),
      );
    if (
      !hold ||
      !(await claimNotification(db, {
        teamId: plan.teamId,
        kind: PAUSED,
        periodKey: `${hold.createdAt.toISOString()}:${hold.reason}`,
      }))
    )
      continue;
    try {
      await mailOwners(db, deps.mailer, plan.teamId, PAUSED, (locale) => {
        const values = {
          team,
          plan: PLAN_NAMES[code] ?? code,
          since: formatMailDate(locale, hold.createdAt),
          date: formatMailDate(locale, period.end),
        };
        return buildAccountMail({
          kind: PAUSED,
          locale,
          url,
          values: {
            ...values,
            reason: accountMailPhrase({
              locale,
              kind: PAUSED,
              key: `reason_${hold.reason}`,
              values,
            }),
            resume: accountMailPhrase({
              locale,
              kind: PAUSED,
              key: hold.reason === "storage" ? "resumeStorage" : "resumePeriod",
              values,
            }),
            upgradeLine: upgrade(PAUSED, locale),
          },
        });
      });
      result.paused += 1;
    } catch (err) {
      console.error(`notifications.sweep: ${PAUSED} for team ${plan.teamId} failed`, err);
    }
  }
  return result;
}
