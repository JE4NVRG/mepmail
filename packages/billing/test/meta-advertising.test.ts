import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "../../db/node_modules/@electric-sql/pglite/dist/index.js";
import type { MetaCheckoutAdvertising } from "../src/meta-advertising.js";
import {
  dispatchMetaConversions,
  prepareMetaCheckout,
  readAdvertisingConsent,
  recordMetaCheckout,
  recordMetaPurchase,
  saveAdvertisingConsent,
} from "../src/meta-advertising.js";
import type { MetaConversionConfig, MetaFetch } from "../src/meta-conversions.js";
import type { BillingStripe } from "../src/stripe.js";

type Attempt = typeof schema.sendCheckoutAttempts.$inferSelect;
const now = new Date("2026-10-03T03:00:00.000Z");
const capturedAt = new Date(now.getTime() - 5_000);
const created = Math.floor(now.getTime() / 1_000) - 4;
const paidAt = created + 2;
const config: MetaConversionConfig = {
  enabled: true,
  datasetId: "123456789",
  accessToken: "offline-private-token",
  graphVersion: "v23.0",
  mode: "production",
};
const fbp = "fb.1.1790996395000.123456789";
const fbc = "fb.1.1790996395000.ClickId-abc_DEF";
const contexts = schema.metaCheckoutContexts;
const outbox = schema.metaConversionOutbox;
let client: PGlite;
let db: Db;

/* Only RAM test tables: no project migrator, real DB, filesystem dataDir, or connection pool.
 * Installed PGlite 0.3.14: preliminary RAM qualification only. It serializes transactions
 * on one connection. These tests establish ordering and
 * revalidation, not production PostgreSQL multi-connection/MVCC lock guarantees. */
const ddl = `
CREATE TABLE send_checkout_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL, created_by text,
 status text NOT NULL, rung text NOT NULL, livemode boolean NOT NULL, stripe_customer_id text NOT NULL,
 idempotency_key text NOT NULL UNIQUE, parameters jsonb NOT NULL, stripe_session_id text UNIQUE,
 checkout_url text, first_requested_at timestamptz, lease_token uuid, lease_until timestamptz,
 resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE advertising_consent_receipts (
 id uuid PRIMARY KEY, proof_nonce uuid NOT NULL, policy_version text NOT NULL,
 state text NOT NULL CHECK (state IN ('accepted','denied')), user_id text, source_url text,
 accepted_at timestamptz, revoked_at timestamptz, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (state <> 'accepted' OR (accepted_at IS NOT NULL AND revoked_at IS NULL))
);
CREATE TABLE meta_checkout_contexts (
 attempt_id uuid PRIMARY KEY REFERENCES send_checkout_attempts(id) ON DELETE CASCADE,
 consent_receipt_id uuid REFERENCES advertising_consent_receipts(id) ON DELETE RESTRICT,
 eligible boolean NOT NULL, source_url text, fbp text, fbc text,
 captured_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 CHECK (NOT eligible OR (consent_receipt_id IS NOT NULL AND source_url IS NOT NULL AND (fbp IS NOT NULL OR fbc IS NOT NULL)))
);
CREATE TABLE meta_conversion_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 event_name text NOT NULL CHECK (event_name IN ('InitiateCheckout','Purchase')),
 attempt_id uuid NOT NULL REFERENCES meta_checkout_contexts(attempt_id) ON DELETE CASCADE,
 consent_receipt_id uuid NOT NULL REFERENCES advertising_consent_receipts(id) ON DELETE RESTRICT,
 livemode boolean NOT NULL, stripe_session_id text, stripe_invoice_id text, stripe_subscription_id text,
 event_time timestamptz NOT NULL, amount_paid_minor integer, currency text, confirmation jsonb,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('waiting','pending','leased','sent','cancelled','dead')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, expires_at timestamptz NOT NULL,
 last_failure text, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT meta_conversion_purchase_check CHECK (event_name <> 'Purchase' OR (stripe_invoice_id IS NOT NULL AND stripe_subscription_id IS NOT NULL AND amount_paid_minor IS NOT NULL AND amount_paid_minor > 0 AND currency IS NOT NULL)),
 CHECK (event_name <> 'InitiateCheckout' OR stripe_session_id IS NOT NULL),
 CHECK ((status = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
 CHECK (status <> 'waiting' OR (event_name = 'Purchase' AND confirmation IS NOT NULL)),
 CHECK (attempts >= 0)
);
CREATE UNIQUE INDEX meta_conversion_session_idx ON meta_conversion_outbox(livemode,stripe_session_id) WHERE event_name='InitiateCheckout';
CREATE UNIQUE INDEX meta_conversion_invoice_idx ON meta_conversion_outbox(livemode,stripe_invoice_id) WHERE event_name='Purchase';
CREATE UNIQUE INDEX meta_conversion_acquisition_idx ON meta_conversion_outbox(livemode,stripe_subscription_id) WHERE event_name='Purchase';
`;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(ddl);
  db = drizzle(client, { schema }) as unknown as Db;
});
beforeEach(async () => {
  await client.exec(
    "TRUNCATE meta_conversion_outbox, meta_checkout_contexts, advertising_consent_receipts, send_checkout_attempts CASCADE",
  );
});
afterAll(async () => {
  await client?.close();
});

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Incomplete test fixture or missing asserted result");
  return value;
}

