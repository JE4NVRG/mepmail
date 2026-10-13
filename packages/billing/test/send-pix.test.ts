import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPixSubscription,
  PIX_SESSION_METADATA_KEY,
  type PixPayment,
  type PixStripe,
  readPixPayment,
} from "../src/pix.js";
import {
  beginSendCheckout,
  beginSendPixCheckout,
  fulfillSendPixStart,
} from "../src/send-checkout.js";
import {
  SEND_INTRO_COUPON,
  SEND_LAUNCH_OFFER,
  sendLaunchLookupKey,
} from "../src/send-launch-offer.js";
import { applySubscription, changeRung } from "../src/subscription.js";
import { handleWebhook } from "../src/webhook.js";
import { PERIOD_END, PERIOD_START, price, subscription, webhooks } from "./helpers.js";
import { checkoutFixture } from "./send-checkout-fixture.js";

/** Reais per price, as the live currency_options (stripe-send-brl.mjs). */
const BRL: Record<string, number> = {
  price_launch_month: 14_900,
  price_launch_year: 149_000,
  price_millionsend_pro_200k_monthly: 27_900,
};
const COUPON_BRL = 5_000;

let f: Awaited<ReturnType<typeof checkoutFixture>>;
let launchPrices: Stripe.Price[];
let pix: ReturnType<typeof pixFake>;
const logs: string[] = [];
const log = (m: string) => logs.push(m);

/** In-memory Stripe for the Pix calls, sharing subscriptions with the billing fake. */
function pixFake() {
  const sessions: Record<string, Stripe.Checkout.Session> = {};
  const invoices: Record<string, Stripe.Invoice> = {};
  const created = new Map<string, Stripe.Subscription>();
  const calls = {
    sessions: [] as Stripe.Checkout.SessionCreateParams[],
    subscriptions: [] as Stripe.SubscriptionCreateParams[],
    pays: [] as string[],
    refunds: [] as string[],
    cancels: [] as string[],
    voids: [] as string[],
  };
  /** Overrides what the first invoice bills (a stale fixture), instead of price − coupon. */
  let firstInvoiceAmount: number | null = null;
  const invoice = (id: string) => {
    const found = invoices[id];
    if (!found) throw new Error(`No such invoice: ${id}`);
    return found;
  };
  const priceObject = (id: string) =>
    launchPrices.find((p) => p.id === id) ??
    ({
      ...price(id.replace(/^price_/, ""), { metered: id.endsWith("_overage") }),
      livemode: false,
    } as Stripe.Price);
  const client: PixStripe = {
    prices: {
      retrieve: async (id) =>
        ({
          ...priceObject(id),
          billing_scheme: "per_unit",
          currency_options: BRL[id] ? { brl: { unit_amount: BRL[id] } } : {},
        }) as unknown as Stripe.Price,
    },
    checkout: {
      sessions: {
        create: async (params) => {
          calls.sessions.push(params);
          const id = `cs_pix_${calls.sessions.length}`;
          sessions[id] = {
            id,
            object: "checkout.session",
            mode: params.mode,
            customer: params.customer,
            livemode: false,
            currency: params.line_items?.[0]?.price_data?.currency,
            amount_total: params.line_items?.[0]?.price_data?.unit_amount,
            metadata: params.metadata,
            status: "open",
            payment_status: "unpaid",
            payment_intent: null,
            url: `https://checkout.stripe.com/c/pay/${id}`,
          } as unknown as Stripe.Checkout.Session;
          return sessions[id]!;
        },
        retrieve: async (id) => {
          const found = sessions[id];
          if (!found) throw new Error(`No such session: ${id}`);
          return found;
        },
      },
    },
    subscriptions: {
      create: async (params, options) => {
        const replay = created.get(options?.idempotencyKey ?? "");
        if (replay) return replay;
        calls.subscriptions.push(params);
        const n = calls.subscriptions.length;
        const id = `sub_send_pix_${n}`;
        const invoiceId = `in_send_pix_${n}`;
        const items = (params.items ?? []).map((entry, index) => {
          const p = priceObject(entry.price ?? "");
          const metered = p.recurring?.usage_type === "metered";
          return {
            id: index === 0 ? `si_${id}` : `si_${id}_overage`,
            object: "subscription_item",
            current_period_start: PERIOD_START,
            current_period_end: PERIOD_END,
            price: p,
            ...(metered ? {} : { quantity: entry.quantity ?? 1 }),
          };
        });
        const sub = {
          id,
          object: "subscription",
          customer: params.customer,
          status: "active",
          livemode: false,
          created: PERIOD_START - 50,
          collection_method: params.collection_method,
          currency: params.currency,
          metadata: params.metadata,
          cancel_at: null,
          schedule: null,
          latest_invoice: invoiceId,
          items: { object: "list", data: items },
        } as unknown as Stripe.Subscription;
        const base = BRL[params.items?.[0]?.price ?? ""] ?? 0;
        const amount = firstInvoiceAmount ?? base - (params.discounts?.length ? COUPON_BRL : 0);
        invoices[invoiceId] = {
          id: invoiceId,
          object: "invoice",
          customer: params.customer,
          currency: "brl",
          status: "draft",
          collection_method: "send_invoice",
          amount_remaining: amount,
          amount_due: amount,
          metadata: {},
          created: PERIOD_START,
          due_date: PERIOD_START + 5 * 86_400,
          parent: { subscription_details: { subscription: id, metadata: params.metadata } },
          lines: { data: [] },
        } as unknown as Stripe.Invoice;
        f.state.subscriptions[id] = sub;
        created.set(options?.idempotencyKey ?? "", sub);
        return sub;
      },
      list: async (params) =>
        ({
          object: "list",
          has_more: false,
          data: Object.values(f.state.subscriptions).filter((s) => s.customer === params.customer),
        }) as Stripe.ApiList<Stripe.Subscription>,
      cancel: async (id) => {
        calls.cancels.push(id);
        const sub = f.state.subscriptions[id]!;
        sub.status = "canceled";
        return sub;
      },
    },
    invoices: {
      retrieve: async (id) => invoice(id),
      list: async () => ({ object: "list", has_more: false, data: [] }) as never,
      finalizeInvoice: async (id) => {
        const found = invoice(id);
        found.status = "open";
        return found;
      },
      update: async (id, params) => {
        const found = invoice(id);
        found.metadata = { ...found.metadata, ...(params.metadata as Stripe.Metadata) };
        return found;
      },
      pay: async (id) => {
        calls.pays.push(id);
        const found = invoice(id);
        if (found.status !== "open") throw new Error("Invoice is not open");
        found.status = "paid";
        found.amount_remaining = 0;
        return found;
      },
      voidInvoice: async (id) => {
        calls.voids.push(id);
        const found = invoice(id);
        found.status = "void";
        return found;
      },
    },
    refunds: {
      create: async (params) => {
        calls.refunds.push(String((params.metadata as Stripe.Metadata)?.mepmail_pix_refund));
        return { id: `re_${calls.refunds.length}`, object: "refund" } as Stripe.Refund;
      },
    },
  };
  /** The customer pays the Pix: Checkout completes with its PaymentIntent. */
  const pay = (id: string) => {
    const session = sessions[id]!;
    session.status = "complete";
    session.payment_status = "paid";
    session.payment_intent = `pi_${id}`;
  };
  return {
    client,
    sessions,
    invoices,
    calls,
    pay,
    billFirstInvoice: (amount: number) => {
      firstInvoiceAmount = amount;
    },
  };
}

