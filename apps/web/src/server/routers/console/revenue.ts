import { schema } from "@millionsend/db";
import { eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { mailboxRegistryEnabled } from "../../mailboxes";
import { operatorProcedure, router } from "../../trpc";

const LIVE = new Set(["active", "trialing", "past_due"]);
const DAY_MS = 86_400_000;

export type RevenueSource = "stripe" | "internal";
export type RevenueProduct = "send" | "mail";

export interface RevenueRow {
  teamId: string;
  team: string;
  suspended: boolean;
  product: RevenueProduct;
  plan: string | null;
  status: string;
  source: RevenueSource;
  /** Recurring amount per month from the stored contract; null when none is on file. */
  monthlyCents: number | null;
  currency: string | null;
  seats: number | null;
  periodEnd: Date | null;
  cancelAt: Date | null;
  /** A live Stripe subscription that bills (not internal, not test mode, not ended). */
  paying: boolean;
}

/**
 * Correio's monthly amount from the stored price: a bundle (team quota or
 * more than one included mailbox) is the base plus each extra mailbox; the
 * per-mailbox plan is the unit times the seats. Yearly prices are spread.
 */
export function mailboxMonthlyCents(m: {
  unitAmount: number | null;
  extraUnitAmount: number | null;
  seats: number;
  includedMailboxes: number;
  quotaScope: string;
  interval: string | null;
}): number | null {
  if (!m.unitAmount || m.unitAmount <= 0 || !m.interval) return null;
  const bundle = m.quotaScope === "team" || m.includedMailboxes > 1;
  const total = bundle
    ? m.unitAmount + Math.max(0, m.seats - m.includedMailboxes) * (m.extraUnitAmount ?? 0)
    : m.unitAmount * Math.max(1, m.seats);
  return m.interval === "year" ? Math.round(total / 12) : total;
}

/**
 * Revenue as the database mirrors it from verified Stripe webhooks: no Stripe
 * call, no invoice. Internal licenses (no Stripe subscription) are listed
 * apart and never counted as revenue.
 */
export const consoleRevenueRouter = router({
  summary: operatorProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const t = schema.teams;
    const m = schema.mailboxSubscriptions;
    const [send, mail] = await Promise.all([
      ctx.db
        .select({
          teamId: t.id,
          team: t.name,
          suspendedAt: t.suspendedAt,
          plan: t.plan,
          status: t.planStatus,
          subscriptionId: t.stripeSubscriptionId,
          contract: t.sendBillingContract,
          periodEnd: t.currentPeriodEnd,
          cancelAt: t.cancelAt,
        })
        .from(t)
        .where(
          or(
            isNotNull(t.stripeSubscriptionId),
            ne(t.planStatus, "none"),
            sql`${t.plan}::text in ('starter', 'pro', 'scale')`,
          ),
        ),
      // Correio's tables only exist where its registry is on (self-host may not have them).
      !mailboxRegistryEnabled()
        ? Promise.resolve([])
        : ctx.db
            .select({
              teamId: t.id,
              team: t.name,
              suspendedAt: t.suspendedAt,
              plan: m.planCode,
              status: m.status,
              subscriptionId: m.stripeSubscriptionId,
              livemode: m.livemode,
              currency: m.currency,
              unitAmount: m.unitAmount,
              extraUnitAmount: m.extraUnitAmount,
              seats: m.seats,
              includedMailboxes: m.includedMailboxes,
              quotaScope: m.quotaScope,
              interval: m.interval,
              periodEnd: m.periodEnd,
              cancelAt: m.cancelAt,
              cancelAtPeriodEnd: m.cancelAtPeriodEnd,
            })
            .from(m)
            .innerJoin(t, eq(t.id, m.teamId)),
    ]);

    const rows: RevenueRow[] = [
      ...send.map((r) => {
        const source: RevenueSource = r.subscriptionId ? "stripe" : "internal";
        const monthlyCents =
          r.contract && r.contract.regularMonthlyCents > 0 ? r.contract.regularMonthlyCents : null;
        return {
          teamId: r.teamId,
          team: r.team,
          suspended: r.suspendedAt !== null,
          product: "send" as const,
          plan: r.plan,
          status: r.status,
          source,
          monthlyCents,
          currency: monthlyCents ? (r.contract?.currency ?? "usd") : null,
          seats: null,
          periodEnd: r.periodEnd,
          cancelAt: r.cancelAt,
          paying: source === "stripe" && LIVE.has(r.status) && r.plan !== "free",
        };
      }),
      ...mail.map((r) => {
        const source: RevenueSource = r.subscriptionId ? "stripe" : "internal";
        const ended = r.periodEnd.getTime() <= now.getTime();
        return {
          teamId: r.teamId,
          team: r.team,
          suspended: r.suspendedAt !== null,
          product: "mail" as const,
          plan: r.plan,
          status: r.status,
          source,
          monthlyCents: source === "stripe" ? mailboxMonthlyCents(r) : null,
          currency: source === "stripe" ? r.currency : null,
          seats: r.seats,
          periodEnd: r.periodEnd,
          cancelAt: r.cancelAt ?? (r.cancelAtPeriodEnd ? r.periodEnd : null),
          paying: source === "stripe" && LIVE.has(r.status) && r.livemode !== false && !ended,
        };
      }),
    ];

    const rank = (r: RevenueRow) =>
      r.paying ? 0 : r.source === "internal" && LIVE.has(r.status) ? 1 : 2;
    rows.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.periodEnd?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (b.periodEnd?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
        a.team.localeCompare(b.team),
    );

    const paying = rows.filter((r) => r.paying);
    const mrr: Record<string, number> = {};
    for (const r of paying) {
      if (r.monthlyCents && r.currency) {
        const key = r.currency.toLowerCase();
        mrr[key] = (mrr[key] ?? 0) + r.monthlyCents;
      }
    }
    const soon = now.getTime() + 30 * DAY_MS;
    return {
      mrr: Object.entries(mrr)
        .map(([currency, cents]) => ({ currency, cents }))
        .sort((a, b) => b.cents - a.cents),
      paying: {
        send: paying.filter((r) => r.product === "send").length,
        mail: paying.filter((r) => r.product === "mail").length,
      },
      pastDue: paying.filter((r) => r.status === "past_due").length,
      renewals30d: paying.filter((r) => !r.cancelAt && r.periodEnd && r.periodEnd.getTime() <= soon)
        .length,
      cancellations30d: paying.filter((r) => r.cancelAt && r.cancelAt.getTime() <= soon).length,
      internal: rows.filter((r) => r.source === "internal" && LIVE.has(r.status)).length,
      ended: rows.filter((r) => !r.paying && !(r.source === "internal" && LIVE.has(r.status)))
        .length,
      rows,
    };
  }),
});