function providerGraph(attempt: Attempt) {
  const metadata = { mepmail_send_checkout: attempt.id, team_id: attempt.teamId };
  const prices = ["price_send_base", "price_send_overage"];
  const price = (id: string) => ({
    id,
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created,
    currency: "usd",
    livemode: false,
    metadata: { millionsend_rung: "pro_100k" },
    product: "prod_send",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    type: "recurring",
    unit_amount: 2_000,
    unit_amount_decimal: "2000",
    lookup_key: id,
    nickname: null,
    custom_unit_amount: null,
    tiers_mode: null,
    transform_quantity: null,
    tax_behavior: "unspecified",
  });
  const invoice = {
    id: "in_send",
    object: "invoice",
    customer: "cus_send",
    livemode: false,
    status: "paid",
    billing_reason: "subscription_create",
    currency: "usd",
    amount_due: 1_243,
    amount_paid: 1_243,
    amount_remaining: 0,
    total: 1_243,
    subtotal: 2_000,
    total_discount_amounts: [{ amount: 757, discount: "di_send" }],
    metadata,
    created,
    customer_email: "private@example.invalid",
    customer_name: "Private fixture",
    description: "private invoice details",
    status_transitions: {
      finalized_at: created,
      paid_at: paidAt,
      marked_uncollectible_at: null,
      voided_at: null,
    },
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: "sub_send", metadata },
    },
    lines: {
      object: "list",
      has_more: false,
      url: "/v1/invoices/in_send/lines",
      data: [
        {
          id: "il_send",
          object: "line_item",
          amount: 2_000,
          currency: "usd",
          quantity: 1,
          pricing: {
            type: "price_details",
            price_details: { price: prices[0], product: "prod_send" },
          },
          parent: {
            type: "subscription_item_details",
            subscription_item_details: {
              subscription: "sub_send",
              subscription_item: "si_send_0",
              proration: false,
            },
          },
          period: { start: created, end: created + 2_592_000 },
          description: "private invoice line",
        },
      ],
    },
  } as unknown as Stripe.Invoice;
  const subscription = {
    id: "sub_send",
    object: "subscription",
    customer: "cus_send",
    livemode: false,
    status: "active",
    metadata,
    trial_start: null,
    trial_end: null,
    created,
    start_date: created,
    cancel_at: null,
    canceled_at: null,
    cancel_at_period_end: false,
    collection_method: "charge_automatically",
    latest_invoice: "in_send",
    currency: "usd",
    items: {
      object: "list",
      has_more: false,
      url: "/v1/subscription_items?subscription=sub_send",
      data: prices.map((id, i) => ({
        id: `si_send_${i}`,
        object: "subscription_item",
        created,
        current_period_start: created,
        current_period_end: created + 2_592_000,
        quantity: 1,
        price: price(id),
        metadata: {},
      })),
    },
  } as unknown as Stripe.Subscription;
  const openSession = {
    id: "cs_send",
    object: "checkout.session",
    customer: "cus_send",
    subscription: null,
    livemode: false,
    mode: "subscription",
    status: "open",
    payment_status: "unpaid",
    created,
    expires_at: created + 1_800,
    metadata,
    client_reference_id: attempt.teamId,
    url: "https://checkout.stripe.com/c/pay/offline",
    currency: "usd",
    amount_subtotal: 2_000,
    amount_total: 1_243,
    customer_details: { email: "private@example.invalid", name: "Private fixture", phone: null },
    line_items: {
      object: "list",
      has_more: false,
      url: "/v1/checkout/sessions/cs_send/line_items",
      data: [
        {
          id: "li_send",
          object: "item",
          amount_subtotal: 2_000,
          amount_discount: 757,
          amount_total: 1_243,
          currency: "usd",
          quantity: 1,
          price: price(required(prices[0])),
        },
      ],
    },
  } as unknown as Stripe.Checkout.Session;
  const completeSession = {
    ...openSession,
    status: "complete",
    payment_status: "paid",
    subscription: "sub_send",
    url: null,
  } as Stripe.Checkout.Session;
  const event = {
    id: "evt_send",
    object: "event",
    type: "invoice.payment_succeeded",
    created: paidAt,
    livemode: false,
    data: { object: invoice },
    api_version: null,
    pending_webhooks: 1,
    request: null,
  } as unknown as Stripe.Event;
  return { invoice, subscription, openSession, completeSession, event };
}