beforeEach(async () => {
  f = await checkoutFixture();
  launchPrices = (["month", "year"] as const).map(
    (interval) =>
      ({
        ...price("millionsend_pro_100k_monthly"),
        id: `price_launch_${interval}`,
        lookup_key: sendLaunchLookupKey(interval),
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
  const coupon = {
    id: SEND_INTRO_COUPON,
    valid: true,
    livemode: false,
    currency: "usd",
    amount_off: 900,
    percent_off: null,
    duration: "once",
    applies_to: { products: ["prod_send_launch"] },
    currency_options: { brl: { amount_off: COUPON_BRL } },
    metadata: { mepmail_send_offer: SEND_LAUNCH_OFFER },
  } as unknown as Stripe.Coupon;
  f.stripe.coupons = { retrieve: async () => coupon };
  f.stripe.invoices = {
    retrieve: async () => {
      throw new Error("not used");
    },
    list: async () => ({ data: [], has_more: false }) as unknown as Stripe.ApiList<Stripe.Invoice>,
  };
  pix = pixFake();
  logs.length = 0;
});
afterEach(async () => f.close());

const deps = () => ({ ...f.deps, launchOfferEnabled: true });
const begin = (interval: "month" | "year" = "month", rung = f.input.rung) =>
  beginSendPixCheckout(deps(), pix.client, { ...f.input, interval, rung });
const paid = async (interval: "month" | "year" = "month"): Promise<PixPayment> => {
  await begin(interval);
  const id = Object.keys(pix.sessions).at(-1)!;
  pix.pay(id);
  const payment = await readPixPayment(pix.client, id, false);
  if (typeof payment === "string") throw new Error(payment);
  return payment;
};
const fulfill = (payment: PixPayment) =>
  f.db.transaction((tx) =>
    fulfillSendPixStart(tx as unknown as Db, f.deps, pix.client, payment, log),
  );
const teamRow = async () =>
  (await f.db.select().from(schema.teams).where(eq(schema.teams.id, f.input.team.id)))[0]!;

describe("Send paid by Pix", () => {
  it("opens a one-time Pix in reais for the launch month, the intro discount included", async () => {
    const { url } = await begin();
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(pix.calls.sessions).toHaveLength(1);
    expect(pix.calls.sessions[0]).toMatchObject({
      mode: "payment",
      payment_method_types: ["pix"],
      line_items: [{ quantity: 1, price_data: { currency: "brl", unit_amount: 9_900 } }],
      metadata: {
        mepmail_pix: "send_start",
        team_id: f.input.team.id,
        mepmail_pix_price: "price_launch_month",
        mepmail_pix_quantity: "1",
        mepmail_pix_interval: "month",
        mepmail_pix_overage: "price_millionsend_pro_100k_overage",
        mepmail_pix_coupon: SEND_INTRO_COUPON,
      },
    });
    // Nothing is granted and no card Checkout is opened before the Pix is paid.
    expect(f.state.checkouts).toEqual([]);
    expect(pix.calls.subscriptions).toEqual([]);
    expect((await teamRow()).plan).toBe("free");
  });

  it("charges the year in one Pix, without overage or intro discount", async () => {
    await begin("year");
    expect(pix.calls.sessions[0]).toMatchObject({
      line_items: [{ price_data: { currency: "brl", unit_amount: 149_000 } }],
      metadata: { mepmail_pix_price: "price_launch_year", mepmail_pix_interval: "year" },
    });
    expect(pix.calls.sessions[0]?.metadata).not.toHaveProperty("mepmail_pix_overage");
    expect(pix.calls.sessions[0]?.metadata).not.toHaveProperty("mepmail_pix_coupon");
  });

  it("refuses a rung without a price in reais", async () => {
    await expect(begin("month", "scale_500k")).rejects.toMatchObject({ code: "invalid" });
    expect(pix.calls.sessions).toEqual([]);
  });

  it("starts the plan as a send_invoice subscription in reais whose first invoice the Pix pays", async () => {
    const payment = await paid();
    expect(await fulfill(payment)).toBe("fulfilled");
    expect(await fulfill(payment)).toBe("fulfilled");
    expect(pix.calls.subscriptions).toHaveLength(1);
    expect(pix.calls.subscriptions[0]).toMatchObject({
      currency: "brl",
      collection_method: "send_invoice",
      days_until_due: 5,
      payment_settings: { payment_method_types: ["card"] },
      items: [
        { price: "price_launch_month", quantity: 1 },
        { price: "price_millionsend_pro_100k_overage" },
      ],
      discounts: [{ coupon: SEND_INTRO_COUPON }],
      metadata: {
        team_id: f.input.team.id,
        mepmail_send_interval: "month",
        mepmail_collection: "pix",
        [PIX_SESSION_METADATA_KEY]: payment.sessionId,
      },
    });
    expect(pix.calls.pays).toEqual(["in_send_pix_1"]);
    expect(pix.invoices.in_send_pix_1?.status).toBe("paid");
    expect(pix.calls.refunds).toEqual([]);
    const sub = f.state.subscriptions.sub_send_pix_1!;
    expect(isPixSubscription(sub)).toBe(true);
    // The subscription events that follow grant the plan like a card purchase.
    await applySubscription(f.db, sub, log, f.stripe);
    expect(await teamRow()).toMatchObject({
      plan: "pro",
      planQuota: 110_000,
      planStatus: "active",
      stripeSubscriptionId: sub.id,
    });
  });

  it("lapses an overdue Pix plan to Free and restores it once the invoice is paid", async () => {
    await fulfill(await paid());
    const sub = f.state.subscriptions.sub_send_pix_1!;
    await applySubscription(f.db, sub, log, f.stripe);
    sub.status = "past_due";
    await applySubscription(f.db, sub, log, f.stripe);
    expect(await teamRow()).toMatchObject({
      plan: "free",
      planQuota: null,
      planStatus: "past_due",
      sendBillingContract: null,
      stripeOverageItemId: null,
    });
    sub.status = "active";
    await applySubscription(f.db, sub, log, f.stripe);
    expect(await teamRow()).toMatchObject({ plan: "pro", planQuota: 110_000 });
  });

  it("keeps a card plan's dunning grace on past due", async () => {
    const card = subscription("sub_card", "cus_card", "active", "millionsend_pro_100k_monthly", {
      overageKey: "millionsend_pro_100k_overage",
    });
    await f.db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_card" })
      .where(eq(schema.teams.id, f.input.team.id));
    f.state.subscriptions[card.id] = card;
    await applySubscription(f.db, card, log, f.stripe);
    card.status = "past_due";
    await applySubscription(f.db, card, log, f.stripe);
    expect(await teamRow()).toMatchObject({ plan: "pro", planStatus: "past_due" });
  });

  it("refunds a Pix that arrives after another Send subscription started", async () => {
    const payment = await paid();
    f.state.subscriptions.sub_card = {
      ...subscription("sub_card", payment.customerId, "active"),
      livemode: false,
    } as Stripe.Subscription;
    expect(await fulfill(payment)).toBe("refunded");
    expect(pix.calls.subscriptions).toEqual([]);
    expect(pix.calls.refunds).toEqual(["occupied"]);
  });

  it("refunds a Pix when the card Checkout of the same team was paid first", async () => {
    await beginSendCheckout(deps(), f.input);
    const payment = await paid();
    for (const session of f.sessions.values()) session.status = "complete";
    expect(await fulfill(payment)).toBe("refunded");
    expect(pix.calls.refunds).toEqual(["occupied"]);
    const attempts = await f.db.select().from(schema.sendCheckoutAttempts);
    expect(attempts.map((a) => a.status)).toEqual(["resolved"]);
  });

  it("closes an open card Checkout of the team before starting the Pix plan", async () => {
    await beginSendCheckout(deps(), f.input);
    const payment = await paid();
    const sessions = f.stripe.checkout.sessions as typeof f.stripe.checkout.sessions & {
      expire?: (id: string) => Promise<Stripe.Checkout.Session>;
    };
    const expired: string[] = [];
    sessions.expire = async (id) => {
      expired.push(id);
      const session = [...f.sessions.values()].find((s) => s.id === id)!;
      session.status = "expired";
      return session;
    };
    expect(await fulfill(payment)).toBe("fulfilled");
    expect(expired).toEqual(["cs_1"]);
    const attempts = await f.db.select().from(schema.sendCheckoutAttempts);
    expect(attempts.map((a) => a.status)).toEqual(["resolved"]);
  });

  it("refunds a Pix whose amount is not the price in reais anymore", async () => {
    const payment = await paid();
    expect(await fulfill({ ...payment, amount: 14_900 })).toBe("refunded");
    expect(pix.calls.subscriptions).toEqual([]);
    expect(pix.calls.refunds).toEqual(["amount"]);
  });

  it("undoes the start when the first invoice is not the Pix amount", async () => {
    const payment = await paid();
    pix.billFirstInvoice(14_900);
    expect(await fulfill(payment)).toBe("refunded");
    expect(pix.calls.cancels).toEqual(["sub_send_pix_1"]);
    expect(pix.calls.voids).toEqual(["in_send_pix_1"]);
    expect(pix.calls.pays).toEqual([]);
    expect(pix.calls.refunds).toEqual(["invoice"]);
  });

  it("refunds a payment for another team", async () => {
    const payment = await paid();
    expect(await fulfill({ ...payment, teamId: "00000000-0000-4000-8000-000000000000" })).toBe(
      "refunded",
    );
    expect(pix.calls.refunds).toEqual(["team"]);
  });

  it("starts the plan from the webhook once Stripe reports the Pix paid", async () => {
    await begin();
    const sessionId = Object.keys(pix.sessions).at(-1)!;
    const deliver = (type: string, id: string) => {
      const payload = JSON.stringify({
        id,
        object: "event",
        type,
        livemode: false,
        data: {
          object: {
            id: sessionId,
            object: "checkout.session",
            mode: "payment",
            metadata: pix.sessions[sessionId]?.metadata,
          },
        },
      });
      return handleWebhook(
        payload,
        webhooks.generateTestHeaderString({ payload, secret: "whsec_pix" }),
        {
          db: f.db,
          stripe: f.stripe,
          webhookSecret: "whsec_pix",
          livemode: false,
          pixStripe: pix.client,
          log,
        },
      );
    };
    // Completed but not paid yet: nothing starts.
    await deliver("checkout.session.completed", "evt_pix_completed");
    expect(pix.calls.subscriptions).toEqual([]);
    pix.pay(sessionId);
    await deliver("checkout.session.async_payment_succeeded", "evt_pix_paid");
    expect(pix.calls.subscriptions).toHaveLength(1);
    expect(pix.invoices.in_send_pix_1?.status).toBe("paid");
    expect(logs.some((line) => line.includes(`pix ${sessionId}: fulfilled`))).toBe(true);
  });

  it("moves a Pix plan to another rung only by a new purchase", async () => {
    await fulfill(await paid());
    const sub = f.state.subscriptions.sub_send_pix_1!;
    await applySubscription(f.db, sub, log, f.stripe);
    await expect(
      changeRung({ db: f.db, stripe: f.stripe }, { teamId: f.input.team.id, rung: "pro_200k" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.state.updates).toEqual([]);
  });
});
