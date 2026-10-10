import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { MailboxLaunchCohort } from "../../core/src/mailbox-launch-cohort.js";
import { mailboxManagementRequests } from "../../db/src/schema/mailbox-management-requests.js";
import {
  isStandaloneMailboxPrice,
  type MailboxCatalog,
  type MailboxPriceTerms,
} from "./mailbox.js";
import { hasPaidSendingPlanForMailbox } from "./mailbox-addon.js";
import type { BillingStripe } from "./stripe.js";

/** Envio's own grace after a plan lapses; the add-on price keeps until then. */
export const MAILBOX_ADDON_GRACE_MS = 7 * 86_400_000;

export interface MailboxRepricedChange {
  teamId: string;
  stripeSubscriptionId: string;
  seats: number;
  interval: "month" | "year";
  currency: string;
  fromUnitAmount: number;
  toUnitAmount: number;
  /** The renewal from which the new price is charged. */
  effectiveAt: Date;
}

export interface MailboxRepriceDeps {
  db: Db;
  stripe: Pick<BillingStripe, "subscriptions">;
  catalog: MailboxCatalog;
  earlyAccessCohort?: MailboxLaunchCohort | null | undefined;
  now?: Date;
  /** After Stripe accepted the change; a failure here never undoes it. */
  notify?: (change: MailboxRepricedChange) => Promise<void>;
}

const OPEN_REQUESTS = ["prepared", "creating", "pending", "scheduled"] as const;
const PRICE_ID = /^price_[A-Za-z0-9_]+$/;

/**
 * The operator catalog (MAILBOX_BILLING_CATALOG) for jobs outside the web app,
 * which keeps its own stricter parser for purchases. Null when absent, malformed
 * or in the other Stripe mode: then nothing is repriced.
 */
export function mailboxCatalogFromJson(
  raw: string | undefined,
  livemode: boolean,
): MailboxCatalog | null {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  const c = value as Partial<MailboxCatalog> | null;
  if (!c || c.livemode !== livemode || !Array.isArray(c.prices)) return null;
  const prices = c.prices.filter(
    (p): p is MailboxPriceTerms =>
      !!p &&
      typeof p.priceId === "string" &&
      PRICE_ID.test(p.priceId) &&
      typeof p.currency === "string" &&
      Number.isSafeInteger(p.unitAmount) &&
      (p.interval === "month" || p.interval === "year") &&
      Number.isSafeInteger(p.storageBytesPerMailbox) &&
      Number.isSafeInteger(p.includedOutboundPerMailbox),
  );
  if (prices.length !== c.prices.length) return null;
  const standalone = Array.isArray(c.standalonePriceIds) ? c.standalonePriceIds : [];
  if (standalone.some((id) => !prices.some((p) => p.priceId === id))) return null;
  return {
    livemode,
    checkoutPriceId: typeof c.checkoutPriceId === "string" ? c.checkoutPriceId : null,
    ...(Array.isArray(c.checkoutPriceIds) ? { checkoutPriceIds: c.checkoutPriceIds } : {}),
    standalonePriceIds: standalone,
    prices,
  };
}

/**
 * The add-on prices are sold to teams with a paid Envio contract. A team that
 * kept its Correio subscription but has gone without Envio past its grace
 * moves to the standalone price of the same interval: no proration, so the
 * paid period is untouched and the next renewal charges the standalone price.
 * Anything in motion is left for a later run: a cancellation, a schedule, a
 * pending update or an open management request, or a Stripe subscription that
 * no longer matches the stored contract. Idempotent per subscription and price.
 */
