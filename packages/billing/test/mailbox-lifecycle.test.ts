import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAILBOX_CHECKOUT_METADATA_KEY,
  MAILBOX_CUSTOMER_METADATA_KEY,
  type MailboxBillingStripe,
  type MailboxCatalog,
  recoverMailboxCheckoutSession,
} from "../src/mailbox.js";
import {
  applyMailboxSubscription,
  type BeginMailboxCheckoutInput,
  beginMailboxCheckout,
  resolveMailboxCustomer,
} from "../src/mailbox-lifecycle.js";
import { fakeStripe, PERIOD_END, PERIOD_START, subscription } from "./helpers.js";

const CUSTOMER = "cus_mailbox_fixture";
const USER = "buyer_fixture";
const TERMS = {
  priceId: "price_mailbox_fixture",
  currency: "usd",
  unitAmount: 123,
  interval: "month" as const,
  storageBytesPerMailbox: 4096,
  includedOutboundPerMailbox: 7,
};
const CATALOG: MailboxCatalog = {
  livemode: false,
  checkoutPriceId: TERMS.priceId,
  prices: [TERMS],
};
const EVENT = PERIOD_START + 100;
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));

function checkoutPage(
  data: Stripe.Checkout.Session[],
  hasMore = false,
): Stripe.ApiList<Stripe.Checkout.Session> {
  return { object: "list", data, has_more: hasMore, url: "/v1/checkout/sessions" };
}

function mailSub(id = "sub_mail", status: Stripe.Subscription.Status = "active") {
  const sub = subscription(id, CUSTOMER, status);
  sub.metadata = { mepmail_service: "mailbox", team_id: "metadata_is_not_ownership" };
  sub.livemode = false;
  sub.created = PERIOD_START - 100;
  sub.cancel_at_period_end = false;
  const item = sub.items.data[0]!;
  item.quantity = 3;
  item.price = {
    ...item.price,
    id: TERMS.priceId,
    currency: TERMS.currency,
    unit_amount: TERMS.unitAmount,
    billing_scheme: "per_unit",
    transform_quantity: null,
    recurring: {
      ...item.price.recurring!,
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
    },
  };
  return sub;
}

