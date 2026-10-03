import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMetaCheckout, saveAdvertisingConsent } from "../src/meta-advertising.js";
import type { MetaConversionConfig } from "../src/meta-conversions.js";
import type { BillingStripe } from "../src/stripe.js";
import { cancelTeamSubscription, reconcileTeamPlan } from "../src/subscription.js";
import { handleWebhook, purgeStripeEvents } from "../src/webhook.js";
import {
  fakeStripe,
  legacyProduct,
  PERIOD_END,
  PERIOD_START,
  price,
  priceId,
  schedule,
  subscription,
  teamRow,
  webhooks,
} from "./helpers.js";

const SECRET = "whsec_test";

let db: Db;
let close: () => Promise<void>;
let stripe: BillingStripe;
let state: ReturnType<typeof fakeStripe>["state"];
let logs: string[];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ stripe, state } = fakeStripe());
  logs = [];
});

afterEach(() => close());

let seq = 0;
function event(
  type: string,
  object: Record<string, unknown>,
  id = `evt_${++seq}`,
  livemode = false,
): string {
  return JSON.stringify({ id, object: "event", type, livemode, data: { object } });
}

function deliver(
  payload: string,
  signature: string | null = webhooks.generateTestHeaderString({ payload, secret: SECRET }),
) {
  return handleWebhook(payload, signature, {
    db,
    stripe,
    webhookSecret: SECRET,
    livemode: false,
    log: (m) => logs.push(m),
  });
}

const team = (teamId: string) => teamRow(db, teamId);

async function customerTeam(customer = "cus_1"): Promise<string> {
  const teamId = await createTeam(db);
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: customer })
    .where(eq(schema.teams.id, teamId));
  return teamId;
}

const subEvent = (type: string, sub: Stripe.Subscription, id?: string) =>
  event(type, { id: sub.id, object: "subscription", customer: sub.customer }, id);

const deps = () => ({ db, stripe, log: (m: string) => logs.push(m) });

