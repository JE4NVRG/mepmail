import { type SendBillingContract, verifiedSendBillingContract } from "@millionsend/core";
import type Stripe from "stripe";
import { isMeteredPrice, rungFromSubscription } from "./prices.js";

export type { SendBillingContract, SendContractBinding } from "@millionsend/core";
export { verifiedSendBillingContract } from "@millionsend/core";

function secondsToIso(value: number): string | null {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Derive contractual terms only from the retrieved subscription's actual licensed price. */
export function resolveSendBillingContract(
  sub: Stripe.Subscription,
  context: { teamId: string; customerId: string; verifiedAt?: Date },
): SendBillingContract | null {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  if (customer !== context.customerId || !["active", "trialing", "past_due"].includes(sub.status))
    return null;
  const rung = rungFromSubscription(sub);
  const base = sub.items.data.find((item) => !isMeteredPrice(item.price));
  if (!rung || !base || base.quantity !== 1 || base.price.unit_amount === null) return null;
  const start = secondsToIso(base.current_period_start);
  const end = secondsToIso(base.current_period_end);
  const verifiedAt = context.verifiedAt ?? new Date();
  if (start === null || end === null || !Number.isFinite(verifiedAt.getTime())) return null;
  const interval = base.price.recurring?.interval;
  if (interval !== "month" && interval !== "year") return null;
  const contract: SendBillingContract = {
    version: 1,
    teamId: context.teamId,
    customerId: context.customerId,
    subscriptionId: sub.id,
    baseItemId: base.id,
    basePriceId: base.price.id,
    currency: "usd",
    baseAmountCents: base.price.unit_amount,
    billingInterval: interval === "year" ? "year" : "month",
    intervalCount: 1,
    included: rung.included,
    usageInterval: rung.period,
    regularMonthlyCents: interval === "year" ? 2_900 : base.price.unit_amount,
    financialPeriodStart: start,
    financialPeriodEnd: end,
    usageAnchor: start,
    verifiedAt: verifiedAt.toISOString(),
  };
  return verifiedSendBillingContract(contract, {
    teamId: context.teamId,
    customerId: context.customerId,
    subscriptionId: sub.id,
  });
}
