import {
  isPlanRungKey,
  PAID_RUNGS,
  PLAN_RUNGS,
  type PlanRung,
  rungByKey,
} from "@millionsend/core/plans";
import type Stripe from "stripe";
import type { BillingStripe } from "./stripe.js";

/** Products are found again by this metadata key, never by name (names are free to change). */
export const PRODUCT_METADATA_KEY = "millionsend_plan";
/** Price metadata naming the rung: the durable link from a subscription item back to the ladder. */
export const RUNG_METADATA_KEY = "millionsend_rung";
/** The Stripe meter sends past the included volume are reported to. */
export const METER_EVENT_NAME = "emails_over_quota";

/**
 * Prices are addressed by lookup key so the same code runs against any
 * Stripe account (test/live) without per-environment price ids.
 */
export const rungLookupKey = (rung: PlanRung): string => `millionsend_${rung.key}_monthly`;
export const overageLookupKey = (rung: PlanRung): string => `millionsend_${rung.key}_overage`;

/** The metadata every ladder price carries; the rung key is what the code reads back. */
export function priceMetadata(rung: PlanRung): Record<string, string> {
  return {
    [RUNG_METADATA_KEY]: rung.key,
    plan: rung.plan,
    included_emails: String(rung.included),
    period: rung.period,
    ...(rung.overageCentsPer1k !== null
      ? { overage_cents_per_1k: String(rung.overageCentsPer1k) }
      : {}),
  };
}

/**
 * The active price behind a lookup key. Fetched on every call: checkouts and
 * plan changes are rare and a price rotation must take effect without a
 * restart.
 */
export async function resolvePriceId(stripe: BillingStripe, lookupKey: string): Promise<string> {
  const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true });
  const price = data.find((p) => p.lookup_key === lookupKey);
  if (!price) throw new Error(`Stripe price with lookup key ${lookupKey} not found`);
  return price.id;
}

/** Expansions applySubscription needs on a retrieved subscription: the rung, and a scheduled change. */
export const SUBSCRIPTION_EXPAND = ["items.data.price.product", "schedule.phases.items.price"];

export const isMeteredPrice = (price: Stripe.Price): boolean =>
  price.recurring?.usage_type === "metered";

/**
 * Which rung a price (plan or metered overage) belongs to. The price's own
 * metadata is the durable link; the lookup key covers prices provisioned
 * before metadata was written; and the product's metadata catches a price
 * with neither (a rotated one, or the two sold before the ladder), landing
 * on the plan's first rung.
 */
export function rungIdentityFromPrice(price: Stripe.Price): PlanRung | null {
  const tagged = price.metadata?.[RUNG_METADATA_KEY];
  if (isPlanRungKey(tagged)) return rungByKey(tagged);
  const key = price.lookup_key;
  if (key) {
    const byKey = PLAN_RUNGS.find((r) => rungLookupKey(r) === key || overageLookupKey(r) === key);
    if (byKey) return byKey;
  }
  const product = price.product;
  const plan =
    typeof product === "object" && product !== null && "metadata" in product
      ? product.metadata[PRODUCT_METADATA_KEY]
      : undefined;
  return PAID_RUNGS.find((r) => r.plan === plan) ?? null;
}