function paidIncreaseInvoice(sub: Stripe.Subscription, seats = sub.items.data[0]!.quantity!) {
  const id = "in_exact_external_increase",
    item = sub.items.data[0]!;
  return {
    id,
    customer: CUSTOMER,
    livemode: false,
    currency: TERMS.currency,
    billing_reason: "subscription_update",
    status: "paid",
    amount_remaining: 0,
    parent: { subscription_details: { subscription: sub.id } },
    lines: {
      object: "list",
      has_more: false,
      data: [
        {
          id: "il_exact_external_increase",
          invoice: id,
          livemode: false,
          currency: TERMS.currency,
          amount: TERMS.unitAmount * seats,
          quantity: seats,
          pricing: {
            type: "price_details",
            price_details: { price: TERMS.priceId },
            unit_amount_decimal: Stripe.Decimal.from(TERMS.unitAmount),
          },
          period: { start: PERIOD_START + 200, end: PERIOD_END },
          parent: {
            type: "subscription_item_details",
            subscription_item_details: {
              subscription: sub.id,
              subscription_item: item.id,
              proration: true,
              proration_details: null,
            },
          },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
}

describe("Mailbox lifecycle with real optional migrations", () => {
  let db: Db;
  let close: () => Promise<void>;
  let stripe: MailboxBillingStripe;
  let state: ReturnType<typeof fakeStripe>["state"];
  let teamId: string;
  let sessions: Stripe.Checkout.Session[];
  let customerOptions: (Stripe.RequestOptions | undefined)[];
  const request = (): BeginMailboxCheckoutInput => ({
    teamId,
    userId: USER,
    seats: 3,
    successUrl: "https://app.example.com/mailboxes?checkout=success",
    cancelUrl: "https://app.example.com/mailboxes",
  });
  const plan = async () =>
    (
      await db
        .select()
        .from(schema.mailboxSubscriptions)
        .where(eq(schema.mailboxSubscriptions.teamId, teamId))
    )[0];
  const leases = () => db.select().from(schema.mailboxCheckouts);
  const purchase = (input = request()) => beginMailboxCheckout({ db, stripe }, CATALOG, input);
  const purchaseWithReadback = () =>
    beginMailboxCheckout(
      { db, stripe, recoverCheckout: (lease) => recoverMailboxCheckoutSession(stripe, lease) },
      CATALOG,
      request(),
    );
  const sendingContract = async (amount = 2900, annual = false) => {
    const start = new Date(Date.now() - 60000);
    const end = new Date(start);
    if (annual) end.setUTCFullYear(end.getUTCFullYear() + 1);
    else end.setUTCMonth(end.getUTCMonth() + 1);
    const contract = {
      version: 1 as const,
      teamId,
      customerId: CUSTOMER,
      subscriptionId: "sub_sending_addon_fixture",
      baseItemId: "si_sending_addon_fixture",
      basePriceId: `price_sending_${amount}_${annual ? "year" : "month"}`,
      currency: "usd" as const,
      baseAmountCents: annual ? amount * 10 : amount,
      billingInterval: annual ? ("year" as const) : ("month" as const),
      intervalCount: 1 as const,
      included: 110000,
      usageInterval: "month" as const,
      regularMonthlyCents: amount,
      financialPeriodStart: start.toISOString(),
      financialPeriodEnd: end.toISOString(),
      usageAnchor: start.toISOString(),
      verifiedAt: new Date().toISOString(),
    };
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planStatus: "active",
        stripeSubscriptionId: contract.subscriptionId,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        sendBillingContract: contract,
      })
      .where(eq(schema.teams.id, teamId));
    return contract;
  };
  const customerRequests = () => db.select().from(schema.mailboxCustomerRequests);
  // Qualification rows only: an operational internal grant has its own mandatory audit.
  const internalPlan = (
    status: typeof schema.mailboxSubscriptions.$inferSelect.status = "active",
    seats = 2,
  ) =>
    db.insert(schema.mailboxSubscriptions).values({
      teamId,
      status,
      seats,
      storageBytesPerMailbox: 2048,
      includedOutboundPerMailbox: 2,
      periodStart: new Date(PERIOD_START * 1000),
      periodEnd: new Date(PERIOD_END * 1000),
    });
  const unlinkCustomer = () =>
    db.update(schema.teams).set({ stripeCustomerId: null }).where(eq(schema.teams.id, teamId));
  const resolveCustomer = (knownCustomerId = "cus_1", userId = USER, livemode = false) =>
    resolveMailboxCustomer({ db, stripe, livemode }, { teamId, userId, knownCustomerId });
  const loseCustomerResponse = async () => {
    await unlinkCustomer();
    const create = stripe.customers.create;
    let customer: Stripe.Customer | undefined;
    stripe.customers.create = async (params, options) => {
      customer = {
        ...(await create(params, options)),
        name: params.name ?? null,
        email: params.email ?? null,
        metadata: { ...((params.metadata ?? {}) as Stripe.Metadata) },
      };
      throw new Error("fixture lost Customer response");
    };
    await expect(purchase()).rejects.toMatchObject({ code: "pending" });
    if (!customer) throw new Error("fixture Customer was not created");
    const reads: string[] = [];
    stripe.customers.retrieve = async (id) => {
      reads.push(id);
      return customer!;
    };
    return { customer, reads };
  };

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    // The qualified main baseline may stop at 0042; Mail uses its own migration chain.
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
    teamId = await createTeam(db);
    await db
      .insert(schema.user)
      .values({ id: USER, name: "Fixture buyer", email: "buyer@example.com" });
    await db.insert(schema.teamMembers).values({ teamId, userId: USER, role: "owner" });
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: CUSTOMER })
      .where(eq(schema.teams.id, teamId));
    sessions = [];
    customerOptions = [];
    const createCustomer = stripe.customers.create;
    stripe.customers.create = async (params, options) => {
      customerOptions.push(options);
      return { ...(await createCustomer(params)), livemode: false };
    };
    const create = stripe.checkout.sessions.create;
    stripe.checkout.sessions.create = async (params, options) => {
      const base = await create(params, options);
      const session = {
        ...base,
        id: `cs_fixture_${sessions.length + 1}`,
        mode: "subscription",
        customer: params.customer,
        livemode: false,
        metadata: params.metadata,
        status: "open",
        subscription: null,
      } as Stripe.Checkout.Session;
      sessions.push(session);
      return session;
    };
  });
  afterEach(() => close());

  it.each([true, false])(
    "requires paid Envio before hosted checkout, linked customer=%s",
    async (linked) => {
      if (!linked) await unlinkCustomer();
      await expect(
        beginMailboxCheckout({ db, stripe, requirePaidSendingPlan: true }, CATALOG, request()),
      ).rejects.toMatchObject({ code: "sending_plan_required" });
      expect(state.customers).toHaveLength(0);
      expect(state.checkouts).toHaveLength(0);
      expect(await leases()).toHaveLength(0);
      expect(await customerRequests()).toHaveLength(0);
    },
  );

  it.each(["status", "amount"] as const)(
    "rechecks the verified Envio %s under checkout locks",
    async (change) => {
      const contracted = await sendingContract();
      const original = db.transaction.bind(db);
      let transactions = 0;
      const interveningDb = Object.create(db) as Db;
      interveningDb.transaction = (async (...args: Parameters<typeof db.transaction>) => {
        const result = await original(...args);
        if (++transactions === 2)
          await db
            .update(schema.teams)
            .set(
              change === "status"
                ? { planStatus: "past_due" }
                : {
                    sendBillingContract: {
                      ...contracted,
                      basePriceId: "price_sending_legacy20_fixture",
                      baseAmountCents: 2000,
                      regularMonthlyCents: 2000,
                    },
                  },
            )
            .where(eq(schema.teams.id, teamId));
        return result;
      }) as typeof db.transaction;
      await expect(
        beginMailboxCheckout(
          { db: interveningDb, stripe, requirePaidSendingPlan: true },
          CATALOG,
          request(),
        ),
      ).rejects.toMatchObject({ code: "sending_plan_required" });
      expect(state.checkouts).toHaveLength(0);
      expect(await leases()).toMatchObject([{ status: "creating" }]);
    },
  );

  it("allows hosted Correio checkout for an active paid Envio subscriber", async () => {
    await sendingContract();
    expect(
      await beginMailboxCheckout({ db, stripe, requirePaidSendingPlan: true }, CATALOG, request()),
    ).toMatchObject({ url: expect.stringContaining("checkout.stripe.com") });
    expect(state.checkouts).toHaveLength(1);
    expect(state.customers).toHaveLength(0);
    expect(await plan()).toBeUndefined();
  });

  it("refuses the active legacy20 contract without changing it or creating an intent", async () => {
    await sendingContract(2000);
    const [before] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    await expect(
      beginMailboxCheckout({ db, stripe, requirePaidSendingPlan: true }, CATALOG, request()),
    ).rejects.toMatchObject({ code: "sending_plan_required" });
    expect(await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))).toEqual([
      before,
    ]);
    expect(state.checkouts).toHaveLength(0);
    expect(state.customers).toHaveLength(0);
    expect(await leases()).toHaveLength(0);
  });

  it("accepts verified annual29 terms without changing Send or granting Mail on redirect", async () => {
    await sendingContract(2900, true);
    const [before] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(
      await beginMailboxCheckout({ db, stripe, requirePaidSendingPlan: true }, CATALOG, request()),
    ).toMatchObject({ url: expect.stringContaining("checkout.stripe.com") });
    expect(await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))).toEqual([
      before,
    ]);
    expect(await plan()).toBeUndefined();
  });

  it.each([
    { unitAmount: 590, interval: "month", storageGiB: 1, included: 500 },
    { unitAmount: 5900, interval: "year", storageGiB: 1, included: 500 },
    { unitAmount: 990, interval: "month", storageGiB: 10, included: 2000 },
    { unitAmount: 9900, interval: "year", storageGiB: 10, included: 2000 },
  ] as const)("freezes the approved Correio SKU %j in the checkout intent", async (sku) => {
    await sendingContract();
    const offered = {
      ...TERMS,
      priceId: `price_mail_${sku.storageGiB}_${sku.interval}`,
      unitAmount: sku.unitAmount,
      interval: sku.interval,
      storageBytesPerMailbox: sku.storageGiB * 1024 ** 3,
      includedOutboundPerMailbox: sku.included,
    };
    const selected: MailboxCatalog = {
      ...CATALOG,
      checkoutPriceId: offered.priceId,
      checkoutPriceIds: [offered.priceId],
      prices: [TERMS, offered],
    };
    await beginMailboxCheckout({ db, stripe, requirePaidSendingPlan: true }, selected, request());
    expect(await leases()).toMatchObject([
      {
        stripePriceId: offered.priceId,
        currency: "usd",
        unitAmount: sku.unitAmount,
        interval: sku.interval,
        storageBytesPerMailbox: offered.storageBytesPerMailbox,
        includedOutboundPerMailbox: sku.included,
        seats: 3,
      },
    ]);
    expect(state.checkouts[0]?.line_items).toEqual([{ price: offered.priceId, quantity: 3 }]);
    expect(await plan()).toBeUndefined();
  });

  it("creates one durable Customer for Mail only and preserves every Send field", async () => {
    await unlinkCustomer();
    const [before] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    const result = await purchase();
    const [intent] = await customerRequests();
    expect(intent).toMatchObject({
      teamId,
      status: "ready",
      name: before!.name,
      email: "buyer@example.com",
      livemode: false,
      stripeCustomerId: "cus_1",
    });
    expect(state.customers).toEqual([
      {
        name: before!.name,
        email: "buyer@example.com",
        metadata: { team_id: teamId, [MAILBOX_CUSTOMER_METADATA_KEY]: intent!.idempotencyKey },
      },
    ]);
    expect(customerOptions).toEqual([{ idempotencyKey: intent!.idempotencyKey }]);
    expect(await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))).toEqual([
      { ...before, stripeCustomerId: "cus_1" },
    ]);
    expect(state.checkouts[0]?.customer).toBe("cus_1");
    expect(await purchase()).toEqual(result);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toHaveLength(1);
    expect(await plan()).toBeUndefined();
  });

  it("serializes first-Customer requests from concurrent tabs without creating duplicates", async () => {
    await unlinkCustomer();
    const results = await Promise.allSettled([purchase(), purchase(), purchase()]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "pending" });
    }
    expect(state.customers).toHaveLength(1);
    expect(await customerRequests()).toHaveLength(1);
    expect(state.checkouts).toHaveLength(1);
    expect(await purchase()).toMatchObject({ url: sessions[0]!.url });
    expect(await plan()).toBeUndefined();
  });

  it("checks catalog, current membership, suspension and system team before Customer creation", async () => {
    await unlinkCustomer();
    await expect(beginMailboxCheckout({ db, stripe }, null, request())).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      beginMailboxCheckout({ db, stripe }, { ...CATALOG, checkoutPriceId: null }, request()),
    ).rejects.toMatchObject({ code: "unavailable" });
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(eq(schema.teamMembers.userId, USER));
    await expect(purchase()).rejects.toMatchObject({ code: "forbidden" });
    await db
      .update(schema.teamMembers)
      .set({ role: "admin" })
      .where(eq(schema.teamMembers.userId, USER));
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    await expect(purchase()).rejects.toMatchObject({ code: "forbidden" });
    await db
      .update(schema.teams)
      .set({ suspendedAt: null, plan: "system" })
      .where(eq(schema.teams.id, teamId));
    await expect(purchase()).rejects.toMatchObject({ code: "forbidden" });
    expect(state.customers).toEqual([]);
    expect(state.checkouts).toEqual([]);
    expect(await customerRequests()).toEqual([]);
    expect(await leases()).toEqual([]);
  });

  it("keeps a lost Customer response pending across retries and immutable parameter changes", async () => {
    await unlinkCustomer();
    const create = stripe.customers.create;
    stripe.customers.create = async (params, options) => {
      await create(params, options);
      throw new Error("fixture Customer response lost");
    };
    await expect(purchase()).rejects.toMatchObject({ code: "pending" });
    const [intent] = await customerRequests();
    expect(intent).toMatchObject({ status: "creating", stripeCustomerId: null });
    // This marker survives the provider transaction's rollback: it committed before the call.
    await db
      .update(schema.mailboxCustomerRequests)
      .set({ updatedAt: new Date("2000-01-01") })
      .where(eq(schema.mailboxCustomerRequests.teamId, teamId));
    await db
      .update(schema.user)
      .set({ email: "changed@example.com" })
      .where(eq(schema.user.id, USER));
    await db.update(schema.teams).set({ name: "Changed team" }).where(eq(schema.teams.id, teamId));
    await expect(purchase()).rejects.toMatchObject({ code: "pending" });
    await expect(purchase({ ...request(), seats: 4 })).rejects.toMatchObject({ code: "pending" });
    expect((await customerRequests())[0]).toMatchObject({
      name: intent!.name,
      email: intent!.email,
      idempotencyKey: intent!.idempotencyKey,
    });
    const beforeRejectedChange = await customerRequests();
    await expect(
      db
        .update(schema.mailboxCustomerRequests)
        .set({ email: "overwrite@example.com" })
        .where(eq(schema.mailboxCustomerRequests.teamId, teamId)),
    ).rejects.toMatchObject({
      cause: { message: "Mailbox Customer request parameters are immutable" },
    });
    expect(await customerRequests()).toEqual(beforeRejectedChange);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
    expect(await leases()).toEqual([]);
    expect(await plan()).toBeUndefined();
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0]
        ?.stripeCustomerId,
    ).toBeNull();
  });

  it.each(["active", "trialing", "past_due"] as const)(
    "rejects an occupied %s internal plan before creating Customer or durable intents",
    async (status) => {
      await unlinkCustomer();
      await internalPlan(status);
      const beforePlan = await plan();
      const beforeTeams = await db.select().from(schema.teams);
      await expect(purchase()).rejects.toMatchObject({ code: "subscription_exists" });
      expect(state.calls).toEqual([]);
      expect(state.customers).toEqual([]);
      expect(state.checkouts).toEqual([]);
      expect(await customerRequests()).toEqual([]);
      expect(await leases()).toEqual([]);
      expect(await plan()).toEqual(beforePlan);
      expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
    },
  );

  it("does not create a replacement Customer for an occupied Stripe contract with lost linkage", async () => {
    await applyMailboxSubscription(db, mailSub(), CATALOG, EVENT);
    await unlinkCustomer();
    const beforePlan = await plan();
    await expect(purchase()).rejects.toMatchObject({ code: "subscription_exists" });
    expect(state.calls).toEqual([]);
    expect(await customerRequests()).toEqual([]);
    expect(await leases()).toEqual([]);
    expect(await plan()).toEqual(beforePlan);
  });

  it("rechecks a grant committed after the Customer intent and preserves that intent without SDK calls", async () => {
    await unlinkCustomer();
    const transact = db.transaction.bind(db);
    const interveningDb = Object.create(db) as Db;
    let grantCommitted = false;
    interveningDb.transaction = (async (...args: Parameters<Db["transaction"]>) => {
      const result = await transact(...args);
      if (!grantCommitted) {
        await internalPlan();
        grantCommitted = true;
      }
      return result;
    }) as Db["transaction"];
    await expect(
      beginMailboxCheckout({ db: interveningDb, stripe }, CATALOG, request()),
    ).rejects.toMatchObject({ code: "subscription_exists" });
    expect(grantCommitted).toBe(true);
    const requests = await customerRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ status: "creating", stripeCustomerId: null });
    const beforePlan = await plan();
    await expect(purchase()).rejects.toMatchObject({ code: "subscription_exists" });
    expect(await customerRequests()).toEqual(requests);
    expect(await plan()).toEqual(beforePlan);
    expect(state.calls).toEqual([]);
    expect(await leases()).toEqual([]);
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0]
        ?.stripeCustomerId,
    ).toBeNull();
  });

  it("recovers an already-created Customer concurrently without replacing a later internal grant", async () => {
    const { customer, reads } = await loseCustomerResponse();
    await internalPlan();
    const beforePlan = await plan();
    const callsBefore = state.calls.slice();
    const results = await Promise.all([resolveCustomer(customer.id), resolveCustomer(customer.id)]);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(reads).toEqual([customer.id, customer.id]);
    expect((await customerRequests())[0]).toMatchObject({
      status: "ready",
      stripeCustomerId: customer.id,
    });
    expect(await plan()).toEqual(beforePlan);
    const incoming = mailSub();
    incoming.customer = customer.id;
    expect((await applyMailboxSubscription(db, incoming, CATALOG, EVENT)).reason).toBe(
      "superseded",
    );
    await expect(purchase()).rejects.toMatchObject({ code: "subscription_exists" });
    expect(state.calls).toEqual(callsBefore);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
    expect(await leases()).toEqual([]);
    expect(await plan()).toEqual(beforePlan);
  });

  it("does not replay a creating Customer intent after a crash before the provider call", async () => {
    await unlinkCustomer();
    await db.insert(schema.mailboxCustomerRequests).values({
      teamId,
      createdBy: USER,
      status: "creating",
      name: "Saved team name",
      email: "saved@example.com",
      livemode: false,
      idempotencyKey: "mailbox-customer:fixture-crash-before-call",
      createdAt: new Date("2000-01-01"),
      updatedAt: new Date("2000-01-01"),
    });
    await expect(purchase()).rejects.toMatchObject({ code: "pending" });
    await expect(
      beginMailboxCheckout({ db, stripe }, { ...CATALOG, livemode: true }, request()),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(state.customers).toEqual([]);
    expect(state.checkouts).toEqual([]);
    expect(await customerRequests()).toHaveLength(1);
  });

  it.each([
    { id: "bad_customer", livemode: false },
    { id: "cus_wrong_mode", livemode: true },
  ])("does not link an incompatible created Customer: %j", async (response) => {
    await unlinkCustomer();
    const create = stripe.customers.create;
    stripe.customers.create = async (params, options) => ({
      ...(await create(params, options)),
      ...response,
    });
    await expect(purchase()).rejects.toMatchObject({ code: "pending" });
    await expect(purchase()).rejects.toMatchObject({ code: "pending" });
    expect(state.customers).toHaveLength(1);
    expect((await customerRequests())[0]?.status).toBe("creating");
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0]
        ?.stripeCustomerId,
    ).toBeNull();
    expect(state.checkouts).toEqual([]);
  });

  it("reuses an existing linked Customer without creating a request or changing Send", async () => {
    const before = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    await purchase();
    expect(state.customers).toEqual([]);
    expect(await customerRequests()).toEqual([]);
    expect(state.checkouts[0]?.customer).toBe(CUSTOMER);
    expect(await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))).toEqual(before);
  });

  it("keeps Customer intent pending if the database rejects the post-provider binding", async () => {
    await unlinkCustomer();
    const otherTeam = await createTeam(db, "customer-owner-fixture");
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_1" })
      .where(eq(schema.teams.id, otherTeam));
    await expect(purchase()).rejects.toMatchObject({ code: "pending" });
    expect((await customerRequests())[0]).toMatchObject({
      status: "creating",
      stripeCustomerId: null,
    });
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0]
        ?.stripeCustomerId,
    ).toBeNull();
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, otherTeam)))[0]
        ?.stripeCustomerId,
    ).toBe("cus_1");
    await expect(purchase()).rejects.toMatchObject({ code: "pending" });
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
  });

  it("resolves the known Customer from the original snapshot atomically without Checkout or entitlement", async () => {
    const { customer, reads } = await loseCustomerResponse();
    const [intent] = await customerRequests();
    // Current profile changes do not change the immutable parameters sent with this nonce.
    await db
      .update(schema.user)
      .set({ email: "new-profile@example.com" })
      .where(eq(schema.user.id, USER));
    await db
      .update(schema.teams)
      .set({ name: "Renamed after submission" })
      .where(eq(schema.teams.id, teamId));
    const [before] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(await resolveCustomer(customer.id)).toEqual({ resolved: true, duplicate: false });
    const [ready] = await customerRequests();
    expect(ready).toEqual({
      ...intent,
      status: "ready",
      stripeCustomerId: customer.id,
      updatedAt: expect.any(Date),
    });
    expect(await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))).toEqual([
      { ...before, stripeCustomerId: customer.id },
    ]);
    expect(await resolveCustomer(customer.id)).toEqual({ resolved: true, duplicate: true });
    expect(await customerRequests()).toEqual([ready]);
    expect(reads).toEqual([customer.id, customer.id]);
    expect(state.customers).toHaveLength(1);
    expect(customerOptions).toEqual([{ idempotencyKey: intent!.idempotencyKey }]);
    expect(state.checkouts).toEqual([]);
    expect(await leases()).toEqual([]);
    expect(await plan()).toBeUndefined();
  });

  it("permits a current admin to recover another actor's request and serializes duplicate resolutions", async () => {
    const { customer } = await loseCustomerResponse();
    await db.insert(schema.user).values({
      id: "recovery_admin",
      name: "Recovery admin",
      email: "recovery-admin@example.com",
    });
    await db.insert(schema.teamMembers).values({ teamId, userId: "recovery_admin", role: "admin" });
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, USER));
    const results = await Promise.all([
      resolveCustomer(customer.id, "recovery_admin"),
      resolveCustomer(customer.id, "recovery_admin"),
    ]);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect((await customerRequests())[0]).toMatchObject({
      createdBy: USER,
      status: "ready",
      stripeCustomerId: customer.id,
    });
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
    expect(await plan()).toBeUndefined();
  });

  it.each([
    "id",
    "name",
    "email",
    "team",
    "nonce",
    "missing_nonce",
    "livemode",
    "deleted",
  ] as const)("does not resolve incompatible Customer readback: %s", async (field) => {
    const { customer } = await loseCustomerResponse();
    const incompatible = { ...customer, metadata: { ...customer.metadata } };
    if (field === "id") incompatible.id = "cus_different";
    if (field === "name") incompatible.name = "Different snapshot";
    if (field === "email") incompatible.email = "different-snapshot@example.com";
    if (field === "team") incompatible.metadata.team_id = "different_team";
    if (field === "nonce") incompatible.metadata[MAILBOX_CUSTOMER_METADATA_KEY] = "different_nonce";
    if (field === "missing_nonce") delete incompatible.metadata[MAILBOX_CUSTOMER_METADATA_KEY];
    if (field === "livemode") incompatible.livemode = true;
    stripe.customers.retrieve = async () =>
      field === "deleted" ? { id: customer.id, object: "customer", deleted: true } : incompatible;
    const beforeRequests = await customerRequests();
    const beforeTeams = await db.select().from(schema.teams);
    await expect(resolveCustomer(customer.id)).rejects.toMatchObject({ code: "pending" });
    expect(await customerRequests()).toEqual(beforeRequests);
    expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
    expect(await plan()).toBeUndefined();
  });

  it("rejects runtime mode mismatch before reading the provider and keeps the saved request", async () => {
    const { customer, reads } = await loseCustomerResponse();
    const before = await customerRequests();
    await expect(resolveCustomer(customer.id, USER, true)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(reads).toEqual([]);
    expect(await customerRequests()).toEqual(before);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
  });

  it.each(["removed", "member", "suspended", "system"] as const)(
    "denies Customer resolution before provider readback after %s",
    async (reason) => {
      const { customer, reads } = await loseCustomerResponse();
      if (reason === "removed")
        await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, USER));
      if (reason === "member")
        await db
          .update(schema.teamMembers)
          .set({ role: "member" })
          .where(eq(schema.teamMembers.userId, USER));
      if (reason === "suspended")
        await db
          .update(schema.teams)
          .set({ suspendedAt: new Date() })
          .where(eq(schema.teams.id, teamId));
      if (reason === "system")
        await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, teamId));
      const beforeRequests = await customerRequests();
      const beforeTeams = await db.select().from(schema.teams);
      await expect(resolveCustomer(customer.id)).rejects.toMatchObject({ code: "forbidden" });
      expect(reads).toEqual([]);
      expect(await customerRequests()).toEqual(beforeRequests);
      expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
      expect(state.customers).toHaveLength(1);
      expect(state.checkouts).toEqual([]);
    },
  );

  it("never links a Customer already owned by another team", async () => {
    const { customer, reads } = await loseCustomerResponse();
    const other = await createTeam(db, "existing-customer-owner");
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: customer.id })
      .where(eq(schema.teams.id, other));
    const beforeRequests = await customerRequests();
    const beforeTeams = await db.select().from(schema.teams);
    await expect(resolveCustomer(customer.id)).rejects.toMatchObject({ code: "conflict" });
    expect(reads).toEqual([]);
    expect(await customerRequests()).toEqual(beforeRequests);
    expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
  });

  it("does not replace a concurrent Send Customer binding", async () => {
    const { customer, reads } = await loseCustomerResponse();
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_send_existing" })
      .where(eq(schema.teams.id, teamId));
    const beforeRequests = await customerRequests();
    const beforeTeams = await db.select().from(schema.teams);
    await expect(resolveCustomer(customer.id)).rejects.toMatchObject({ code: "conflict" });
    expect(reads).toEqual([]);
    expect(await customerRequests()).toEqual(beforeRequests);
    expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
  });

  it("resolves creating bookkeeping for an already identical linked Customer", async () => {
    const { customer } = await loseCustomerResponse();
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: customer.id })
      .where(eq(schema.teams.id, teamId));
    const beforeTeams = await db.select().from(schema.teams);
    expect(await resolveCustomer(customer.id)).toEqual({ resolved: true, duplicate: false });
    expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
    expect((await customerRequests())[0]).toMatchObject({
      status: "ready",
      stripeCustomerId: customer.id,
    });
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
    expect(await plan()).toBeUndefined();
  });

  it.each(["timeout", "not_found", "reader_missing"] as const)(
    "keeps old Customer intents pending without replay after readback %s",
    async (kind) => {
      const { customer } = await loseCustomerResponse();
      await db
        .update(schema.mailboxCustomerRequests)
        .set({ updatedAt: new Date("2000-01-01") })
        .where(eq(schema.mailboxCustomerRequests.teamId, teamId));
      if (kind === "reader_missing") delete stripe.customers.retrieve;
      else
        stripe.customers.retrieve = async () => {
          throw new Error(kind === "timeout" ? "fixture timeout" : "fixture Customer 404");
        };
      const beforeRequests = await customerRequests();
      const beforeTeams = await db.select().from(schema.teams);
      await expect(resolveCustomer(customer.id)).rejects.toMatchObject({ code: "pending" });
      expect(await customerRequests()).toEqual(beforeRequests);
      expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
      expect(state.customers).toHaveLength(1);
      expect(state.checkouts).toEqual([]);
      expect(await plan()).toBeUndefined();
    },
  );

  it("rolls back both local bindings on failure and retries only the same Customer readback", async () => {
    const { customer, reads } = await loseCustomerResponse();
    await db.execute(
      sql.raw(`
      CREATE FUNCTION mailbox_customer_recovery_fixture_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'fixture request update unavailable';
        RETURN NEW;
      END;
      $$;
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE TRIGGER mailbox_customer_recovery_fixture_reject BEFORE UPDATE ON mailbox_customer_requests
      FOR EACH ROW WHEN (NEW.status = 'ready') EXECUTE FUNCTION mailbox_customer_recovery_fixture_reject();
    `),
    );
    const beforeRequests = await customerRequests();
    const beforeTeams = await db.select().from(schema.teams);
    await expect(resolveCustomer(customer.id)).rejects.toMatchObject({ code: "pending" });
    expect(await customerRequests()).toEqual(beforeRequests);
    expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
    await db.execute(
      sql.raw("DROP TRIGGER mailbox_customer_recovery_fixture_reject ON mailbox_customer_requests"),
    );
    await db.execute(sql.raw("DROP FUNCTION mailbox_customer_recovery_fixture_reject()"));
    expect(await resolveCustomer(customer.id)).toEqual({ resolved: true, duplicate: false });
    expect(reads).toEqual([customer.id, customer.id]);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
    expect(await leases()).toEqual([]);
    expect(await plan()).toBeUndefined();
  });

  it("requires a durable Customer request and rejects malformed known IDs without side effects", async () => {
    let reads = 0;
    stripe.customers.retrieve = async () => {
      reads++;
      throw new Error("fixture unexpected provider read");
    };
    const beforeTeams = await db.select().from(schema.teams);
    await expect(resolveCustomer(CUSTOMER)).rejects.toMatchObject({ code: "not_found" });
    await expect(resolveCustomer("not_a_customer")).rejects.toMatchObject({ code: "invalid" });
    expect(reads).toBe(0);
    expect(await customerRequests()).toEqual([]);
    expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
    expect(state.customers).toEqual([]);
    expect(state.checkouts).toEqual([]);
  });

  it("revalidates authorization even when a previous Customer resolution was ready", async () => {
    const { customer, reads } = await loseCustomerResponse();
    await resolveCustomer(customer.id);
    const beforeRequests = await customerRequests();
    const beforeTeams = await db.select().from(schema.teams);
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, USER));
    await expect(resolveCustomer(customer.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(reads).toEqual([customer.id]);
    expect(await customerRequests()).toEqual(beforeRequests);
    expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
  });

  it("never reopens a ready Customer request for another ID", async () => {
    const { customer, reads } = await loseCustomerResponse();
    await resolveCustomer(customer.id);
    const beforeRequests = await customerRequests();
    const beforeTeams = await db.select().from(schema.teams);
    await expect(resolveCustomer("cus_replacement")).rejects.toMatchObject({ code: "conflict" });
    expect(reads).toEqual([customer.id]);
    expect(await customerRequests()).toEqual(beforeRequests);
    expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts).toEqual([]);
  });

  it("maps ownership through the linked Customer and changes only Mail tables", async () => {
    const before = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(await applyMailboxSubscription(db, mailSub(), CATALOG, EVENT)).toMatchObject({
      applied: true,
      teamId,
      reason: "applied",
    });
    expect(await plan()).toMatchObject({
      status: "active",
      seats: 3,
      stripeCustomerId: CUSTOMER,
      stripeSubscriptionId: "sub_mail",
      stripePriceId: TERMS.priceId,
      unitAmount: 123,
      lastEventCreated: EVENT,
    });
    expect(await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))).toEqual(before);
    const foreign = mailSub("sub_foreign");
    foreign.customer = "cus_unlinked";
    expect(await applyMailboxSubscription(db, foreign, CATALOG, EVENT + 1)).toMatchObject({
      applied: false,
      teamId: null,
      reason: "unknown_customer",
    });
  });

  it("keeps historical price/limits and monotonic event/subscription ownership", async () => {
    const sub = mailSub();
    await applyMailboxSubscription(db, sub, CATALOG, EVENT);
    const rotated: MailboxCatalog = {
      ...CATALOG,
      checkoutPriceId: "price_new",
      prices: [{ ...TERMS, priceId: "price_new", unitAmount: 456, storageBytesPerMailbox: 8192 }],
    };
    sub.items.data[0]!.quantity = 4;
    sub.latest_invoice = paidIncreaseInvoice(sub);
    await applyMailboxSubscription(db, sub, rotated, EVENT + 1);
    expect(await plan()).toMatchObject({
      seats: 4,
      stripePriceId: TERMS.priceId,
      unitAmount: 123,
      storageBytesPerMailbox: 4096,
    });
    const before = await plan();
    expect((await applyMailboxSubscription(db, sub, rotated, EVENT)).reason).toBe("stale_event");
    const another = mailSub("sub_other");
    another.created += 10;
    expect((await applyMailboxSubscription(db, another, CATALOG, EVENT + 2)).reason).toBe(
      "superseded",
    );
    expect(await plan()).toEqual(before);
  });

  it.each([390, 690])(
    "preserves the archived Correio amount %i when the purchase catalog moves to590/990",
    async (unitAmount) => {
      const archived = { ...TERMS, priceId: `price_mail_legacy_${unitAmount}`, unitAmount };
      const oldCatalog: MailboxCatalog = {
        ...CATALOG,
        checkoutPriceId: null,
        prices: [archived],
      };
      const sub = mailSub();
      sub.items.data[0]!.price = {
        ...sub.items.data[0]!.price,
        id: archived.priceId,
        unit_amount: unitAmount,
      };
      await applyMailboxSubscription(db, sub, oldCatalog, EVENT);
      const before = await plan();
      if (!before) throw new Error("Expected the archived Mail contract");
      const newTerms = [590, 990].map((amount) => ({
        ...TERMS,
        priceId: `price_mail_new_${amount}`,
        unitAmount: amount,
        storageBytesPerMailbox: (amount === 590 ? 1 : 10) * 1024 ** 3,
        includedOutboundPerMailbox: amount === 590 ? 500 : 2000,
      }));
      const rotated: MailboxCatalog = {
        ...CATALOG,
        checkoutPriceId: "price_mail_new_590",
        checkoutPriceIds: newTerms.map((price) => price.priceId),
        prices: newTerms,
      };
      expect((await applyMailboxSubscription(db, sub, rotated, EVENT + 1)).applied).toBe(true);
      expect(await plan()).toMatchObject({
        stripePriceId: archived.priceId,
        unitAmount,
        currency: before.currency,
        interval: before.interval,
        storageBytesPerMailbox: before.storageBytesPerMailbox,
        includedOutboundPerMailbox: before.includedOutboundPerMailbox,
        seats: before.seats,
      });
    },
  );

  it("preserves initial purchase authority while refusing an old paid invoice for a later increase", async () => {
    const sub = mailSub();
    sub.latest_invoice = null;
    expect((await applyMailboxSubscription(db, sub, CATALOG, EVENT)).applied).toBe(true);
    const old = paidIncreaseInvoice(sub, 3);
    sub.items.data[0]!.quantity = 5;
    sub.latest_invoice = old;
    expect((await applyMailboxSubscription(db, sub, CATALOG, EVENT + 1)).reason).toBe(
      "invalid_projection",
    );
    const afterOldInvoice = await plan();
    if (!afterOldInvoice)
      throw new Error("Expected the Mail subscription after rejecting an old invoice");
    expect(afterOldInvoice.seats).toBe(3);
    sub.latest_invoice = paidIncreaseInvoice(sub);
    expect((await applyMailboxSubscription(db, sub, CATALOG, EVENT + 2)).applied).toBe(true);
    const afterPaidIncrease = await plan();
    if (!afterPaidIncrease)
      throw new Error("Expected the Mail subscription after the paid increase");
    expect(afterPaidIncrease.seats).toBe(5);
  });

  it("refuses a paid debit from a previous period even when its quantity matches the external increase", async () => {
    const sub = mailSub();
    await applyMailboxSubscription(db, sub, CATALOG, EVENT);
    sub.items.data[0]!.quantity = 5;
    const evidence = paidIncreaseInvoice(sub);
    evidence.lines.data[0]!.period = { start: PERIOD_START - 2592000, end: PERIOD_START };
    sub.latest_invoice = evidence;
    expect((await applyMailboxSubscription(db, sub, CATALOG, EVENT + 1)).reason).toBe(
      "invalid_projection",
    );
    const afterOldPeriod = await plan();
    if (!afterOldPeriod)
      throw new Error("Expected the Mail subscription after rejecting an old period");
    expect(afterOldPeriod.seats).toBe(3);
  });

  it.each(["active", "trialing", "past_due"] as const)(
    "preserves an occupied %s internal plan against a linked Customer's Stripe projection",
    async (status) => {
      await internalPlan(status);
      const beforePlan = await plan();
      const beforeTeams = await db.select().from(schema.teams);
      expect(await applyMailboxSubscription(db, mailSub(), CATALOG, EVENT)).toEqual({
        applied: false,
        teamId,
        reason: "superseded",
      });
      expect(await plan()).toEqual(beforePlan);
      expect(beforePlan).toMatchObject({
        seats: 2,
        stripeSubscriptionId: null,
        stripeCustomerId: null,
        stripePriceId: null,
        currency: null,
        unitAmount: null,
        lastEventCreated: null,
      });
      expect(await db.select().from(schema.teams)).toEqual(beforeTeams);
      expect(await leases()).toEqual([]);
      expect(state.calls).toEqual([]);
    },
  );

  it.each(["inactive", "canceled"] as const)(
    "permits a verified Stripe projection after an internal plan is explicitly %s",
    async (status) => {
      await internalPlan(status, 0);
      expect((await applyMailboxSubscription(db, mailSub(), CATALOG, EVENT)).reason).toBe(
        "applied",
      );
      expect(await plan()).toMatchObject({
        status: "active",
        seats: 3,
        stripeSubscriptionId: "sub_mail",
      });
    },
  );

  it("preserves an internal grant when a foreign projection is invalid", async () => {
    await internalPlan();
    const beforePlan = await plan();
    const invalid = mailSub();
    invalid.items.data[0]!.price.id = "price_unapproved";
    expect((await applyMailboxSubscription(db, invalid, CATALOG, EVENT)).reason).toBe(
      "invalid_projection",
    );
    expect(await plan()).toEqual(beforePlan);
  });

  it("keeps the same Stripe contract's grace, cancellation and non-entitled status transitions", async () => {
    const sub = mailSub();
    await applyMailboxSubscription(db, sub, CATALOG, EVENT);
    sub.status = "past_due";
    expect((await applyMailboxSubscription(db, sub, CATALOG, EVENT + 1)).reason).toBe("applied");
    expect(await plan()).toMatchObject({ status: "past_due", stripeSubscriptionId: sub.id });
    sub.status = "canceled";
    expect((await applyMailboxSubscription(db, sub, CATALOG, EVENT + 2)).reason).toBe("applied");
    expect(await plan()).toMatchObject({ status: "canceled", stripeSubscriptionId: sub.id });
    sub.status = "paused";
    expect((await applyMailboxSubscription(db, sub, CATALOG, EVENT + 3)).reason).toBe("applied");
    expect(await plan()).toMatchObject({ status: "inactive", stripeSubscriptionId: sub.id });
  });

  it("revokes only the same invalid subscription and preserves its historical snapshot", async () => {
    const sub = mailSub();
    await applyMailboxSubscription(db, sub, CATALOG, EVENT);
    const original = await plan();
    const foreign = mailSub("sub_other");
    foreign.created += 1;
    foreign.items.data[0]!.price.id = "price_unapproved";
    expect((await applyMailboxSubscription(db, foreign, CATALOG, EVENT + 1)).applied).toBe(false);
    expect(await plan()).toEqual(original);
    sub.items.data[0]!.price.id = "price_unapproved";
    expect((await applyMailboxSubscription(db, sub, CATALOG, EVENT + 2)).reason).toBe("revoked");
    expect(await plan()).toMatchObject({
      status: "inactive",
      seats: 0,
      unitAmount: 123,
      stripePriceId: TERMS.priceId,
      stripeSubscriptionId: "sub_mail",
    });
    sub.items.data[0]!.price.id = TERMS.priceId;
    await applyMailboxSubscription(db, sub, CATALOG, EVENT + 3);
    expect((await applyMailboxSubscription(db, sub, null, EVENT + 4)).reason).toBe("revoked");
  });

  it("replaces a canceled old subscription, never accepting its later event over the new one", async () => {
    const old = mailSub();
    await applyMailboxSubscription(db, old, CATALOG, EVENT);
    old.status = "canceled";
    await applyMailboxSubscription(db, old, CATALOG, EVENT + 1);
    const next = mailSub("sub_new");
    next.created += 1;
    await applyMailboxSubscription(db, next, CATALOG, EVENT + 2);
    expect((await applyMailboxSubscription(db, old, CATALOG, EVENT + 3)).reason).toBe("superseded");
    expect(await plan()).toMatchObject({ status: "active", stripeSubscriptionId: "sub_new" });
  });

  it("persists one immutable purchase and returns the saved URL on retry without entitlement", async () => {
    const first = await purchase();
    expect(await purchase()).toEqual(first);
    expect(state.checkouts).toHaveLength(1);
    const [lease] = await leases();
    expect(lease).toMatchObject({
      status: "ready",
      seats: 3,
      stripePriceId: TERMS.priceId,
      livemode: false,
      unitAmount: 123,
    });
    expect(lease!.idempotencyKey).toContain(lease!.id);
    expect(await plan()).toBeUndefined();
    await expect(purchase({ ...request(), seats: 4 })).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db
        .update(schema.mailboxCheckouts)
        .set({ seats: 4 })
        .where(eq(schema.mailboxCheckouts.id, lease!.id)),
    ).rejects.toThrow();
    expect((await leases())[0]!.seats).toBe(3);
  });

  it("concurrent tabs create one lease/Checkout; ready callers share the URL and others remain pending", async () => {
    const results = await Promise.allSettled([purchase(), purchase()]);
    const successes = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof purchase>>> =>
        r.status === "fulfilled",
    );
    expect(successes.length).toBeGreaterThan(0);
    for (const result of results) {
      if (result.status === "fulfilled") expect(result.value).toEqual(successes[0]!.value);
      else expect(result.reason).toMatchObject({ code: "pending" });
    }
    expect(state.checkouts).toHaveLength(1);
    expect(await leases()).toHaveLength(1);
  });

  it("checks current admin membership and provider subscriptions before opening any purchase", async () => {
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(eq(schema.teamMembers.userId, USER));
    await expect(purchase()).rejects.toMatchObject({ code: "forbidden" });
    await db
      .update(schema.teamMembers)
      .set({ role: "admin" })
      .where(eq(schema.teamMembers.userId, USER));
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    await expect(purchase()).rejects.toMatchObject({ code: "forbidden" });
    await db.update(schema.teams).set({ suspendedAt: null }).where(eq(schema.teams.id, teamId));
    state.subscriptions.sub_existing = mailSub("sub_existing");
    await expect(purchase()).rejects.toMatchObject({ code: "subscription_exists" });
    expect(await leases()).toEqual([]);
    expect(state.checkouts).toEqual([]);
  });

  it("keeps ambiguous attempts blocked despite age and recovers the same provider session", async () => {
    const create = stripe.checkout.sessions.create;
    stripe.checkout.sessions.create = async (params, options) => {
      await create(params, options);
      throw new Error("fixture ambiguous network result");
    };
    await expect(purchase()).rejects.toThrow("fixture ambiguous");
    const [lease] = await leases();
    expect(lease!.status).toBe("creating");
    await db
      .update(schema.mailboxCheckouts)
      .set({ updatedAt: new Date("2000-01-01") })
      .where(eq(schema.mailboxCheckouts.id, lease!.id));
    await expect(purchase()).rejects.toMatchObject({ code: "pending" });
    await expect(
      beginMailboxCheckout({ db, stripe, recoverCheckout: async () => null }, CATALOG, request()),
    ).rejects.toMatchObject({ code: "pending" });
    const recovered = await beginMailboxCheckout(
      { db, stripe, recoverCheckout: async () => sessions[0]! },
      CATALOG,
      request(),
    );
    expect(recovered.checkoutId).toBe(lease!.id);
    expect(recovered.url).toBe(sessions[0]!.url);
    expect(state.checkouts).toHaveLength(1);
    expect(await plan()).toBeUndefined();
  });

  it("accepts only owner-bound recovery and releases a lease only after confirmed provider expiration", async () => {
    const create = stripe.checkout.sessions.create;
    stripe.checkout.sessions.create = async (params, options) => {
      await create(params, options);
      throw new Error("fixture lost result");
    };
    await expect(purchase()).rejects.toThrow("fixture lost result");
    const recoverWrong = async () => ({ ...sessions[0]!, customer: "cus_foreign" });
    await expect(
      beginMailboxCheckout({ db, stripe, recoverCheckout: recoverWrong }, CATALOG, request()),
    ).rejects.toMatchObject({ code: "pending" });
    await expect(
      beginMailboxCheckout(
        { db, stripe, recoverCheckout: async () => ({ ...sessions[0]!, status: "expired" }) },
        CATALOG,
        request(),
      ),
    ).rejects.toMatchObject({ code: "expired" });
    expect((await leases())[0]!.status).toBe("expired");
    stripe.checkout.sessions.create = create;
    await purchase();
    expect(state.checkouts).toHaveLength(2);
    expect(await leases()).toHaveLength(2);
  });

  it("a complete Checkout does not grant access and its known subscription blocks another purchase", async () => {
    const create = stripe.checkout.sessions.create;
    stripe.checkout.sessions.create = async (params, options) => {
      await create(params, options);
      throw new Error("fixture lost result");
    };
    await expect(purchase()).rejects.toThrow("fixture lost result");
    await expect(
      beginMailboxCheckout(
        {
          db,
          stripe,
          recoverCheckout: async () => ({
            ...sessions[0]!,
            status: "complete",
            subscription: "sub_paid",
          }),
        },
        CATALOG,
        request(),
      ),
    ).rejects.toMatchObject({ code: "pending" });
    expect(await plan()).toBeUndefined();
    state.subscriptions.sub_paid = mailSub("sub_paid");
    await expect(purchase()).rejects.toMatchObject({ code: "subscription_exists" });
    expect(state.checkouts).toHaveLength(1);
    expect(sessions[0]!.metadata?.[MAILBOX_CHECKOUT_METADATA_KEY]).toBe(
      (await leases())[0]!.idempotencyKey,
    );
    await applyMailboxSubscription(db, state.subscriptions.sub_paid, CATALOG, EVENT);
    expect(await plan()).toMatchObject({ status: "active", seats: 3 });
  });

  it("releases a ready lease only after provider readback confirms expiration", async () => {
    const original = await purchase();
    await expect(
      beginMailboxCheckout(
        { db, stripe, recoverCheckout: async () => ({ ...sessions[0]!, status: "expired" }) },
        CATALOG,
        request(),
      ),
    ).rejects.toMatchObject({ code: "expired" });
    expect((await leases())[0]!.status).toBe("expired");
    const replacement = await purchase();
    expect(replacement.checkoutId).not.toBe(original.checkoutId);
    expect(state.checkouts).toHaveLength(2);
  });

  it("retrieves a known Checkout on the server instead of returning a stale saved URL", async () => {
    const original = await purchase();
    const retrieved: string[] = [];
    stripe.checkout.sessions.retrieve = async (id) => {
      retrieved.push(id);
      return sessions[0]!;
    };
    stripe.checkout.sessions.list = async () => {
      throw new Error("known session must not list");
    };
    expect(await purchaseWithReadback()).toEqual(original);
    expect(retrieved).toEqual([sessions[0]!.id]);
    sessions[0]!.status = "expired";
    await expect(purchaseWithReadback()).rejects.toMatchObject({ code: "expired" });
    expect((await leases())[0]?.status).toBe("expired");
    expect(state.checkouts).toHaveLength(1);
    expect(await plan()).toBeUndefined();
  });

  it("recovers a lost Checkout response through a Customer-scoped paginated list", async () => {
    const create = stripe.checkout.sessions.create;
    stripe.checkout.sessions.create = async (params, options) => {
      await create(params, options);
      throw new Error("fixture Checkout response lost");
    };
    await expect(purchase()).rejects.toThrow("fixture Checkout response lost");
    const [lease] = await leases();
    expect(lease).toMatchObject({ status: "creating", stripeSessionId: null });
    const listed: Stripe.Checkout.SessionListParams[] = [];
    stripe.checkout.sessions.list = async (params) => {
      listed.push(params);
      if (!params.starting_after)
        return checkoutPage(
          [
            {
              ...sessions[0]!,
              id: "cs_unrelated",
              metadata: { [MAILBOX_CHECKOUT_METADATA_KEY]: "different_key" },
            },
          ],
          true,
        );
      return checkoutPage([sessions[0]!]);
    };
    const recovered = await purchaseWithReadback();
    expect(recovered).toEqual({ checkoutId: lease!.id, url: sessions[0]!.url });
    expect(listed).toEqual([
      { customer: CUSTOMER, limit: 100 },
      { customer: CUSTOMER, limit: 100, starting_after: "cs_unrelated" },
    ]);
    expect(state.checkouts).toHaveLength(1);
    expect((await leases())[0]).toMatchObject({
      status: "ready",
      stripeSessionId: sessions[0]!.id,
    });
    expect(await plan()).toBeUndefined();
  });

  it.each(["none", "duplicate", "provider_error", "repeated_cursor"] as const)(
    "keeps ambiguous Checkout list readback pending: %s",
    async (kind) => {
      const create = stripe.checkout.sessions.create;
      stripe.checkout.sessions.create = async (params, options) => {
        await create(params, options);
        throw new Error("fixture lost response");
      };
      await expect(purchase()).rejects.toThrow("fixture lost response");
      const before = await leases();
      let calls = 0;
      stripe.checkout.sessions.list = async () => {
        calls++;
        if (kind === "provider_error") throw new Error("fixture readback unavailable");
        if (kind === "duplicate")
          return checkoutPage([sessions[0]!, { ...sessions[0]!, id: "cs_duplicate" }]);
        if (kind === "repeated_cursor")
          return checkoutPage([{ ...sessions[0]!, id: "cs_cursor", metadata: {} }], true);
        return checkoutPage([]);
      };
      await expect(purchaseWithReadback()).rejects.toMatchObject({ code: "pending" });
      expect(calls).toBe(kind === "repeated_cursor" ? 2 : 1);
      expect(await leases()).toEqual(before);
      expect(state.checkouts).toHaveLength(1);
      expect(await plan()).toBeUndefined();
    },
  );

  it.each(["customer", "mode", "livemode", "service", "team", "key"] as const)(
    "rejects an incompatible Customer-scoped Checkout result: %s",
    async (field) => {
      const create = stripe.checkout.sessions.create;
      stripe.checkout.sessions.create = async (params, options) => {
        await create(params, options);
        throw new Error("fixture lost response");
      };
      await expect(purchase()).rejects.toThrow("fixture lost response");
      const foreign = { ...sessions[0]!, metadata: { ...sessions[0]!.metadata } };
      if (field === "customer") foreign.customer = "cus_foreign";
      if (field === "mode") foreign.mode = "payment";
      if (field === "livemode") foreign.livemode = true;
      if (field === "service") foreign.metadata.mepmail_service = "send";
      if (field === "team") foreign.metadata.team_id = "different_team";
      if (field === "key") foreign.metadata[MAILBOX_CHECKOUT_METADATA_KEY] = "different_key";
      stripe.checkout.sessions.list = async () => checkoutPage([foreign]);
      await expect(purchaseWithReadback()).rejects.toMatchObject({ code: "pending" });
      expect((await leases())[0]).toMatchObject({ status: "creating", stripeSessionId: null });
      expect(state.checkouts).toHaveLength(1);
      expect(await plan()).toBeUndefined();
    },
  );

  it("rejects a retrieve response for a different known Session and keeps the saved lease", async () => {
    await purchase();
    const before = await leases();
    stripe.checkout.sessions.retrieve = async () => ({ ...sessions[0]!, id: "cs_different" });
    await expect(purchaseWithReadback()).rejects.toMatchObject({ code: "pending" });
    expect(await leases()).toEqual(before);
    expect(state.checkouts).toHaveLength(1);
  });

  it("records a complete readback without entitlement and blocks another paid subscription", async () => {
    const create = stripe.checkout.sessions.create;
    stripe.checkout.sessions.create = async (params, options) => {
      await create(params, options);
      throw new Error("fixture lost response");
    };
    await expect(purchase()).rejects.toThrow("fixture lost response");
    stripe.checkout.sessions.list = async () =>
      checkoutPage([
        { ...sessions[0]!, status: "complete", subscription: "sub_paid_readback", url: null },
      ]);
    await expect(purchaseWithReadback()).rejects.toMatchObject({ code: "pending" });
    expect((await leases())[0]).toMatchObject({
      status: "completed",
      stripeSubscriptionId: "sub_paid_readback",
    });
    expect(await plan()).toBeUndefined();
    state.subscriptions.sub_paid_readback = mailSub("sub_paid_readback");
    await expect(purchaseWithReadback()).rejects.toMatchObject({ code: "subscription_exists" });
    expect(state.checkouts).toHaveLength(1);
    expect(await plan()).toBeUndefined();
  });

  it("fails closed without an approved catalog before creating a lease", async () => {
    await expect(beginMailboxCheckout({ db, stripe }, null, request())).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      beginMailboxCheckout({ db, stripe }, { ...CATALOG, checkoutPriceId: null }, request()),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await leases()).toEqual([]);
    expect(state.checkouts).toEqual([]);
  });
});