export async function repriceMailboxAddOnsWithoutSending(
  deps: MailboxRepriceDeps,
): Promise<{ checked: number; repriced: number }> {
  const { db, catalog } = deps;
  const now = deps.now ?? new Date();
  const standalone = catalog.standalonePriceIds ?? [];
  if (standalone.length === 0) return { checked: 0, repriced: 0 };
  const addOnIds = catalog.prices
    .map((price) => price.priceId)
    .filter((id) => !isStandaloneMailboxPrice(catalog, id));
  if (addOnIds.length === 0) return { checked: 0, repriced: 0 };

  const s = schema.mailboxSubscriptions;
  const t = schema.teams;
  const rows = await db
    .select({
      plan: s,
      team: {
        id: t.id,
        plan: t.plan,
        planStatus: t.planStatus,
        suspendedAt: t.suspendedAt,
        stripeCustomerId: t.stripeCustomerId,
        stripeSubscriptionId: t.stripeSubscriptionId,
        currentPeriodStart: t.currentPeriodStart,
        currentPeriodEnd: t.currentPeriodEnd,
        cancelAt: t.cancelAt,
        sendBillingContract: t.sendBillingContract,
      },
    })
    .from(s)
    .innerJoin(t, eq(t.id, s.teamId))
    .where(
      and(
        eq(s.status, "active"),
        eq(s.livemode, catalog.livemode),
        eq(s.cancelAtPeriodEnd, false),
        isNotNull(s.stripeSubscriptionId),
        isNotNull(s.stripeSubscriptionItemId),
        inArray(s.stripePriceId, addOnIds),
      ),
    );

  let repriced = 0;
  for (const { plan, team } of rows) {
    if (team.plan === "system") continue;
    if (hasPaidSendingPlanForMailbox(team, deps.earlyAccessCohort, now)) continue;
    // Still inside Envio's grace (a renewal may be retrying): keep the add-on price.
    if (
      team.currentPeriodEnd &&
      now.getTime() - team.currentPeriodEnd.getTime() < MAILBOX_ADDON_GRACE_MS
    )
      continue;
    const current = catalog.prices.find((price) => price.priceId === plan.stripePriceId);
    const target = catalog.prices.find(
      (price): price is MailboxPriceTerms =>
        standalone.includes(price.priceId) &&
        price.interval === current?.interval &&
        price.currency === current?.currency,
    );
    if (!current || !target || !plan.stripeSubscriptionId || !plan.stripeSubscriptionItemId)
      continue;
    const [open] = await db
      .select({ id: mailboxManagementRequests.id })
      .from(mailboxManagementRequests)
      .where(
        and(
          eq(mailboxManagementRequests.teamId, team.id),
          eq(mailboxManagementRequests.stripeSubscriptionId, plan.stripeSubscriptionId),
          inArray(mailboxManagementRequests.status, OPEN_REQUESTS),
        ),
      )
      .limit(1);
    if (open) continue;
    try {
      const sub = await deps.stripe.subscriptions.retrieve(plan.stripeSubscriptionId, {
        expand: ["items.data.price"],
      });
      const item = sub.items.data[0];
      const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
      if (
        sub.id !== plan.stripeSubscriptionId ||
        sub.status !== "active" ||
        sub.cancel_at_period_end ||
        sub.cancel_at ||
        sub.schedule ||
        sub.pending_update ||
        sub.livemode !== catalog.livemode ||
        customer !== plan.stripeCustomerId ||
        sub.items.data.length !== 1 ||
        !item ||
        item.id !== plan.stripeSubscriptionItemId ||
        item.price.id !== current.priceId
      )
        continue;
      await deps.stripe.subscriptions.update(
        sub.id,
        { items: [{ id: item.id, price: target.priceId }], proration_behavior: "none" },
        { idempotencyKey: `mailbox-reprice:${sub.id}:${target.priceId}` },
      );
      repriced += 1;
      const effectiveAt = item.current_period_end
        ? new Date(item.current_period_end * 1000)
        : plan.periodEnd;
      try {
        await deps.notify?.({
          teamId: team.id,
          stripeSubscriptionId: sub.id,
          seats: item.quantity ?? plan.seats,
          interval: target.interval,
          currency: target.currency,
          fromUnitAmount: current.unitAmount,
          toUnitAmount: target.unitAmount,
          effectiveAt,
        });
      } catch (error) {
        console.error("mailbox.reprice: notice failed", team.id, error);
      }
    } catch (error) {
      console.error(
        "mailbox.reprice: skipped",
        team.id,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { checked: rows.length, repriced };
}
