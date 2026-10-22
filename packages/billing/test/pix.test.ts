import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MailboxBillingStripe, MailboxCatalog, MailboxPriceTerms } from "../src/mailbox.js";
import {
  applyMailboxSubscription,
  beginMailboxPixCheckout,
  fulfillMailboxPixStart,
} from "../src/mailbox-lifecycle.js";
import {
  beginPixInvoicePayment,
  isPixSubscription,
  openPixInvoices,
  PIX_SESSION_METADATA_KEY,
  type PixPayment,
  type PixStripe,
  pixSessionOf,
  readPixPayment,
  settlePixInvoice,
} from "../src/pix.js";
import { fakeStripe, PERIOD_END, PERIOD_START } from "./helpers.js";

const CUSTOMER = "cus_pix_fixture";
const USER = "pix_buyer";
const GiB = 1024 ** 3;
const SOLO: MailboxPriceTerms = {
  priceId: "price_mailbox_solo_fixture",
  currency: "usd",
  unitAmount: 290,
  interval: "month",
  storageBytesPerMailbox: GiB,
  includedOutboundPerMailbox: 500,
  quotaScope: "team",
  includedMailboxes: 1,
  trialDays: 7,
  localCurrency: { currency: "brl", unitAmount: 1490 },
  planCode: "solo",
  inboundDeliveriesPerPeriod: 2000,
  inboundBytesPerPeriod: GiB / 2,
  outboundBytesPerPeriod: GiB / 4,
};
const CATALOG: MailboxCatalog = {
  livemode: false,
  checkoutPriceId: SOLO.priceId,
  standalonePriceIds: [SOLO.priceId],
  prices: [SOLO],
};
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const urls = {
  successUrl: "https://app.example.com/mailboxes?checkout=success",
  cancelUrl: "https://app.example.com/mailboxes",
};