/** Resolve identity from the catalog, financial terms only from the subscribed price. */
export function rungFromPrice(price: Stripe.Price): PlanRung | null {
  const rung = rungIdentityFromPrice(price);
  if (!rung) return null;
  const included = positiveMetadataInteger(price.metadata?.included_emails);
  const period = price.metadata?.period;
  if (included === null || (period !== "day" && period !== "month") || period !== rung.period)
    return null;
  if (!isMeteredPrice(price)) {
    const interval = price.recurring?.interval;
    if (
      price.currency !== "usd" ||
      !Number.isSafeInteger(price.unit_amount) ||
      (price.unit_amount ?? 0) <= 0 ||
      price.recurring?.usage_type !== "licensed" ||
      (price.recurring.interval_count ?? 1) !== 1 ||
      (interval !== "month" && interval !== "year")
    )
      return null;
    const offer = price.metadata?.mepmail_send_offer;
    if (offer) {
      if (
        offer !== "launch_20261006" ||
        rung.key !== "pro_100k" ||
        included !== 110_000 ||
        period !== "month" ||
        price.metadata.regular_monthly_cents !== "2900" ||
        price.unit_amount !== (interval === "year" ? 29_000 : 2_900)
      )
        return null;
    } else if (interval === "year") {
      // No historic annual offer is approved; never infer a monthly price from an annual total.
      return null;
    } else if (
      price.metadata?.regular_monthly_cents !== undefined &&
      positiveMetadataInteger(price.metadata.regular_monthly_cents) !== price.unit_amount
    ) {
      return null;
    }
  } else if (effectiveOverageRate(price) === null) {
    return null;
  }
  const rawRate = price.metadata?.overage_cents_per_1k;
  const rate = rawRate && /^\d+$/.test(rawRate) ? Number(rawRate) : null;
  return {
    ...rung,
    priceCents:
      !isMeteredPrice(price) && Number.isSafeInteger(price.unit_amount)
        ? (price.unit_amount as number)
        : rung.priceCents,
    included,
    overageCentsPer1k: isMeteredPrice(price)
      ? effectiveOverageRate(price)
      : rate !== null && Number.isSafeInteger(rate)
        ? rate
        : null,
  };
}

function positiveMetadataInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= 2_147_483_647 ? number : null;
}

/** Unknown/custom transforms must not be presented as the catalog's roundup rate. */
export function effectiveOverageRate(price: Stripe.Price): number | null {
  return price.currency === "usd" &&
    price.recurring?.interval === "month" &&
    price.recurring.usage_type === "metered" &&
    price.transform_quantity?.divide_by === 1000 &&
    price.transform_quantity.round === "up" &&
    Number.isSafeInteger(price.unit_amount) &&
    (price.unit_amount ?? -1) >= 0
    ? price.unit_amount
    : null;
}

/** A subscription's plan item and, when overage is on, its metered item. */
export function subscriptionItems(sub: Stripe.Subscription): {
  base: Stripe.SubscriptionItem | null;
  overage: Stripe.SubscriptionItem | null;
} {
  const items = sub.items.data;
  return {
    base: items.find((i) => !isMeteredPrice(i.price)) ?? null,
    overage: items.find((i) => isMeteredPrice(i.price)) ?? null,
  };
}

export function rungFromSubscription(sub: Stripe.Subscription): PlanRung | null {
  const { base, overage } = subscriptionItems(sub);
  const baseCount = sub.items.data.filter((item) => !isMeteredPrice(item.price)).length;
  const overageCount = sub.items.data.filter((item) => isMeteredPrice(item.price)).length;
  if (baseCount !== 1 || overageCount > 1 || base?.quantity !== 1) return null;
  const rung = base ? rungFromPrice(base.price) : null;
  if (!rung) return null;
  if (base?.price.recurring?.interval === "year" && overage !== null) return null;
  return {
    ...rung,
    overageCentsPer1k:
      overage && rungIdentityFromPrice(overage.price)?.key === rung.key
        ? effectiveOverageRate(overage.price)
        : null,
  };
}

/**
 * The rung a scheduled downgrade moves to when the current phase ends:
 * the plan price of the schedule's last phase, when it differs from the
 * subscription's own. Null without a schedule or when the schedule only
 * mirrors the current plan.
 */
export function pendingRungOf(sub: Stripe.Subscription, current: PlanRung | null): string | null {
  const schedule = sub.schedule;
  if (!schedule || typeof schedule === "string") return null;
  const last = schedule.phases.at(-1);
  if (!last) return null;
  for (const item of last.items) {
    const price = item.price;
    if (typeof price !== "object" || "deleted" in price || isMeteredPrice(price)) continue;
    const rung = rungFromPrice(price);
    return rung && rung.key !== current?.key ? rung.key : null;
  }
  return null;
}