describe("handleWebhook", () => {
  it("rejects a bad signature without recording the event", async () => {
    const payload = event("customer.subscription.updated", { id: "sub_1" });
    expect(await deliver(payload, "t=1,v1=bad")).toBe(400);
    expect(await deliver(payload, null)).toBe(400);
    expect(
      await deliver(payload, webhooks.generateTestHeaderString({ payload, secret: "whsec_other" })),
    ).toBe(400);
    expect(await db.select().from(schema.stripeEvents)).toEqual([]);
  });

  it("rejects an event whose mode does not match the configured key", async () => {
    await customerTeam();
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    const payload = event(
      "customer.subscription.created",
      { id: "sub_1", object: "subscription", customer: "cus_1" },
      "evt_live",
      true,
    );
    expect(await deliver(payload)).toBe(400);
    expect(await db.select().from(schema.stripeEvents)).toEqual([]);
    expect(state.retrieves).toEqual([]);
  });

  it("processes an event once; redeliveries are acknowledged without side effects", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    const payload = subEvent("customer.subscription.created", state.subscriptions.sub_1);
    expect(await deliver(payload)).toBe(200);
    expect((await team(teamId))?.plan).toBe("pro");
    expect(state.retrieveParams).toEqual({
      expand: ["items.data.price.product", "schedule.phases.items.price"],
    });

    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "canceled");
    expect(await deliver(payload)).toBe(200);
    expect(state.retrieves).toEqual(["sub_1"]);
    expect((await team(teamId))?.plan).toBe("pro");
  });

  it("active/trialing write the rung's plan, volume, period and overage item", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription(
      "sub_1",
      "cus_1",
      "trialing",
      "millionsend_scale_500k_monthly",
      { overageKey: "millionsend_scale_500k_overage" },
    );
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1));
    expect(await team(teamId)).toEqual({
      plan: "scale",
      planQuota: 550_000,
      planStatus: "trialing",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeOverageItemId: "si_sub_1_overage",
      overageEnabled: true,
      pendingRung: null,
      currentPeriodStart: new Date(PERIOD_START * 1000),
      currentPeriodEnd: new Date(PERIOD_END * 1000),
    });
    expect(state.itemUpdates).toEqual([]);

    // A monthly subscription without a metered item (one from before the
    // ladder) gets the rung's item on its first sync, so overage can bill.
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    await deliver(subEvent("customer.subscription.updated", state.subscriptions.sub_1));
    expect(state.calls.filter((c) => c === "subscriptionItems.create")).toHaveLength(1);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 110_000,
      planStatus: "active",
      stripeOverageItemId: "si_sub_1_overage",
    });

    state.subscriptions.sub_1 = subscription(
      "sub_1",
      "cus_1",
      "active",
      "millionsend_starter_monthly",
    );
    await deliver(subEvent("customer.subscription.updated", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "starter", planQuota: null });
  });

  it("pre-ladder prices land on the first rung of their product's plan", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription(
      "sub_1",
      "cus_1",
      "active",
      "millionsend_scale_monthly",
      { product: legacyProduct("scale") },
    );
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "scale", planQuota: 550_000 });

    state.subscriptions.sub_1 = subscription(
      "sub_1",
      "cus_1",
      "active",
      "millionsend_pro_monthly",
      {
        product: legacyProduct("pro"),
      },
    );
    await deliver(subEvent("customer.subscription.updated", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "pro", planQuota: 110_000 });
  });

  it("mirrors a scheduled downgrade in pending_rung and clears it once the schedule is gone", async () => {
    const teamId = await customerTeam();
    const pending = schedule([
      price("millionsend_pro_100k_monthly"),
      price("millionsend_pro_100k_overage", { metered: true }),
    ]);
    state.subscriptions.sub_1 = subscription(
      "sub_1",
      "cus_1",
      "active",
      "millionsend_pro_200k_monthly",
      { overageKey: "millionsend_pro_200k_overage", schedule: pending },
    );
    await deliver(subEvent("customer.subscription.updated", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ planQuota: 220_000, pendingRung: "pro_100k" });

    state.subscriptions.sub_1.schedule = null;
    await deliver(subEvent("customer.subscription.updated", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ planQuota: 220_000, pendingRung: null });

    // A subscription that is no longer entitled has nothing pending.
    state.subscriptions.sub_1.schedule = pending;
    state.subscriptions.sub_1.status = "unpaid";
    await deliver(subEvent("customer.subscription.updated", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "free", pendingRung: null });
  });

  it("price metadata names the rung ahead of the lookup key", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription(
      "sub_1",
      "cus_1",
      "active",
      "millionsend_pro_100k_monthly",
      { metadata: { millionsend_rung: "scale_1m" } },
    );
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "scale", planQuota: 1_100_000 });
  });

  it("resolves a rotated (key-less) price through the product's plan metadata", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active", null, {
      product: { id: "prod_scale", object: "product", metadata: { millionsend_plan: "scale" } },
    });
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 550_000,
      planStatus: "active",
    });
  });

  it("re-points a metered item priced for another rung", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription(
      "sub_1",
      "cus_1",
      "active",
      "millionsend_pro_200k_monthly",
      { overageKey: "millionsend_pro_100k_overage" },
    );
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1));
    expect(state.itemUpdates).toEqual([
      [
        "si_sub_1_overage",
        { price: priceId("millionsend_pro_200k_overage"), proration_behavior: "none" },
      ],
    ]);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 220_000,
      stripeOverageItemId: "si_sub_1_overage",
    });

    // Now in step: nothing to re-point.
    await deliver(subEvent("customer.subscription.updated", state.subscriptions.sub_1));
    expect(state.itemUpdates).toHaveLength(1);
  });

  it("leaves a rotated (key-less) metered price alone when its metadata names the plan's rung", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription(
      "sub_1",
      "cus_1",
      "active",
      "millionsend_pro_200k_monthly",
      { overageKey: null, overageMetadata: { millionsend_rung: "pro_200k" } },
    );
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1));
    expect(state.itemUpdates).toEqual([]);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 220_000,
      stripeOverageItemId: "si_sub_1_overage",
    });
  });

  it("meters the unreported tail while the row still names a metered item that is going", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active", undefined, {
      overageKey: "millionsend_pro_100k_overage",
    });
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1));
    await db
      .insert(schema.usagePeriods)
      .values({ teamId, periodStart: new Date(PERIOD_START * 1000), accepted: 110_500 });

    state.subscriptions.sub_1.status = "canceled";
    await deliver(subEvent("customer.subscription.deleted", state.subscriptions.sub_1));
    // reportOverage only sees rows whose stripe_overage_item_id is set: an
    // event at all means it ran before the column was cleared.
    expect(state.meterEvents).toHaveLength(1);
    expect(state.meterEvents[0]).toMatchObject({
      identifier: `${teamId}:${PERIOD_START * 1000}:0:500`,
      payload: { stripe_customer_id: "cus_1", value: "500" },
    });
    expect(await team(teamId)).toMatchObject({
      plan: "free",
      planStatus: "canceled",
      stripeOverageItemId: null,
    });
    const [period] = await db
      .select({ reportedOverage: schema.usagePeriods.reportedOverage })
      .from(schema.usagePeriods)
      .where(eq(schema.usagePeriods.teamId, teamId));
    expect(period?.reportedOverage).toBe(500);
  });

  it("past_due keeps the plan as a grace period; unpaid and canceled drop to free", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active", undefined, {
      overageKey: "millionsend_pro_100k_overage",
    });
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1));

    state.subscriptions.sub_1.status = "past_due";
    await deliver(
      event("invoice.payment_failed", {
        id: "in_1",
        object: "invoice",
        customer: "cus_1",
        parent: { subscription_details: { subscription: "sub_1" } },
      }),
    );
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 110_000,
      planStatus: "past_due",
      stripeOverageItemId: "si_sub_1_overage",
    });

    state.subscriptions.sub_1.status = "unpaid";
    await deliver(subEvent("customer.subscription.updated", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({
      plan: "free",
      planQuota: null,
      planStatus: "unpaid",
      stripeOverageItemId: null,
    });

    state.subscriptions.sub_1.status = "active";
    await deliver(
      event("invoice.paid", {
        id: "in_2",
        object: "invoice",
        customer: "cus_1",
        parent: { subscription_details: { subscription: "sub_1" } },
      }),
    );
    expect(await team(teamId)).toMatchObject({ plan: "pro", planStatus: "active" });

    state.subscriptions.sub_1.status = "canceled";
    await deliver(subEvent("customer.subscription.deleted", state.subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "free", planStatus: "canceled" });
  });

  it("checkout.session.completed applies the plan to the pre-created customer only", async () => {
    const linked = await customerTeam("cus_1");
    const other = await createTeam(db, "other");
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    state.subscriptions.sub_x = subscription("sub_x", "cus_unknown", "active");
    await deliver(
      event("checkout.session.completed", {
        id: "cs_1",
        object: "checkout.session",
        subscription: "sub_1",
        customer: "cus_1",
        client_reference_id: linked,
      }),
    );
    expect(await team(linked)).toMatchObject({ plan: "pro", stripeSubscriptionId: "sub_1" });

    // A team id in the session is never trusted to link an unknown customer.
    expect(
      await deliver(
        event("checkout.session.completed", {
          id: "cs_2",
          object: "checkout.session",
          subscription: "sub_x",
          customer: "cus_unknown",
          client_reference_id: other,
          metadata: { team_id: other },
        }),
      ),
    ).toBe(200);
    expect(await team(other)).toMatchObject({
      plan: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
  });

  it("mirrors Stripe's cancel_at and clears it once the cancellation is undone", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active", undefined, {
      cancelAt: 1_900_000_000,
    });
    expect(
      await deliver(event("customer.subscription.updated", { id: "sub_1", customer: "cus_1" })),
    ).toBe(200);
    const cancelAt = async () =>
      (
        await db
          .select({ cancelAt: schema.teams.cancelAt })
          .from(schema.teams)
          .where(eq(schema.teams.id, teamId))
      )[0]?.cancelAt;
    expect((await cancelAt())?.toISOString()).toBe(new Date(1_900_000_000 * 1000).toISOString());
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    expect(
      await deliver(event("customer.subscription.updated", { id: "sub_1", customer: "cus_1" })),
    ).toBe(200);
    expect(await cancelAt()).toBeNull();
  });

  it("ignores the end of a superseded subscription", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_old = subscription("sub_old", "cus_1", "canceled");
    state.subscriptions.sub_new = subscription(
      "sub_new",
      "cus_1",
      "active",
      "millionsend_scale_500k_monthly",
    );
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_new));
    await deliver(subEvent("customer.subscription.deleted", state.subscriptions.sub_old));
    expect(await team(teamId)).toMatchObject({
      plan: "scale",
      planStatus: "active",
      stripeSubscriptionId: "sub_new",
    });
  });

  it("acknowledges events for unknown customers, unknown prices, and unhandled types", async () => {
    const teamId = await customerTeam();
    state.subscriptions.sub_x = subscription("sub_x", "cus_unknown", "active");
    expect(
      await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_x)),
    ).toBe(200);
    expect(logs.at(-1)).toMatch(/no team for customer cus_unknown$/);

    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active", "someone_elses_price");
    expect(
      await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1)),
    ).toBe(200);
    expect(logs.at(-1)).toMatch(/subscription sub_1 has no known plan price$/);

    expect(await deliver(event("customer.created", { id: "cus_1", object: "customer" }))).toBe(200);
    expect(await team(teamId)).toMatchObject({
      plan: "free",
      planQuota: null,
      planStatus: "none",
      stripeSubscriptionId: null,
      currentPeriodStart: null,
    });
    expect((await db.select().from(schema.stripeEvents)).length).toBe(3);
  });

  it("recovers the same signed initial paid invoice atomically and deduplicates its Purchase", async () => {
    const http = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Webhook integration must not call Meta or any HTTP provider");
    });
    try {
      const teamId = await customerTeam("cus_invoice");
      const otherTeamId = await createTeam(db, "invoice-unrelated");
      const actorId = "invoice-offline-owner";
      await db.insert(schema.user).values({
        id: actorId,
        name: "Offline invoice fixture",
        email: "invoice-owner@example.invalid",
      });
      const now = new Date();
      const capturedAt = new Date(now.getTime() - 5_000);
      const created = Math.floor(capturedAt.getTime() / 1_000) + 1;
      const paidAt = Math.floor(now.getTime() / 1_000) - 1;
      const attemptId = randomUUID();
      const metadata = { mepmail_send_checkout: attemptId, team_id: teamId };
      const basePrice = priceId("millionsend_pro_100k_monthly");
      const overagePrice = priceId("millionsend_pro_100k_overage");
      const [attempt] = await db
        .insert(schema.sendCheckoutAttempts)
        .values({
          id: attemptId,
          teamId,
          createdBy: actorId,
          status: "created",
          rung: "pro_100k",
          livemode: false,
          stripeCustomerId: "cus_invoice",
          stripeSessionId: "cs_invoice",
          checkoutUrl: "https://checkout.stripe.com/c/pay/offline-invoice",
          idempotencyKey: `send-${attemptId}`,
          firstRequestedAt: capturedAt,
          createdAt: capturedAt,
          updatedAt: capturedAt,
          parameters: {
            mode: "subscription",
            customer: "cus_invoice",
            client_reference_id: teamId,
            metadata,
            subscription_data: { metadata },
            line_items: [{ price: basePrice, quantity: 1 }, { price: overagePrice }],
          },
        })
        .returning();
      if (!attempt) throw new Error("Missing durable financial fixture");
      const advertisingConfig: MetaConversionConfig = {
        enabled: true,
        datasetId: "123456789",
        accessToken: "offline-placeholder-not-a-credential",
        graphVersion: "v26.0",
        mode: "production",
      };
      const consent = await saveAdvertisingConsent(
        db,
        {
          granted: true,
          proof: null,
          userId: actorId,
          sourceUrl: "https://mepmail.dev/pricing",
        },
        capturedAt,
      );
      await db.transaction(async (transaction) => {
        await prepareMetaCheckout(
          transaction as unknown as Db,
          attempt,
          {
            config: advertisingConfig,
            proof: consent.proof,
            cookieHeader: `_fbp=fb.1.${capturedAt.getTime()}.123456789`,
          },
          capturedAt,
        );
      });
      expect(await db.select().from(schema.metaCheckoutContexts)).toMatchObject([
        { attemptId, eligible: true, consentReceiptId: consent.proof.id },
      ]);

      // Reuse the canonical subscription/price fixture; add its acquisition facts.
      const recoveredSubscription = subscription(
        "sub_invoice",
        "cus_invoice",
        "active",
        "millionsend_pro_100k_monthly",
        { overageKey: "millionsend_pro_100k_overage" },
      );
      Object.assign(recoveredSubscription, {
        livemode: false,
        metadata,
        trial_start: null,
        trial_end: null,
        created,
        start_date: created,
        canceled_at: null,
        cancel_at_period_end: false,
        collection_method: "charge_automatically",
        latest_invoice: "in_invoice",
        currency: "usd",
      });
      recoveredSubscription.items.has_more = false;
      recoveredSubscription.items.url = "/v1/subscription_items?subscription=sub_invoice";
      const invoice = {
        id: "in_invoice",
        object: "invoice",
        customer: "cus_invoice",
        livemode: false,
        status: "paid",
        billing_reason: "subscription_create",
        currency: "usd",
        amount_due: 1_243,
        amount_paid: 1_243,
        amount_remaining: 0,
        total: 1_243,
        subtotal: 2_000,
        total_discount_amounts: [{ amount: 757, discount: "di_invoice" }],
        metadata,
        created,
        status_transitions: {
          finalized_at: created,
          paid_at: paidAt,
          marked_uncollectible_at: null,
          voided_at: null,
        },
        parent: {
          type: "subscription_details",
          subscription_details: { subscription: "sub_invoice", metadata },
        },
        lines: {
          object: "list",
          has_more: false,
          url: "/v1/invoices/in_invoice/lines",
          data: [
            {
              id: "il_invoice",
              object: "line_item",
              amount: 2_000,
              currency: "usd",
              quantity: 1,
              pricing: {
                type: "price_details",
                price_details: { price: basePrice, product: "prod_1" },
              },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: {
                  subscription: "sub_invoice",
                  subscription_item: "si_sub_invoice",
                  proration: false,
                },
              },
              period: { start: PERIOD_START, end: PERIOD_END },
            },
          ],
        },
      };
      const payload = JSON.stringify({
        ...JSON.parse(event("invoice.payment_succeeded", invoice, "evt_invoice")),
        created: paidAt,
        api_version: null,
        pending_webhooks: 1,
        request: null,
      });
      const signature = webhooks.generateTestHeaderString({ payload, secret: SECRET });
      const deliverInvoice = () =>
        handleWebhook(payload, signature, {
          db,
          stripe,
          webhookSecret: SECRET,
          livemode: false,
          advertisingConfig,
          log: (message) => logs.push(message),
        });
      const beforeTeam = await team(teamId);
      const beforeAttempt = await db.select().from(schema.sendCheckoutAttempts);
      const beforeContext = await db.select().from(schema.metaCheckoutContexts);
      expect(await db.select().from(schema.stripeEvents)).toEqual([]);
      expect(await db.select().from(schema.metaConversionOutbox)).toEqual([]);

      // A signed invoice cannot commit its ledger before authoritative readback succeeds.
      await expect(deliverInvoice()).rejects.toThrow("No such subscription");
      expect(await db.select().from(schema.stripeEvents)).toEqual([]);
      expect(await db.select().from(schema.metaConversionOutbox)).toEqual([]);
      expect(await team(teamId)).toEqual(beforeTeam);
      expect(await db.select().from(schema.sendCheckoutAttempts)).toEqual(beforeAttempt);
      expect(await db.select().from(schema.metaCheckoutContexts)).toEqual(beforeContext);

      // Retry the identical signed payload after recovering only the same Subscription.
      state.subscriptions.sub_invoice = recoveredSubscription;
      expect(await deliverInvoice()).toBe(200);
      expect(await team(teamId)).toMatchObject({
        plan: "pro",
        planQuota: 110_000,
        planStatus: "active",
        stripeCustomerId: "cus_invoice",
        stripeSubscriptionId: "sub_invoice",
        stripeOverageItemId: "si_sub_invoice_overage",
      });
      expect(await team(otherTeamId)).toMatchObject({ plan: "free", stripeCustomerId: null });
      const ledger = await db.select().from(schema.stripeEvents);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ id: "evt_invoice", type: "invoice.payment_succeeded" });
      const purchases = await db.select().from(schema.metaConversionOutbox);
      expect(purchases).toHaveLength(1);
      expect(purchases[0]).toMatchObject({
        eventName: "Purchase",
        attemptId,
        consentReceiptId: consent.proof.id,
        livemode: false,
        stripeInvoiceId: "in_invoice",
        stripeSubscriptionId: "sub_invoice",
        status: "waiting",
        amountPaidMinor: 1_243,
        currency: "usd",
        eventTime: new Date(paidAt * 1_000),
      });
      expect(await db.select().from(schema.sendCheckoutAttempts)).toEqual(beforeAttempt);
      expect(await db.select().from(schema.metaCheckoutContexts)).toEqual(beforeContext);
      const planAfterRecovery = await team(teamId);
      const callsAfterRecovery = [...state.calls];
      const retrievesAfterRecovery = [...state.retrieves];
      expect(retrievesAfterRecovery).toEqual(["sub_invoice", "sub_invoice"]);
      expect(state.customers).toEqual([]);
      expect(state.checkouts).toEqual([]);
      expect(state.itemCreates).toEqual([]);
      expect(state.itemUpdates).toEqual([]);
      expect(state.meterEvents).toEqual([]);

      expect(await deliverInvoice()).toBe(200);
      expect(state.calls).toEqual(callsAfterRecovery);
      expect(state.retrieves).toEqual(retrievesAfterRecovery);
      expect(await team(teamId)).toEqual(planAfterRecovery);
      expect(await team(otherTeamId)).toMatchObject({ plan: "free", stripeCustomerId: null });
      expect(await db.select().from(schema.stripeEvents)).toEqual(ledger);
      expect(await db.select().from(schema.metaConversionOutbox)).toEqual(purchases);
      expect(await db.select().from(schema.sendCheckoutAttempts)).toEqual(beforeAttempt);
      expect(await db.select().from(schema.metaCheckoutContexts)).toEqual(beforeContext);
      expect(http).not.toHaveBeenCalled();
    } finally {
      http.mockRestore();
    }
  });

  it("rolls back the ledger row when Stripe cannot be reached, so the retry is processed", async () => {
    const teamId = await customerTeam();
    const recoveredSubscription = subscription("sub_gone", "cus_1", "active");
    const payload = subEvent("customer.subscription.created", recoveredSubscription);

    await expect(deliver(payload)).rejects.toThrow("No such subscription");
    expect(await db.select().from(schema.stripeEvents)).toEqual([]);
    expect(await team(teamId)).toMatchObject({ plan: "free", stripeSubscriptionId: null });

    // Redelivery must process the same event after the transient provider failure.
    state.subscriptions.sub_gone = recoveredSubscription;
    expect(await deliver(payload)).toBe(200);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planStatus: "active",
      stripeSubscriptionId: "sub_gone",
    });
    expect(await db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents)).toEqual([
      { id: JSON.parse(payload).id },
    ]);

    const retrievesAfterRecovery = state.retrieves.length;
    expect(await deliver(payload)).toBe(200);
    expect(state.retrieves).toHaveLength(retrievesAfterRecovery);
    expect(await db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents)).toEqual([
      { id: JSON.parse(payload).id },
    ]);
  });
});

