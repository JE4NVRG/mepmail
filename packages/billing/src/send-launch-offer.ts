import type Stripe from "stripe";
import { rungFromPrice } from "./prices.js";
import type { BillingStripe } from "./stripe.js";

export const SEND_LAUNCH_OFFER = "launch_20261006";
export const SEND_INTRO_COUPON = "mepmail_send_launch_20261006_first_month";
export const sendLaunchLookupKey = (interval: "month" | "year") =>
  `mepmail_send_110k_launch_20261006_${interval}`;

/** New immutable offer IDs never transfer the lookup keys of legacy subscriptions. */
export async function resolveSendLaunchPrice(
  stripe: BillingStripe,
  interval: "month" | "year",
  livemode: boolean,
): Promise<Stripe.Price> {
  const lookupKey = sendLaunchLookupKey(interval);
  const page = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 100 });
  const candidates = page.data.filter((price) => price.lookup_key === lookupKey);
  const price = candidates[0];
  if (
    page.has_more ||
    candidates.length !== 1 ||
    !price ||
    !price.active ||
    price.livemode !== livemode ||
    price.metadata?.mepmail_send_offer !== SEND_LAUNCH_OFFER ||
    price.metadata.regular_monthly_cents !== "2900" ||
    price.recurring?.interval !== interval ||
    (price.recurring.interval_count ?? 1) !== 1 ||
    price.recurring.usage_type !== "licensed" ||
    price.currency !== "usd" ||
    price.unit_amount !== (interval === "year" ? 29_000 : 2_900) ||
    rungFromPrice(price)?.included !== 110_000
  )
    throw new Error("Sending launch price does not match the approved offer");
  return price;
}

/** A server-owned one-invoice USD9 discount restricted to the licensed Send product. */
export async function verifySendIntroCoupon(
  stripe: BillingStripe,
  productId: string,
  livemode: boolean,
) {
  if (!stripe.coupons) throw new Error("Sending introductory offer is unavailable");
  const coupon = await stripe.coupons.retrieve(SEND_INTRO_COUPON, { expand: ["applies_to"] });
  if (
    coupon.id !== SEND_INTRO_COUPON ||
    !coupon.valid ||
    coupon.livemode !== livemode ||
    coupon.currency !== "usd" ||
    coupon.amount_off !== 900 ||
    coupon.percent_off !== null ||
    coupon.duration !== "once" ||
    coupon.applies_to?.products?.length !== 1 ||
    coupon.applies_to.products[0] !== productId ||
    coupon.metadata?.mepmail_send_offer !== SEND_LAUNCH_OFFER
  )
    throw new Error("Sending introductory coupon does not match the approved offer");
  return coupon.id;
}
