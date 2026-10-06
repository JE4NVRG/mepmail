import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginSendCheckout } from "../src/send-checkout.js";
import {
  SEND_INTRO_COUPON,
  SEND_LAUNCH_OFFER,
  sendLaunchLookupKey,
} from "../src/send-launch-offer.js";
import { price, subscription } from "./helpers.js";
import { checkoutFixture } from "./send-checkout-fixture.js";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
let coupon: Stripe.Coupon;
let launchPrices: Stripe.Price[];
beforeEach(async () => {
  f = await checkoutFixture();
  launchPrices = ["month", "year"].map(
    (interval) =>
      ({
        ...price("millionsend_pro_100k_monthly"),
        id: `price_launch_${interval}`,
        lookup_key: sendLaunchLookupKey(interval as "month" | "year"),
        livemode: false,
        product: "prod_send_launch",
        unit_amount: interval === "year" ? 29000 : 2900,
        metadata: {
          millionsend_rung: "pro_100k",
          plan: "pro",
          included_emails: "110000",
          period: "month",
          regular_monthly_cents: "2900",
          mepmail_send_offer: SEND_LAUNCH_OFFER,
        },
        recurring: { interval, interval_count: 1, usage_type: "licensed" },
      }) as unknown as Stripe.Price,
  );
  const oldList = f.stripe.prices.list;
  f.stripe.prices.list = async (params) =>
    params.lookup_keys?.[0]?.startsWith("mepmail_send_")
      ? ({
          data: launchPrices.filter((p) => params.lookup_keys?.includes(p.lookup_key!)),
          has_more: false,
        } as Stripe.ApiList<Stripe.Price>)
      : oldList(params).then((page) => ({
          ...page,
          data: page.data.map((p) => ({ ...p, livemode: false })),
        }));
  coupon = {
    id: SEND_INTRO_COUPON,
    valid: true,
    livemode: false,
    currency: "usd",
    amount_off: 900,
    percent_off: null,
    duration: "once",
    applies_to: { products: ["prod_send_launch"] },
    metadata: { mepmail_send_offer: SEND_LAUNCH_OFFER },
  } as unknown as Stripe.Coupon;
  f.stripe.coupons = { retrieve: async () => coupon };
  f.stripe.invoices = {
    retrieve: async () => {
      throw new Error("not used");
    },
    list: async () => ({ data: [], has_more: false }) as unknown as Stripe.ApiList<Stripe.Invoice>,
  };
});
afterEach(async () => f.close());
const deps = () => ({ ...f.deps, launchOfferEnabled: true });
const parameters = () => f.state.checkouts[0]!;