describe("purgeStripeEvents", () => {
  it("drops only rows older than the retention window", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    await db.insert(schema.stripeEvents).values([
      { id: "evt_old", type: "x", receivedAt: new Date("2026-02-01T00:00:00Z") },
      { id: "evt_recent", type: "x", receivedAt: new Date("2026-05-01T00:00:00Z") },
    ]);
    expect(await purgeStripeEvents(db, now)).toBe(1);
    expect(await db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents)).toEqual([
      { id: "evt_recent" },
    ]);
  });
});

describe("reconcileTeamPlan", () => {
  it("applies the customer's newest subscription; no customer or no subscription is a no-op", async () => {
    const teamId = await customerTeam();
    const noCustomer = await createTeam(db, "other");
    await reconcileTeamPlan(deps(), noCustomer);
    await reconcileTeamPlan(deps(), teamId);
    expect(state.listParams).toMatchObject({ customer: "cus_1", status: "all", limit: 1 });
    expect(await team(teamId)).toMatchObject({ plan: "free", planStatus: "none" });

    state.subscriptions.sub_old = subscription("sub_old", "cus_1", "canceled");
    state.subscriptions.sub_new = subscription(
      "sub_new",
      "cus_1",
      "active",
      "millionsend_scale_500k_monthly",
    );
    await reconcileTeamPlan(deps(), teamId);
    // Expansions ride on the retrieve: a list nests them one level deeper than Stripe allows.
    expect(state.listParams?.expand).toBeUndefined();
    expect(state.retrieves).toContain("sub_new");
    expect(state.retrieveParams?.expand).toEqual([
      "items.data.price.product",
      "schedule.phases.items.price",
    ]);
    expect(await team(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 550_000,
      planStatus: "active",
      stripeSubscriptionId: "sub_new",
    });
  });
});