/** In-memory Stripe for the Pix calls, sharing subscriptions with the billing fake. */
function pixFake(subscriptions: Record<string, Stripe.Subscription>, brl: number | null = 1490) {
  const sessions: Record<string, Stripe.Checkout.Session> = {};
  const invoices: Record<string, Stripe.Invoice> = {};
  const created = new Map<string, Stripe.Subscription>();
  const calls = {
    sessions: [] as Stripe.Checkout.SessionCreateParams[],
    subscriptions: [] as Stripe.SubscriptionCreateParams[],
    pays: [] as [string, Stripe.InvoicePayParams | undefined][],
    refunds: [] as [Stripe.RefundCreateParams, Stripe.RequestOptions | undefined][],
    cancels: [] as string[],
    voids: [] as string[],
  };
  const invoice = (id: string) => {
    const found = invoices[id];
    if (!found) throw new Error(`No such invoice: ${id}`);
    return found;
  };
  /** The PaymentIntent of a paid session, as Stripe would return it; tests may override fields. */
  const paymentIntentOverrides: Record<string, Partial<Stripe.PaymentIntent>> = {};
  const paymentIntentOf = async (id: string) => {
    const session = Object.values(sessions).find((s) => s.payment_intent === id);
    if (!session) throw new Error(`No such payment_intent: ${id}`);
    return {
      id,
      object: "payment_intent",
      livemode: false,
      status: "succeeded",
      currency: "brl",
      amount: session.amount_total,
      amount_received: session.amount_total,
      customer: session.customer,
      metadata: session.metadata,
      ...paymentIntentOverrides[id],
    } as unknown as Stripe.PaymentIntent;
  };
  const pix: PixStripe = {
    prices: {
      retrieve: async (id) =>
        ({
          id,
          object: "price",
          active: true,
          billing_scheme: "per_unit",
          currency: "usd",
          unit_amount: 290,
          product: "prod_correio",
          currency_options: brl === null ? {} : { brl: { unit_amount: brl } },
        }) as unknown as Stripe.Price,
    },
    checkout: {
      sessions: {
        create: async (params) => {
          calls.sessions.push(params);
          const id = `cs_pix_${calls.sessions.length}`;
          const session = {
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
          sessions[id] = session;
          return session;
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
        const key = options?.idempotencyKey ?? "";
        const replay = created.get(key);
        if (replay) return replay;
        calls.subscriptions.push(params);
        const id = `sub_pix_${calls.subscriptions.length}`;
        const invoiceId = `in_pix_${calls.subscriptions.length}`;
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
          cancel_at_period_end: false,
          latest_invoice: invoiceId,
          items: {
            object: "list",
            data: [
              {
                id: `si_${id}`,
                object: "subscription_item",
                quantity: params.items?.[0]?.quantity,
                current_period_start: PERIOD_START,
                current_period_end: PERIOD_END,
                price: {
                  id: params.items?.[0]?.price,
                  object: "price",
                  active: true,
                  currency: SOLO.currency,
                  unit_amount: SOLO.unitAmount,
                  billing_scheme: "per_unit",
                  transform_quantity: null,
                  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
                  product: "prod_correio",
                },
              },
            ],
          },
        } as unknown as Stripe.Subscription;
        invoices[invoiceId] = {
          id: invoiceId,
          object: "invoice",
          customer: params.customer,
          currency: "brl",
          status: "draft",
          collection_method: "send_invoice",
          amount_remaining: brl ?? 0,
          metadata: {},
          created: PERIOD_START,
          due_date: PERIOD_START + 5 * 86_400,
          parent: { subscription_details: { subscription: id, metadata: params.metadata } },
          lines: { data: [{ pricing: { price_details: { product: "prod_correio" } } }] },
        } as unknown as Stripe.Invoice;
        subscriptions[id] = sub;
        created.set(key, sub);
        return sub;
      },
      list: async (params) =>
        ({
          object: "list",
          has_more: false,
          data: Object.values(subscriptions).filter((s) => s.customer === params.customer),
        }) as Stripe.ApiList<Stripe.Subscription>,
      cancel: async (id) => {
        calls.cancels.push(id);
        const sub = subscriptions[id]!;
        sub.status = "canceled";
        return sub;
      },
    },
    invoices: {
      retrieve: async (id) => invoice(id),
      list: async (params) =>
        ({
          object: "list",
          has_more: false,
          data: Object.values(invoices).filter(
            (i) => i.customer === params.customer && (!params.status || i.status === params.status),
          ),
        }) as Stripe.ApiList<Stripe.Invoice>,
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
      pay: async (id, params) => {
        calls.pays.push([id, params]);
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
    paymentIntents: {
      retrieve: async (id) => paymentIntentOf(id),
    },
    refunds: {
      create: async (params, options) => {
        calls.refunds.push([params, options]);
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
  return { pix, sessions, invoices, calls, pay };
}

describe("Pix", () => {
  let db: Db;
  let close: () => Promise<void>;
  let stripe: MailboxBillingStripe;
  let state: ReturnType<typeof fakeStripe>["state"];
  let fake: ReturnType<typeof pixFake>;
  let teamId: string;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const begin = () =>
    beginMailboxPixCheckout({ db, stripe }, fake.pix, CATALOG, { teamId, userId: USER, ...urls });
  const paidPayment = async () => {
    await begin();
    const id = Object.keys(fake.sessions).at(-1)!;
    fake.pay(id);
    const payment = await readPixPayment(fake.pix, id, false);
    if (typeof payment === "string") throw new Error(payment);
    return payment;
  };
  const fulfill = (payment: PixPayment) =>
    db.transaction((tx) =>
      fulfillMailboxPixStart(tx as unknown as Db, stripe, fake.pix, CATALOG, payment, log),
    );
  const plan = async () =>
    (
      await db
        .select()
        .from(schema.mailboxSubscriptions)
        .where(eq(schema.mailboxSubscriptions.teamId, teamId))
    )[0];

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    for (const name of readdirSync(extension)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      for (const statement of readFileSync(extension + name, "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean))
        await db.execute(sql.raw(statement));
    }
    ({ stripe, state } = fakeStripe());
    fake = pixFake(state.subscriptions);
    teamId = await createTeam(db);
    await db.insert(schema.domains).values({
      teamId,
      name: "pix.example.test",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    });
    await db.insert(schema.user).values({ id: USER, name: "Pix buyer", email: "pix@example.com" });
    await db.insert(schema.teamMembers).values({ teamId, userId: USER, role: "owner" });
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: CUSTOMER })
      .where(eq(schema.teams.id, teamId));
    logs.length = 0;
  });
  afterEach(async () => {
    await close();
  });

  it.each(["unverified", "review"] as const)(
    "refuses a Correio Pix with an %s domain before any payment request",
    async (domainState) => {
      await db
        .update(schema.domains)
        .set(domainState === "unverified" ? { status: "pending" } : { name: "pix.online" })
        .where(eq(schema.domains.teamId, teamId));
      await expect(begin()).rejects.toMatchObject({
        code: domainState === "unverified" ? "domain_required" : "domain_review",
      });
      expect(state.calls).toEqual([]);
      expect(fake.calls.sessions).toEqual([]);
      expect(fake.calls.subscriptions).toEqual([]);
    },
  );

  it("rechecks the domain after pricing and before creating a Correio Pix", async () => {
    const retrieve = fake.pix.prices.retrieve;
    fake.pix.prices.retrieve = async (id, options) => {
      const price = await retrieve(id, options);
      await db
        .update(schema.domains)
        .set({ status: "failed" })
        .where(eq(schema.domains.teamId, teamId));
      return price;
    };
    await expect(begin()).rejects.toMatchObject({ code: "domain_required" });
    expect(fake.calls.sessions).toEqual([]);
    expect(fake.calls.subscriptions).toEqual([]);
  });

  it("opens a one-time Pix Checkout in reais for the first month of a plan", async () => {
    const { url } = await begin();
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [params] = fake.calls.sessions;
    expect(params).toMatchObject({
      mode: "payment",
      customer: CUSTOMER,
      payment_method_types: ["pix"],
      line_items: [
        {
          quantity: 1,
          price_data: { currency: "brl", unit_amount: 1490, product: "prod_correio" },
        },
      ],
      metadata: {
        mepmail_pix: "mailbox_start",
        team_id: teamId,
        mepmail_pix_price: SOLO.priceId,
        mepmail_pix_quantity: "1",
      },
    });
    // Nothing is granted, and no card Checkout lease is taken, before the Pix is paid.
    expect(await plan()).toBeUndefined();
    expect(await db.select().from(schema.mailboxCheckouts)).toEqual([]);
    expect(fake.calls.subscriptions).toEqual([]);
  });

  it("sells only monthly plans priced in reais", async () => {
    const perMailbox: MailboxPriceTerms = {
      priceId: "price_per_mailbox",
      currency: "usd",
      unitAmount: 990,
      interval: "month",
      storageBytesPerMailbox: GiB,
      includedOutboundPerMailbox: 100,
    };
    await expect(
      beginMailboxPixCheckout(
        { db, stripe },
        fake.pix,
        { ...CATALOG, checkoutPriceId: perMailbox.priceId, prices: [perMailbox] },
        { teamId, userId: USER, ...urls },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    fake = pixFake(state.subscriptions, null);
    await expect(begin()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("reads a session as pending until the Pix is paid", async () => {
    await begin();
    expect(await readPixPayment(fake.pix, "cs_pix_1", false)).toBe("pending");
    expect(await readPixPayment(fake.pix, "cs_pix_1", true)).toBe("invalid");
    fake.pay("cs_pix_1");
    expect(await readPixPayment(fake.pix, "cs_pix_1", false)).toMatchObject({
      kind: "mailbox_start",
      teamId,
      customerId: CUSTOMER,
      amount: 1490,
      paymentIntentId: "pi_cs_pix_1",
      priceId: SOLO.priceId,
      quantity: 1,
    });
  });

  it("starts a send_invoice subscription in reais whose first invoice the Pix pays", async () => {
    const payment = await paidPayment();
    expect(await fulfill(payment)).toBe("fulfilled");
    const [params] = fake.calls.subscriptions;
    expect(params).toMatchObject({
      customer: CUSTOMER,
      items: [{ price: SOLO.priceId, quantity: 1 }],
      currency: "brl",
      collection_method: "send_invoice",
      days_until_due: 5,
      payment_settings: { payment_method_types: ["card"] },
      metadata: {
        mepmail_service: "mailbox",
        team_id: teamId,
        mepmail_collection: "pix",
        [PIX_SESSION_METADATA_KEY]: payment.sessionId,
      },
    });
    expect(fake.calls.pays).toEqual([["in_pix_1", { paid_out_of_band: true }]]);
    expect(fake.invoices.in_pix_1).toMatchObject({
      status: "paid",
      metadata: {
        [PIX_SESSION_METADATA_KEY]: payment.sessionId,
        mepmail_pix_payment: "pi_cs_pix_1",
      },
    });
    const sub = state.subscriptions.sub_pix_1!;
    expect(isPixSubscription(sub)).toBe(true);
    // The subscription events that follow grant the plan like a card purchase.
    expect(await applyMailboxSubscription(db, sub, CATALOG, PERIOD_START + 10)).toMatchObject({
      applied: true,
    });
    expect(await plan()).toMatchObject({ status: "active", planCode: "solo", seats: 1 });
  });

  it("is idempotent per Checkout session", async () => {
    const payment = await paidPayment();
    expect(await fulfill(payment)).toBe("fulfilled");
    expect(await fulfill(payment)).toBe("fulfilled");
    expect(fake.calls.subscriptions).toHaveLength(1);
    expect(fake.calls.pays).toHaveLength(1);
    expect(fake.calls.refunds).toEqual([]);
  });

  it("refunds a Pix that arrives when the team already has Correio", async () => {
    const payment = await paidPayment();
    await db.insert(schema.mailboxSubscriptions).values({
      teamId,
      status: "active",
      seats: 1,
      storageBytesPerMailbox: GiB,
      includedOutboundPerMailbox: 500,
      periodStart: new Date(PERIOD_START * 1000),
      periodEnd: new Date(PERIOD_END * 1000),
    });
    expect(await fulfill(payment)).toBe("refunded");
    expect(fake.calls.subscriptions).toEqual([]);
    expect(fake.calls.refunds).toEqual([
      [
        expect.objectContaining({ payment_intent: "pi_cs_pix_1" }),
        { idempotencyKey: "pix-refund:pi_cs_pix_1" },
      ],
    ]);
  });

  it("refunds a Pix whose amount no longer matches the price", async () => {
    const payment = await paidPayment();
    expect(await fulfill({ ...payment, amount: 990 })).toBe("refunded");
    expect(fake.calls.subscriptions).toEqual([]);
    expect(logs.join("\n")).toContain("refunded (amount)");
  });

  it("refunds a payment for another team", async () => {
    const payment = await paidPayment();
    const other = await createTeam(db, "other");
    expect(await fulfill({ ...payment, teamId: other })).toBe("refunded");
    expect(fake.calls.subscriptions).toEqual([]);
  });

  it("undoes the start when the first invoice is not the Pix amount", async () => {
    const payment = await paidPayment();
    fake = pixFake(state.subscriptions, 1590);
    // The price reads 1490 while its first invoice bills 1590 (a stale fixture).
    fake.pix.prices.retrieve = async (id) =>
      ({
        id,
        active: true,
        billing_scheme: "per_unit",
        currency: "usd",
        product: "prod_correio",
        currency_options: { brl: { unit_amount: 1490 } },
      }) as unknown as Stripe.Price;
    fake.sessions[payment.sessionId] = {} as Stripe.Checkout.Session;
    expect(await fulfill(payment)).toBe("refunded");
    expect(fake.calls.cancels).toEqual(["sub_pix_1"]);
    expect(fake.calls.voids).toEqual(["in_pix_1"]);
    expect(fake.calls.pays).toEqual([]);
  });

  it("settles an open renewal invoice once, and refunds a Pix for one paid otherwise", async () => {
    const payment = await paidPayment();
    await fulfill(payment);
    const renewal = {
      ...fake.invoices.in_pix_1!,
      id: "in_pix_renewal",
      status: "open",
      amount_remaining: 1490,
      metadata: {},
    } as Stripe.Invoice;
    fake.invoices.in_pix_renewal = renewal;
    expect(await openPixInvoices(fake.pix, CUSTOMER)).toEqual([
      expect.objectContaining({ id: "in_pix_renewal", amount: 1490, currency: "brl" }),
    ]);
    const url = await beginPixInvoicePayment(fake.pix, {
      teamId,
      customerId: CUSTOMER,
      invoiceId: "in_pix_renewal",
      ...urls,
    });
    expect(url).toContain("checkout.stripe.com");
    const sessionId = Object.keys(fake.sessions).at(-1)!;
    expect(fake.calls.sessions.at(-1)).toMatchObject({
      metadata: { mepmail_pix: "invoice", mepmail_pix_invoice: "in_pix_renewal" },
      line_items: [{ price_data: { unit_amount: 1490, currency: "brl" } }],
    });
    fake.pay(sessionId);
    const renewalPayment = await readPixPayment(fake.pix, sessionId, false);
    if (typeof renewalPayment === "string") throw new Error(renewalPayment);
    expect(await settlePixInvoice(fake.pix, "in_pix_renewal", renewalPayment)).toBe("paid");
    expect(await settlePixInvoice(fake.pix, "in_pix_renewal", renewalPayment)).toBe("paid");
    expect(fake.calls.pays.filter(([id]) => id === "in_pix_renewal")).toHaveLength(1);
    // A second Pix for the same invoice is not its payment anymore.
    expect(
      await settlePixInvoice(fake.pix, "in_pix_renewal", {
        ...renewalPayment,
        sessionId: "cs_other",
      }),
    ).toBe("mismatch");
    await expect(
      beginPixInvoicePayment(fake.pix, {
        teamId,
        customerId: CUSTOMER,
        invoiceId: "in_pix_renewal",
        ...urls,
      }),
    ).rejects.toMatchObject({ code: "paid" });
  });

  it("never opens a Pix for another customer's invoice", async () => {
    const payment = await paidPayment();
    await fulfill(payment);
    fake.invoices.in_pix_1!.status = "open";
    await expect(
      beginPixInvoicePayment(fake.pix, {
        teamId,
        customerId: "cus_someone_else",
        invoiceId: "in_pix_1",
        ...urls,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("recognises only MepMail Pix Checkout events", () => {
    const event = (type: string, object: unknown) => ({ type, data: { object } }) as Stripe.Event;
    expect(
      pixSessionOf(
        event("checkout.session.completed", {
          id: "cs_1",
          mode: "payment",
          metadata: { mepmail_pix: "invoice" },
        }),
      ),
    ).toBe("cs_1");
    expect(
      pixSessionOf(
        event("checkout.session.async_payment_succeeded", {
          id: "cs_2",
          mode: "payment",
          metadata: { mepmail_pix: "mailbox_start" },
        }),
      ),
    ).toBe("cs_2");
    expect(
      pixSessionOf(event("checkout.session.completed", { id: "cs_3", mode: "subscription" })),
    ).toBeNull();
    expect(
      pixSessionOf(
        event("checkout.session.completed", { id: "cs_4", mode: "payment", metadata: {} }),
      ),
    ).toBeNull();
    expect(pixSessionOf(event("invoice.paid", { id: "in_1" }))).toBeNull();
  });
});