describe("approved launch offer", () => {
  it("new monthly subscriber pays20 once on the29 licensed base only; retry preserves intent", async () => {
    const first = await beginSendCheckout(deps(), f.input);
    expect(parameters().line_items?.[0]).toEqual({ price: "price_launch_month", quantity: 1 });
    expect(parameters().line_items).toHaveLength(2);
    expect(parameters().discounts).toEqual([{ coupon: SEND_INTRO_COUPON }]);
    expect(parameters().allow_promotion_codes).toBeUndefined();
    expect(await beginSendCheckout(deps(), f.input)).toEqual(first);
    expect(f.state.checkouts).toHaveLength(1);
  });
  it("annual290 has one item, twelve monthly allowances, no introductory or metered discount", async () => {
    await beginSendCheckout(deps(), { ...f.input, interval: "year" });
    expect(parameters().line_items).toEqual([{ price: "price_launch_year", quantity: 1 }]);
    expect(parameters().discounts).toBeUndefined();
    expect(parameters().allow_promotion_codes).toBeUndefined();
    expect(parameters().metadata?.mepmail_send_intro).toBe("none");
    await expect(beginSendCheckout(deps(), f.input)).rejects.toMatchObject({ code: "conflict" });
  });
  it("paid history forbids intro but permits the regular new monthly offer", async () => {
    f.stripe.invoices!.list = async () =>
      ({ data: [{ id: "in_paid" }], has_more: false }) as Stripe.ApiList<Stripe.Invoice>;
    await beginSendCheckout(deps(), f.input);
    expect(parameters().discounts).toBeUndefined();
    expect(parameters().metadata?.mepmail_send_intro).toBe("none");
  });
  it("canceling and buying again never restores introductory eligibility", async () => {
    f.stripe.subscriptions.list = async () =>
      ({
        data: [{ ...subscription("sub_previous", "cus_1", "canceled"), livemode: false }],
        has_more: false,
      }) as Stripe.ApiList<Stripe.Subscription>;
    await beginSendCheckout(deps(), f.input);
    expect(parameters().discounts).toBeUndefined();
  });
  it("fails closed if purchase history cannot be verified", async () => {
    delete f.stripe.invoices;
    await expect(beginSendCheckout(deps(), f.input)).rejects.toMatchObject({ code: "unknown" });
    expect(f.state.checkouts).toEqual([]);
  });
  it.each([
    { amount_off: 1000 },
    { duration: "forever" },
    { currency: "brl" },
    { livemode: true },
    { applies_to: { products: ["prod_mailboxes"] } },
    { applies_to: { products: ["prod_send_launch", "prod_other"] } },
  ])("refuses altered or broader coupon terms %j", async (patch) => {
    Object.assign(coupon, patch);
    await expect(beginSendCheckout(deps(), f.input)).rejects.toThrow();
    expect(f.state.checkouts).toEqual([]);
  });
  it.each([
    { unit_amount: 2000 },
    { livemode: true },
    { currency: "brl" },
    { metadata: { mepmail_send_offer: SEND_LAUNCH_OFFER } },
  ])("refuses wrong signed price %j", async (patch) => {
    Object.assign(launchPrices[0]!, patch);
    await expect(beginSendCheckout(deps(), f.input)).rejects.toThrow();
    expect(f.state.checkouts).toEqual([]);
  });
  it("never stacks the coupon onto the overage product", async () => {
    launchPrices[0]!.product = "prod_1";
    await expect(beginSendCheckout(deps(), f.input)).rejects.toMatchObject({ code: "invalid" });
    expect(f.state.checkouts).toEqual([]);
  });
  it.each([
    { unit_amount: 500 },
    { currency: "brl" },
    { recurring: { interval: "year", usage_type: "metered" } },
    { recurring: { interval: "month", usage_type: "licensed" } },
  ])("rejects incompatible overage before checkout %j", async (patch) => {
    const list = f.stripe.prices.list;
    f.stripe.prices.list = async (params) => {
      const page = await list(params);
      return params.lookup_keys?.[0]?.endsWith("_overage")
        ? { ...page, data: page.data.map((p) => ({ ...p, ...patch }) as Stripe.Price) }
        : page;
    };
    await expect(beginSendCheckout(deps(), f.input)).rejects.toMatchObject({ code: "invalid" });
    expect(f.state.checkouts).toEqual([]);
  });
  it("lost provider response retries the same frozen prices and discount", async () => {
    f.loseSession();
    f.hideSessions();
    await expect(beginSendCheckout(deps(), f.input)).rejects.toMatchObject({ code: "unknown" });
    const [attempt] = await f.db.select().from(schema.sendCheckoutAttempts);
    await f.db
      .update(schema.sendCheckoutAttempts)
      .set({ leaseUntil: null })
      .where(eq(schema.sendCheckoutAttempts.id, attempt!.id));
    f.stripe.prices.list = async () => {
      throw new Error("catalog changed");
    };
    f.stripe.coupons!.retrieve = async () => {
      throw new Error("coupon changed");
    };
    f.loseSession(false);
    await beginSendCheckout(deps(), f.input);
    const posts = f.posts.filter((p) => p.kind === "session");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
  });
  it("legacy checkout uses its own unchanged IDs and rejects unapproved annual", async () => {
    await expect(beginSendCheckout(f.deps, { ...f.input, interval: "year" })).rejects.toMatchObject(
      { code: "invalid" },
    );
    await beginSendCheckout(f.deps, f.input);
    expect(parameters().line_items?.[0]?.price).toBe("price_millionsend_pro_100k_monthly");
  });
});