describe("cancelTeamSubscription", () => {
  it("cancels the live subscription immediately and clears the plan; no subscription is a no-op", async () => {
    const teamId = await customerTeam();
    await cancelTeamSubscription(deps(), teamId);
    expect(state.cancels).toEqual([]);

    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active", undefined, {
      overageKey: "millionsend_pro_100k_overage",
    });
    await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1));
    await cancelTeamSubscription(deps(), teamId);
    expect(state.cancels).toEqual(["sub_1"]);
    expect(await team(teamId)).toEqual({
      plan: "free",
      planQuota: null,
      planStatus: "canceled",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: null,
      stripeOverageItemId: null,
      overageEnabled: false,
      pendingRung: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });

    // Already ended in Stripe (e.g. from the dashboard): nothing to cancel.
    await db
      .update(schema.teams)
      .set({ stripeSubscriptionId: "sub_1", plan: "pro", planStatus: "active" })
      .where(eq(schema.teams.id, teamId));
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "canceled");
    await cancelTeamSubscription(deps(), teamId);
    expect(state.cancels).toEqual(["sub_1"]);
    expect(await team(teamId)).toMatchObject({ plan: "free", stripeSubscriptionId: null });
  });
});

describe("the system plan", () => {
  it("is never written by Stripe: a webhook or a reconcile for its customer leaves the row alone", async () => {
    const teamId = await customerTeam();
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, teamId));
    state.subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    expect(
      await deliver(subEvent("customer.subscription.created", state.subscriptions.sub_1)),
    ).toBe(200);
    await reconcileTeamPlan(deps(), teamId);
    expect(await team(teamId)).toMatchObject({
      plan: "system",
      planQuota: null,
      planStatus: "none",
      stripeSubscriptionId: null,
      stripeOverageItemId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    expect(logs.filter((m) => m.includes("system plan"))).toHaveLength(2);
  });
});