function attemptInput(sessionId: string | null = "cs_send"): Attempt {
  const id = randomUUID();
  const teamId = randomUUID();
  return {
    id,
    teamId,
    createdBy: "user_owner",
    status: "prepared",
    rung: "pro_100k",
    livemode: false,
    stripeCustomerId: "cus_send",
    idempotencyKey: `send-${id}`,
    stripeSessionId: sessionId,
    checkoutUrl: null,
    parameters: {
      mode: "subscription",
      customer: "cus_send",
      client_reference_id: teamId,
      metadata: { mepmail_send_checkout: id },
      subscription_data: { metadata: { mepmail_send_checkout: id } },
      line_items: [{ price: "price_send_base", quantity: 1 }, { price: "price_send_overage" }],
    },
    firstRequestedAt: null,
    leaseToken: null,
    leaseUntil: null,
    resolvedAt: null,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

async function fixture(sessionId: string | null = "cs_send", anonymous = false) {
  const attempt = attemptInput(sessionId);
  await db.insert(schema.sendCheckoutAttempts).values(attempt);
  const saved = await saveAdvertisingConsent(
    db,
    {
      granted: true,
      proof: null,
      userId: anonymous ? null : attempt.createdBy,
      sourceUrl: "https://mepmail.dev/pricing?email=private#fragment",
    },
    capturedAt,
  );
  const advertising: MetaCheckoutAdvertising = {
    config,
    proof: saved.proof,
    cookieHeader: `_fbp=${fbp}; _fbc=${fbc}`,
  };
  await db.transaction(async (tx) => {
    await prepareMetaCheckout(tx as unknown as Db, attempt, advertising, capturedAt);
  });
  return { attempt, advertising, proof: saved.proof, ...providerGraph(attempt) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function checkout(f: Fixture, session = f.openSession) {
  await db.transaction(async (tx) => {
    await recordMetaCheckout(tx as unknown as Db, f.attempt, session, f.advertising, now);
  });
}
async function purchase(f: Fixture, event = f.event) {
  await db.transaction(async (tx) => {
    await recordMetaPurchase(tx as unknown as Db, event, f.subscription, false, config, now);
  });
}
async function due(at = now) {
  await db.update(outbox).set({ nextAttemptAt: at });
}
async function rows() {
  return db.select().from(outbox);
}
const acceptingFetch = () =>
  vi.fn<MetaFetch>(async () => ({ status: 200, json: async () => ({ events_received: 1 }) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function provider(f: Pick<Fixture, "completeSession">) {
  const forbidden = vi.fn(async (): Promise<never> => {
    throw new Error("Financial provider operations are forbidden in advertising tests");
  });
  const retrieve = vi.fn(
    async (_id: string, _params?: Stripe.Checkout.SessionRetrieveParams) => f.completeSession,
  );
  const list = vi.fn(
    async (_params: Stripe.Checkout.SessionListParams) =>
      ({
        object: "list",
        url: "/v1/checkout/sessions",
        has_more: false,
        data: [f.completeSession],
      }) as Stripe.ApiList<Stripe.Checkout.Session>,
  );
  const stripe: BillingStripe = {
    prices: { list: forbidden },
    customers: { create: forbidden },
    subscriptions: { retrieve: forbidden, list: forbidden, update: forbidden, cancel: forbidden },
    subscriptionItems: { create: forbidden, update: forbidden, del: forbidden },
    subscriptionSchedules: { create: forbidden, update: forbidden, release: forbidden },
    billing: { meterEvents: { create: forbidden } },
    checkout: { sessions: { create: forbidden, retrieve, list } },
    billingPortal: { sessions: { create: forbidden } },
    webhooks: {
      constructEvent: () => {
        throw new Error("No webhook reconstruction in advertising worker");
      },
    },
  };
  return { stripe, retrieve, list, forbidden };
}

describe("RAM advertising consent and durable outbox", () => {
  it("rejects a Purchase with NULL cash amount using the exact SQL check", async () => {
    const f = await fixture();
    await expect(
      db.insert(outbox).values({
        eventName: "Purchase",
        attemptId: f.attempt.id,
        consentReceiptId: f.proof.id,
        livemode: false,
        stripeInvoiceId: "in_null_cash",
        stripeSubscriptionId: "sub_null_cash",
        amountPaidMinor: null,
        currency: "usd",
        eventTime: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "meta_conversion_purchase_check" },
    });
    expect(await rows()).toEqual([]);
  });
  it("does zero DB or provider work when feature configuration is disabled", async () => {
    const attempt = attemptInput();
    const graph = providerGraph(attempt);
    const untouched = new Proxy(
      {},
      {
        get: () => {
          throw new Error("Disabled feature accessed the database");
        },
      },
    ) as Db;
    const disabled = { ...config, enabled: false };
    const advertising = { config: disabled, proof: null, cookieHeader: null };
    await prepareMetaCheckout(untouched, attempt, advertising, now);
    await recordMetaCheckout(untouched, attempt, graph.openSession, advertising, now);
    await recordMetaPurchase(untouched, graph.event, graph.subscription, false, disabled, now);
    const fetch = acceptingFetch();
    const p = provider(graph);
    expect(await dispatchMetaConversions(untouched, disabled, { fetch, stripe: p.stripe })).toEqual(
      { considered: 0, sent: 0 },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(p.retrieve).not.toHaveBeenCalled();
    expect(p.forbidden).not.toHaveBeenCalled();
  });

  it("freezes the initial matching/source/time and binds an anonymous accepted receipt once", async () => {
    const f = await fixture("cs_send", true);
    const [before] = await db.select().from(contexts);
    expect(before).toMatchObject({
      eligible: true,
      sourceUrl: "https://mepmail.dev/pricing",
      fbp,
      fbc,
      capturedAt,
    });
    await prepareMetaCheckout(
      db,
      f.attempt,
      { ...f.advertising, cookieHeader: "_fbp=fb.1.1790996395000.9999" },
      now,
    );
    expect((await db.select().from(contexts))[0]).toEqual(before);
    const [receipt] = await db.select().from(schema.advertisingConsentReceipts);
    expect(receipt?.userId).toBe(f.attempt.createdBy);
  });

  it("does not backfill an initially ineligible prepared context after later consent", async () => {
    const attempt = attemptInput();
    await db.insert(schema.sendCheckoutAttempts).values(attempt);
    await prepareMetaCheckout(
      db,
      attempt,
      { config, proof: null, cookieHeader: `_fbp=${fbp}` },
      capturedAt,
    );
    const saved = await saveAdvertisingConsent(
      db,
      { granted: true, proof: null, userId: attempt.createdBy, sourceUrl: "https://mepmail.dev/" },
      now,
    );
    const advertising = { config, proof: saved.proof, cookieHeader: `_fbp=${fbp}` };
    await prepareMetaCheckout(db, attempt, advertising, now);
    await recordMetaCheckout(db, attempt, providerGraph(attempt).openSession, advertising, now);
    expect((await db.select().from(contexts))[0]).toMatchObject({
      eligible: false,
      sourceUrl: null,
      fbp: null,
      consentReceiptId: null,
    });
    expect(await rows()).toHaveLength(0);
  });

  it("deduplicates Session, Invoice and acquisition replays with real unique indexes", async () => {
    const f = await fixture();
    await checkout(f);
    await purchase(f);
    const original = await rows();
    await checkout(f);
    await purchase(f);
    await purchase(f, {
      ...f.event,
      id: "evt_replay",
      data: { object: { ...f.invoice, id: "in_another_same_acquisition" } },
    } as Stripe.Event);
    expect(await rows()).toEqual(original);
    expect(original.map((row) => row.eventName).sort()).toEqual(["InitiateCheckout", "Purchase"]);
  });

  it("never queues an InitiateCheckout for a forged or conflicting Session", async () => {
    const f = await fixture();
    for (const patch of [
      { id: "cs_forged" },
      { customer: "cus_other" },
      { client_reference_id: "other_team" },
      { metadata: { mepmail_send_checkout: randomUUID() } },
      { livemode: true },
    ]) {
      await checkout(f, { ...f.openSession, ...patch } as Stripe.Checkout.Session);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("rolls waiting Purchase back with its financial transaction and writes one row on replay", async () => {
    const f = await fixture(null);
    const http = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Financial transaction must never send advertising HTTP");
    });
    try {
      await expect(
        db.transaction(async (transaction) => {
          await recordMetaPurchase(
            transaction as unknown as Db,
            f.event,
            f.subscription,
            false,
            config,
            now,
          );
          throw new Error("financial_projection_rollback");
        }),
      ).rejects.toThrow("financial_projection_rollback");
      expect(await rows()).toHaveLength(0);
      await purchase(f);
      await purchase(f);
      const saved = await rows();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        status: "waiting",
        stripeInvoiceId: "in_send",
        amountPaidMinor: 1_243,
      });
      expect(http).not.toHaveBeenCalled();
    } finally {
      http.mockRestore();
    }
  });

  it("persists waiting Purchase before a lost Session reply, retaining only selected non-PII confirmation facts", async () => {
    const f = await fixture(null);
    await purchase(f);
    const [row] = await rows();
    expect(row).toMatchObject({
      status: "waiting",
      stripeSessionId: null,
      stripeInvoiceId: "in_send",
      amountPaidMinor: 1_243,
      currency: "usd",
      eventTime: new Date(paidAt * 1_000),
    });
    expect(row?.confirmation).toMatchObject({ type: "invoice.payment_succeeded" });
    expect(JSON.stringify(row?.confirmation)).not.toMatch(
      /private|email|description|invoice_pdf|customer_name|raw|contact/,
    );
  });

  it("resolves exactly one canonical Session with readonly list/retrieve and sends original USD 12.43", async () => {
    const f = await fixture(null);
    await purchase(f);
    await due();
    const [before] = await rows();
    const p = provider(f);
    const fetch = acceptingFetch();
    expect(await dispatchMetaConversions(db, config, { ...p, fetch, now: () => now })).toEqual({
      considered: 1,
      sent: 1,
    });
    expect(p.list).toHaveBeenCalledWith({ customer: "cus_send", limit: 100 });
    expect(p.retrieve).toHaveBeenCalledWith("cs_send", { expand: ["line_items"] });
    expect(p.forbidden).not.toHaveBeenCalled();
    const body = JSON.parse(required(fetch.mock.calls[0])[1].body);
    expect(body.data[0]).toMatchObject({
      event_id: required(before).eventId,
      event_time: paidAt,
      custom_data: { value: 12.43, currency: "USD" },
      event_source_url: "https://mepmail.dev/pricing",
    });
    expect((await rows())[0]).toMatchObject({
      status: "sent",
      stripeSessionId: "cs_send",
      confirmation: null,
    });
  });

  it("keeps ambiguous or failed readonly Session resolution waiting without a provider POST", async () => {
    const f = await fixture(null);
    await purchase(f);
    await due();
    const p = provider(f);
    const fetch = acceptingFetch();
    p.list.mockResolvedValueOnce({
      object: "list",
      url: "/v1/checkout/sessions",
      has_more: false,
      data: [f.completeSession, { ...f.completeSession, id: "cs_other" }],
    });
    expect(await dispatchMetaConversions(db, config, { ...p, fetch, now: () => now })).toEqual({
      considered: 1,
      sent: 0,
    });
    expect(p.retrieve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({
      status: "waiting",
      attempts: 1,
      lastFailure: "session_unconfirmed",
    });
    await due();
    p.list.mockRejectedValueOnce(new Error("Private Stripe response details"));
    await dispatchMetaConversions(db, config, { ...p, fetch, now: () => now });
    expect((await rows())[0]).toMatchObject({
      status: "waiting",
      attempts: 2,
      lastFailure: "session_unconfirmed",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(p.forbidden).not.toHaveBeenCalled();
  });

  it("retries with identical persisted UUID/time/value, without repeating canonical resolution or checkout", async () => {
    const f = await fixture(null);
    await purchase(f);
    await due();
    const p = provider(f);
    const fetch = vi
      .fn<MetaFetch>()
      .mockResolvedValueOnce({ status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ events_received: 1 }) });
    expect((await dispatchMetaConversions(db, config, { ...p, fetch, now: () => now })).sent).toBe(
      0,
    );
    const [pending] = await rows();
    expect(pending).toMatchObject({ status: "pending", attempts: 1, amountPaidMinor: 1_243 });
    const retryAt = new Date(now.getTime() + 60_001);
    expect(
      (await dispatchMetaConversions(db, config, { ...p, fetch, now: () => retryAt })).sent,
    ).toBe(1);
    expect(required(fetch.mock.calls[0])[1].body).toBe(required(fetch.mock.calls[1])[1].body);
    expect(p.list).toHaveBeenCalledTimes(1);
    expect(p.retrieve).toHaveBeenCalledTimes(1);
    expect(p.forbidden).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({
      eventId: required(pending).eventId,
      eventTime: required(pending).eventTime,
      amountPaidMinor: 1_243,
      status: "sent",
      attempts: 2,
    });
  });

  it("cancels waiting and leased deliveries on anonymous cookie withdrawal and never revives the old context", async () => {
    const f = await fixture("cs_send", true);
    await checkout(f);
    await purchase(f);
    await db
      .update(outbox)
      .set({
        status: "leased",
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 60_000),
      })
      .where(eq(outbox.eventName, "InitiateCheckout"));
    await saveAdvertisingConsent(
      db,
      { granted: false, proof: f.proof, userId: null, sourceUrl: null },
      now,
    );
    expect(
      (await rows()).every(
        (row) =>
          row.status === "cancelled" &&
          row.leaseToken === null &&
          row.leaseUntil === null &&
          row.confirmation === null,
      ),
    ).toBe(true);
    expect((await db.select().from(contexts))[0]).toMatchObject({
      eligible: false,
      fbp: null,
      fbc: null,
    });
    expect(await readAdvertisingConsent(db, f.proof, now)).toMatchObject({ state: "denied" });
    const grantedAgain = await saveAdvertisingConsent(
      db,
      {
        granted: true,
        proof: f.proof,
        userId: f.attempt.createdBy,
        sourceUrl: "https://mepmail.dev/",
      },
      now,
    );
    expect(grantedAgain.proof.id).not.toBe(f.proof.id);
    await prepareMetaCheckout(db, f.attempt, { ...f.advertising, proof: grantedAgain.proof }, now);
    await checkout(f);
    await purchase(f);
    await due();
    const p = provider(f);
    const fetch = acceptingFetch();
    expect((await dispatchMetaConversions(db, config, { ...p, fetch, now: () => now })).sent).toBe(
      0,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(2);
  });

  it("rechecks completed withdrawal after readonly resolution started, before any Meta delivery", async () => {
    const f = await fixture(null);
    await purchase(f);
    await due();
    const p = provider(f);
    const fetch = acceptingFetch();
    const entered = deferred<void>();
    const release = deferred<Stripe.Checkout.Session>();
    p.retrieve.mockImplementationOnce(async () => {
      entered.resolve();
      return release.promise;
    });
    const dispatch = dispatchMetaConversions(db, config, { ...p, fetch, now: () => now });
    await entered.promise;
    await saveAdvertisingConsent(
      db,
      { granted: false, proof: f.proof, userId: null, sourceUrl: null },
      now,
    );
    release.resolve(f.completeSession);
    expect((await dispatch).sent).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ status: "cancelled", confirmation: null });
  });

  it("does no provider read or Meta POST after the checkout actor was deleted", async () => {
    const f = await fixture(null);
    await purchase(f);
    await due();
    // These are the committed ON DELETE SET NULL effects of the two auth-user FKs.
    await db.transaction(async (tx) => {
      await tx
        .update(schema.sendCheckoutAttempts)
        .set({ createdBy: null })
        .where(eq(schema.sendCheckoutAttempts.id, f.attempt.id));
      await tx
        .update(schema.advertisingConsentReceipts)
        .set({ userId: null })
        .where(eq(schema.advertisingConsentReceipts.id, f.proof.id));
    });
    const p = provider(f);
    const fetch = acceptingFetch();
    expect((await dispatchMetaConversions(db, config, { ...p, fetch, now: () => now })).sent).toBe(
      0,
    );
    expect(p.list).not.toHaveBeenCalled();
    expect(p.retrieve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ status: "cancelled", confirmation: null });
  });

  it("orders an in-flight bounded delivery before queued withdrawal, then prevents further dispatch", async () => {
    const f = await fixture();
    await checkout(f);
    await due();
    const p = provider(f);
    const entered = deferred<void>();
    const release = deferred<void>();
    const order: string[] = [];
    const fetch = vi.fn<MetaFetch>(async () => {
      order.push("send_started");
      entered.resolve();
      await release.promise;
      order.push("send_finished");
      return { status: 200, json: async () => ({ events_received: 1 }) };
    });
    const dispatch = dispatchMetaConversions(db, config, { ...p, fetch, now: () => now });
    await entered.promise;
    const withdrawal = saveAdvertisingConsent(
      db,
      { granted: false, proof: f.proof, userId: null, sourceUrl: null },
      now,
    ).then(() => {
      order.push("withdraw_done");
    });
    release.resolve();
    await dispatch;
    await withdrawal;
    expect(order).toEqual(["send_started", "send_finished", "withdraw_done"]);
    expect((await rows())[0]).toMatchObject({ status: "sent" });
    await dispatchMetaConversions(db, config, { ...p, fetch, now: () => now });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readAdvertisingConsent(db, f.proof, now)).toMatchObject({ state: "denied" });
  });

  it("expires undelivered events without Meta or financial calls", async () => {
    const f = await fixture();
    await checkout(f);
    await due();
    const p = provider(f);
    const fetch = acceptingFetch();
    await db.update(outbox).set({ expiresAt: now });
    expect((await dispatchMetaConversions(db, config, { ...p, fetch, now: () => now })).sent).toBe(
      0,
    );
    expect((await rows())[0]).toMatchObject({ status: "dead", lastFailure: "delivery_expired" });
    expect(fetch).not.toHaveBeenCalled();
    expect(p.forbidden).not.toHaveBeenCalled();
  });
});
