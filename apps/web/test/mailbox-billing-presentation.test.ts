import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  type BillingStripe,
  MAILBOX_CHECKOUT_METADATA_KEY,
  MAILBOX_SERVICE,
  MAILBOX_SERVICE_METADATA_KEY,
  type MailboxCatalog,
} from "@millionsend/billing";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatMailboxPrice,
  mailboxServiceNotice,
  safeMailboxCheckoutUrl,
  safeMailboxPaymentUrl,
} from "@/app/(dashboard)/mailboxes/mailbox-service-panel";
import { getStripe } from "@/server/billing";
import { mailboxBillingOffer } from "@/server/mailbox-billing";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, router } from "@/server/trpc";
import type { SendBillingContract } from "../../../packages/core/src/send-billing-contract";

vi.mock("@/server/billing", async (original) => ({
  ...(await original<typeof import("@/server/billing")>()),
  getStripe: vi.fn(),
}));
// This contract exercises real billing, router authority and optional migrations.
// Private MIME operations are unrelated and never called by these billing routes.
vi.mock("@/server/mailbox-content", () => ({
  getMailboxContent: vi.fn(),
  getMailboxContentList: vi.fn(),
  saveMailboxContentDraft: vi.fn(),
}));
vi.mock("@/server/mailbox-transport", () => ({ mailboxTransportMime: {} }));
vi.mock("@/server/mailbox-receiving", () => ({ mailboxReceivingDeps: vi.fn() }));

// Synthetic offline prices and credentials. No approved launch price is supplied by this test.
const price = {
  priceId: "price_mail_fixture",
  currency: "usd",
  unitAmount: 123,
  interval: "month" as const,
  storageBytesPerMailbox: 4096,
  includedOutboundPerMailbox: 17,
};
const catalog: MailboxCatalog = {
  livemode: false,
  checkoutPriceId: price.priceId,
  prices: [price],
};
const offer = {
  currency: price.currency,
  unitAmount: price.unitAmount,
  interval: price.interval,
  storageBytesPerMailbox: price.storageBytesPerMailbox,
  includedOutboundPerMailbox: price.includedOutboundPerMailbox,
  quotaScope: "mailbox" as const,
  includedMailboxes: 1,
  extraUnitAmount: null,
  localCurrency: null,
};
const sendingPeriodStart = new Date("2020-01-01");
const sendingPeriodEnd = new Date("2030-01-01");
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
let client: PGlite, db: Db, teamId: string, owner: string, member: string, customerId: string;
let sessionId: string, subscriptionId: string, checkoutUrl: string;
let sequence = 0;
let session: Stripe.Checkout.Session | null;
let stripe: BillingStripe;
let createSession: ReturnType<typeof vi.fn>;
let createCustomer: ReturnType<typeof vi.fn>;
function as(userId = owner, role: Context["role"] = "owner", extra: Partial<Context> = {}) {
  return caller({
    db,
    teamId,
    role,
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
    ...extra,
  });
}
async function lease(status: "creating" | "ready" | "completed" = "creating") {
  const [row] = await db
    .insert(schema.mailboxCheckouts)
    .values({
      teamId,
      createdBy: owner,
      status,
      stripeCustomerId: customerId,
      stripePriceId: price.priceId,
      seats: 3,
      livemode: false,
      idempotencyKey: `fixture:${teamId}`,
      ...offer,
      successUrl: "https://app.example.invalid/mailboxes?checkout=success",
      cancelUrl: "https://app.example.invalid/mailboxes",
      ...(status === "ready"
        ? {
            stripeSessionId: sessionId,
            checkoutUrl,
          }
        : {}),
      ...(status === "completed"
        ? { stripeSessionId: sessionId, stripeSubscriptionId: subscriptionId }
        : {}),
    })
    .returning();
  return row!;
}
beforeAll(async () => {
  client = new PGlite();
  for (const name of readdirSync(base)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    // The current main chain includes locks which require a transaction.
    await client.transaction(async (transaction) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await transaction.exec(statement);
    });
  }
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  const exists = await client.query<{ present: string | null }>(
    "select to_regclass('public.mailbox_management_requests')::text as present",
  );
  if (!exists.rows[0]?.present)
    for (const statement of readFileSync(extension + "0009_mailbox_management_requests.sql", "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await client.exec(statement);
});
beforeEach(async () => {
  sequence++;
  owner = `billing-owner-${sequence}`;
  member = `billing-member-${sequence}`;
  customerId = `cus_mail_fixture_${sequence}`;
  sessionId = `cs_mail_fixture_${sequence}`;
  subscriptionId = `sub_mail_fixture_${sequence}`;
  checkoutUrl = `https://checkout.stripe.com/c/pay/${sessionId}`;
  vi.stubEnv("IS_CLOUD", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_offline_fixture");
  vi.stubEnv("APP_BASE_URL", "https://app.example.invalid");
  vi.stubEnv("BILLING_MUTATIONS_PAUSED", "");
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_BILLING_CATALOG", JSON.stringify(catalog));
  vi.stubEnv("MAILBOX_BILLING_MANAGEMENT_ENABLED", "");
  const [team] = await db
    .insert(schema.teams)
    .values({
      name: "Offline Mail billing",
      slug: `mail-billing-${sequence}`,
      stripeCustomerId: customerId,
      plan: "pro",
      planStatus: "active",
      stripeSubscriptionId: `sub_sending_presentation_fixture_${sequence}`,
      currentPeriodStart: sendingPeriodStart,
      currentPeriodEnd: sendingPeriodEnd,
    })
    .returning({ id: schema.teams.id });
  teamId = team!.id;
  await db
    .update(schema.teams)
    .set({
      sendBillingContract: {
        version: 1,
        teamId,
        customerId,
        subscriptionId: `sub_sending_presentation_fixture_${sequence}`,
        baseItemId: `si_sending_presentation_fixture_${sequence}`,
        basePriceId: "price_sending_presentation_fixture",
        currency: "usd",
        baseAmountCents: 2900,
        billingInterval: "month",
        intervalCount: 1,
        included: 110_000,
        usageInterval: "month",
        regularMonthlyCents: 2900,
        financialPeriodStart: sendingPeriodStart.toISOString(),
        financialPeriodEnd: sendingPeriodEnd.toISOString(),
        usageAnchor: sendingPeriodStart.toISOString(),
        verifiedAt: new Date("2026-10-06").toISOString(),
      } satisfies SendBillingContract,
    })
    .where(eq(schema.teams.id, teamId));
  await db.insert(schema.user).values(
    [owner, member].map((id) => ({
      id,
      name: id,
      email: `${id}@example.invalid`,
      emailVerified: true,
    })),
  );
  await db.insert(schema.teamMembers).values([
    { teamId, userId: owner, role: "owner" },
    { teamId, userId: member, role: "member" },
  ]);
  session = null;
  createCustomer = vi.fn(async () => {
    throw new Error("Existing Customer must be reused");
  });
  createSession = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => {
    session = {
      id: sessionId,
      url: checkoutUrl,
      status: "open",
      mode: params.mode,
      customer: params.customer,
      livemode: false,
      metadata: params.metadata,
      client_reference_id: params.client_reference_id,
    } as unknown as Stripe.Checkout.Session;
    return session;
  });
  stripe = {
    customers: { create: createCustomer },
    subscriptions: {
      list: vi.fn(async () => ({ data: [], has_more: false })),
      retrieve: vi.fn(async () => {
        throw new Error("Unexpected subscription read");
      }),
    },
    checkout: {
      sessions: {
        create: createSession,
        retrieve: vi.fn(async () => session),
        list: vi.fn(async () => ({ data: session ? [session] : [], has_more: false })),
      },
    },
  } as unknown as BillingStripe;
  vi.mocked(getStripe).mockReset().mockReturnValue(stripe);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await client.close();
});

describe("sanitized Mail billing presentation and guarded Checkout", () => {
  it("publishes only approved terms, authority and pending quantity, without calling Stripe", async () => {
    expect(await as().mailboxes.billing()).toEqual({
      canManage: true,
      canPurchase: true,
      audience: "with_sending",
      sendingPlanRequired: false,
      earlyAccessRequired: false,
      availability: "available",
      offer,
      offers: [
        { ...offer, offerId: expect.stringMatching(/^mbo_[A-Za-z0-9_-]{43}$/), trialDays: 0 },
      ],
      defaultOfferId: expect.stringMatching(/^mbo_[A-Za-z0-9_-]{43}$/),
      pendingOfferId: null,
      pendingOffer: null,
      checkoutPending: false,
      pendingCheckoutSeats: null,
      management: {
        canReconcile: false,
        canCancel: false,
        canResume: false,
        canAdjust: false,
        canIncrease: false,
        pending: false,
        requestedSeats: null,
        scheduledSeats: null,
        effectiveAt: null,
      },
    });
    expect(getStripe).not.toHaveBeenCalled();
    expect(await as().mailboxes.service()).toEqual({
      active: false,
      licenseKind: "none",
      unlimitedSeats: false,
      unlimitedOutbound: false,
      resourcePolicyActive: false,
      status: "inactive",
      seats: 0,
      reservedSeats: 0,
      storageBytesPerMailbox: 0,
      includedOutboundPerMailbox: 0,
      quotaScope: "mailbox",
      includedMailboxes: 1,
      trial: null,
      periodStart: null,
      periodEnd: null,
      usagePeriodStart: null,
      usagePeriodEnd: null,
      cancelAtPeriodEnd: false,
      cancelAt: null,
    });
    const serialized = JSON.stringify(await as().mailboxes.billing());
    for (const hidden of [
      "priceId",
      price.priceId,
      "stripeCustomerId",
      customerId,
      "livemode",
      "idempotencyKey",
      "checkoutId",
      "sk_test_offline_fixture",
    ])
      expect(serialized).not.toContain(hidden);
  });
  it.each([
    ["IS_CLOUD", "false"],
    ["IS_CLOUD", "0"],
    ["STRIPE_SECRET_KEY", ""],
    ["STRIPE_SECRET_KEY", "invalid"],
    ["MAILBOX_BILLING_CATALOG", ""],
    ["MAILBOX_BILLING_CATALOG", "{}"],
    ["MAILBOX_BILLING_CATALOG", "{broken"],
    ["MAILBOX_BILLING_CATALOG", JSON.stringify({ ...catalog, checkoutPriceId: null })],
    [
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({ ...catalog, checkoutPriceId: "price_not_approved" }),
    ],
    ["MAILBOX_BILLING_CATALOG", JSON.stringify({ ...catalog, livemode: true })],
    ["MAILBOX_BILLING_CATALOG", JSON.stringify({ ...catalog, prices: [price, price] })],
    ["BILLING_MUTATIONS_PAUSED", "1"],
    ["BILLING_MUTATIONS_PAUSED", "true"],
  ])("closes purchase when %s is unavailable (%s), with no SDK call", async (key, value) => {
    vi.stubEnv(key, value);
    expect(mailboxBillingOffer()).toBeNull();
    expect(await as().mailboxes.billing()).toMatchObject({
      canPurchase: false,
      availability: "unavailable",
      offer: null,
    });
    await expect(as().mailboxes.checkout({ seats: 2 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "mailbox_billing_unavailable",
    });
    expect(getStripe).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
  });
  it("closes a new purchase while new subscriptions are paused, with its own notice", async () => {
    vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", "true");
    const presentation = await as().mailboxes.billing();
    expect(presentation).toMatchObject({
      canPurchase: false,
      availability: "subscriptions_paused",
    });
    expect(mailboxServiceNotice(presentation.availability, null)).toBe("subscriptionsPausedBody");
    await expect(as().mailboxes.checkout({ seats: 2 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "subscriptions_paused",
    });
    expect(getStripe).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
    vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", "false");
    expect((await as().mailboxes.billing()).canPurchase).toBe(true);
  });
  it("interprets string false as an unpaused flag and requires the current administrative role", async () => {
    vi.stubEnv("BILLING_MUTATIONS_PAUSED", "false");
    expect((await as().mailboxes.billing()).canPurchase).toBe(true);
    expect(await as(member, "owner").mailboxes.billing()).toMatchObject({
      canManage: false,
      canPurchase: false,
      availability: "forbidden",
    });
    await expect(as(member, "owner").mailboxes.checkout({ seats: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, owner)));
    await expect(as().mailboxes.checkout({ seats: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await db
      .update(schema.teamMembers)
      .set({ role: "admin" })
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, member)));
    expect((await as(member, "member").mailboxes.billing()).canPurchase).toBe(true);
    expect(getStripe).not.toHaveBeenCalled();
  });
  it.each([0, 10001, 1.5])(
    "rejects invalid mailbox quantity %s before SDK access",
    async (seats) => {
      await expect(as().mailboxes.checkout({ seats })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(getStripe).not.toHaveBeenCalled();
    },
  );
  it("denies removed members, suspended teams and a disabled feature before reaching Stripe", async () => {
    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, member)));
    await expect(as(member).mailboxes.billing()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(member).mailboxes.checkout({ seats: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    expect((await as().mailboxes.billing()).canPurchase).toBe(false);
    await expect(as().mailboxes.checkout({ seats: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "false");
    await expect(as().mailboxes.billing()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as().mailboxes.checkout({ seats: 1 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(getStripe).not.toHaveBeenCalled();
  });
  it("offers recovery instead of another purchase for every registered subscription status", async () => {
    await db.insert(schema.mailboxSubscriptions).values({
      teamId,
      status: "active",
      seats: 2,
      storageBytesPerMailbox: 8192,
      includedOutboundPerMailbox: 31,
      periodStart: new Date(Date.now() - 86400000),
      periodEnd: new Date(Date.now() + 86400000),
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
    });
    for (const status of ["active", "trialing", "past_due", "canceled", "inactive"] as const) {
      await db
        .update(schema.mailboxSubscriptions)
        .set({ status })
        .where(eq(schema.mailboxSubscriptions.teamId, teamId));
      expect(await as().mailboxes.billing()).toMatchObject({
        canPurchase: false,
        availability: "existing_subscription",
      });
      expect(await as().mailboxes.service()).toMatchObject({
        status,
        seats: 2,
        storageBytesPerMailbox: 8192,
        includedOutboundPerMailbox: 31,
      });
      await expect(as().mailboxes.checkout({ seats: 2 })).rejects.toMatchObject({
        message: "subscription_exists",
      });
    }
    expect(getStripe).not.toHaveBeenCalled();
  });
  it("presents an internal license without a catalog or Stripe identifiers as a registered license", async () => {
    vi.stubEnv("MAILBOX_BILLING_CATALOG", "");
    await db.insert(schema.mailboxSubscriptions).values({
      teamId,
      status: "active",
      seats: 2,
      storageBytesPerMailbox: 8192,
      includedOutboundPerMailbox: 31,
      periodStart: new Date(Date.now() - 86400000),
      periodEnd: new Date(Date.now() + 86400000),
    });
    const presentation = await as().mailboxes.billing();
    const service = await as().mailboxes.service();
    expect(presentation).toMatchObject({
      canPurchase: false,
      availability: "existing_subscription",
      offer: null,
    });
    expect(service).toMatchObject({ active: true, seats: 2 });
    expect(mailboxServiceNotice(presentation.availability, service.periodEnd)).toBe(
      "existingLicenseBody",
    );
    await expect(as().mailboxes.checkout({ seats: 2 })).rejects.toMatchObject({
      message: "subscription_exists",
    });
    expect(getStripe).not.toHaveBeenCalled();
  });
  it("resumes the immutable pending quantity, hides its identifiers, and never creates another session", async () => {
    const pending = await lease("ready");
    session = {
      id: sessionId,
      mode: "subscription",
      customer: customerId,
      livemode: false,
      status: "open",
      url: checkoutUrl,
      metadata: {
        [MAILBOX_SERVICE_METADATA_KEY]: MAILBOX_SERVICE,
        [MAILBOX_CHECKOUT_METADATA_KEY]: pending.idempotencyKey,
        team_id: teamId,
      },
    } as unknown as Stripe.Checkout.Session;
    const result = await as().mailboxes.billing();
    expect(result).toMatchObject({
      canPurchase: true,
      checkoutPending: true,
      pendingCheckoutSeats: 3,
    });
    expect(JSON.stringify(result)).not.toContain(pending.id);
    expect(JSON.stringify(result)).not.toContain(pending.idempotencyKey);
    await expect(as().mailboxes.checkout({ seats: 4 })).rejects.toMatchObject({
      message: "conflict",
    });
    expect(getStripe).not.toHaveBeenCalled();
    expect(await as().mailboxes.checkout({ seats: 3 })).toEqual({ url: session.url });
    expect(createSession).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
  });
  it("does not offer changed terms to an old pending purchase", async () => {
    await lease();
    vi.stubEnv(
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({ ...catalog, prices: [{ ...price, unitAmount: price.unitAmount + 1 }] }),
    );
    expect(await as().mailboxes.billing()).toMatchObject({
      canPurchase: false,
      availability: "recovery_required",
      pendingCheckoutSeats: 3,
    });
    await expect(as().mailboxes.checkout({ seats: 3 })).rejects.toMatchObject({
      message: "conflict",
    });
    expect(getStripe).not.toHaveBeenCalled();
  });
  it("keeps a lost Customer request pending without disclosing its immutable parameters", async () => {
    await db.insert(schema.mailboxCustomerRequests).values({
      teamId,
      createdBy: owner,
      status: "creating",
      name: "Private snapshot",
      email: "snapshot@example.invalid",
      livemode: false,
      idempotencyKey: `private-nonce:${teamId}`,
    });
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: null })
      .where(eq(schema.teams.id, teamId));
    const result = await as().mailboxes.billing();
    expect(result).toMatchObject({
      canPurchase: false,
      sendingPlanRequired: true,
      checkoutPending: true,
      pendingCheckoutSeats: null,
    });
    expect(JSON.stringify(result)).not.toContain("Private snapshot");
    expect(JSON.stringify(result)).not.toContain("snapshot@example.invalid");
    await expect(as().mailboxes.checkout({ seats: 3 })).rejects.toMatchObject({
      message: "sending_plan_required",
    });
    expect(createCustomer).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    const [request] = await db
      .select()
      .from(schema.mailboxCustomerRequests)
      .where(eq(schema.mailboxCustomerRequests.teamId, teamId));
    expect(request).toMatchObject({ status: "creating", name: "Private snapshot" });
  });
  it("returns only the hosted URL, reuses Customer, preserves Send and grants no entitlement on success", async () => {
    const before = await client.query("select * from teams where id = $1", [teamId]);
    expect(await as().mailboxes.checkout({ seats: 4 })).toEqual({
      url: checkoutUrl,
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0]).toMatchObject({
      line_items: [{ price: price.priceId, quantity: 4 }],
      customer: customerId,
      success_url: "https://app.example.invalid/mailboxes?checkout=success",
      automatic_tax: { enabled: false },
    });
    expect(createCustomer).not.toHaveBeenCalled();
    expect((await client.query("select * from teams where id = $1", [teamId])).rows).toEqual(
      before.rows,
    );
    expect(await as().mailboxes.service()).toMatchObject({
      active: false,
      status: "inactive",
      seats: 0,
    });
    expect(
      await db
        .select()
        .from(schema.mailboxSubscriptions)
        .where(eq(schema.mailboxSubscriptions.teamId, teamId)),
    ).toHaveLength(0);
  });
  it("keeps a completed Checkout in confirmation/recovery without offering a second purchase", async () => {
    await lease("completed");
    const presentation = await as().mailboxes.billing();
    const service = await as().mailboxes.service();
    expect(presentation).toMatchObject({
      canPurchase: false,
      availability: "existing_subscription",
    });
    expect(service.active).toBe(false);
    expect(mailboxServiceNotice(presentation.availability, service.periodEnd)).toBe("existingBody");
    await expect(as().mailboxes.checkout({ seats: 3 })).rejects.toMatchObject({
      message: "subscription_exists",
    });
    expect(getStripe).not.toHaveBeenCalled();
  });
  it("rejects an arbitrary provider redirect without activating the plan", async () => {
    createSession.mockImplementation(async (params: Stripe.Checkout.SessionCreateParams) => ({
      id: sessionId,
      url: "https://other.example.invalid/pay",
      status: "open",
      mode: "subscription",
      customer: params.customer,
      livemode: false,
      metadata: params.metadata,
    }));
    await expect(as().mailboxes.checkout({ seats: 1 })).rejects.toMatchObject({
      message: "pending",
    });
    expect((await as().mailboxes.service()).active).toBe(false);
    expect(createSession).toHaveBeenCalledTimes(1);
  });
  it("sanitizes a lost provider response and rechecks the same pending intent without creating again", async () => {
    createSession.mockRejectedValueOnce(new Error("private fixture provider payload"));
    await expect(as().mailboxes.checkout({ seats: 2 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "pending",
    });
    expect(await as().mailboxes.billing()).toMatchObject({
      checkoutPending: true,
      pendingCheckoutSeats: 2,
    });
    await expect(as().mailboxes.checkout({ seats: 2 })).rejects.toMatchObject({
      message: "pending",
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createCustomer).not.toHaveBeenCalled();
    expect((await as().mailboxes.service()).active).toBe(false);
  });
  it("validates the browser redirect and formats the approved minor-unit amount", () => {
    expect(
      safeMailboxCheckoutUrl("https://checkout.stripe.com/c/pay/cs_fixture#confirmation"),
    ).toBe("https://checkout.stripe.com/c/pay/cs_fixture#confirmation");
    for (const value of [
      "javascript:alert(1)",
      "/pay",
      "http://checkout.stripe.com/pay",
      "https://checkout.stripe.com.other.invalid/pay",
      "https://other.invalid@checkout.stripe.com/pay",
      "https://checkout.stripe.com:8443/pay",
      "https://other.invalid/pay",
    ])
      expect(safeMailboxCheckoutUrl(value)).toBeNull();
    expect(formatMailboxPrice(123 * 3, "usd", "en")).toBe("$3.69");
    expect(formatMailboxPrice(123, "jpy", "en")).toBe("¥123");
    expect(formatMailboxPrice(500, "isk", "en").replace(/\s/g, "")).toBe("ISK5");
    expect(safeMailboxPaymentUrl("https://invoice.stripe.com/i/in_fixture")).toBe(
      "https://invoice.stripe.com/i/in_fixture",
    );
    for (const url of [
      "javascript:alert(1)",
      "https://invoice.stripe.com.other.invalid/i",
      "https://other.invalid@invoice.stripe.com/i",
      "https://invoice.stripe.com:8443/i",
    ])
      expect(safeMailboxPaymentUrl(url)).toBeNull();
  });
  it("keeps management disabled by default and never calls the SDK", async () => {
    await expect(as().mailboxes.manage({ action: "cancel" })).rejects.toMatchObject({
      message: "mailbox_billing_unavailable",
    });
    expect(getStripe).not.toHaveBeenCalled();
  });
  it.each(["subscription", "customer", "livemode"])(
    "does not show management from another %s on the current contract",
    async (field) => {
      vi.stubEnv("MAILBOX_BILLING_MANAGEMENT_ENABLED", "1");
      const periodStart = new Date(Date.now() - 1000),
        periodEnd = new Date(Date.now() + 86400000);
      await db.insert(schema.mailboxSubscriptions).values({
        teamId,
        status: "active",
        seats: 3,
        storageBytesPerMailbox: price.storageBytesPerMailbox,
        includedOutboundPerMailbox: price.includedOutboundPerMailbox,
        periodStart,
        periodEnd,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripeSubscriptionItemId: `si_${subscriptionId}`,
        livemode: false,
      });
      await db.insert(schema.mailboxManagementRequests).values({
        teamId,
        action: "decrease",
        status: "scheduled",
        step: "configure_schedule",
        seatsBefore: 3,
        seats: 2,
        periodStart,
        periodEnd,
        stripeCustomerId: field === "customer" ? `${customerId}_old` : customerId,
        stripeSubscriptionId: field === "subscription" ? `${subscriptionId}_old` : subscriptionId,
        stripeSubscriptionItemId: `si_${subscriptionId}`,
        stripePriceId: price.priceId,
        livemode: field === "livemode",
        idempotencyKey: `old_management:${teamId}`,
        stripeScheduleId: "sched_old_management_fixture",
      });
      expect((await as().mailboxes.billing()).management).toMatchObject({
        canAdjust: true,
        pending: false,
        scheduledSeats: null,
        effectiveAt: null,
      });
      expect(getStripe).not.toHaveBeenCalled();
      expect(
        await db
          .select()
          .from(schema.mailboxManagementRequests)
          .where(eq(schema.mailboxManagementRequests.teamId, teamId)),
      ).toHaveLength(1);
    },
  );
  it("shows a reduction only on its current nonterminal contract and preserves historical rows", async () => {
    vi.stubEnv("MAILBOX_BILLING_MANAGEMENT_ENABLED", "1");
    const periodStart = new Date(Date.now() - 1000),
      periodEnd = new Date(Date.now() + 86400000);
    await db.insert(schema.mailboxSubscriptions).values({
      teamId,
      status: "active",
      seats: 3,
      storageBytesPerMailbox: price.storageBytesPerMailbox,
      includedOutboundPerMailbox: price.includedOutboundPerMailbox,
      periodStart,
      periodEnd,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionItemId: `si_${subscriptionId}`,
      livemode: false,
    });
    await db.insert(schema.mailboxManagementRequests).values({
      teamId,
      action: "decrease",
      status: "scheduled",
      step: "configure_schedule",
      seatsBefore: 3,
      seats: 2,
      periodStart,
      periodEnd,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionItemId: `si_${subscriptionId}`,
      stripePriceId: price.priceId,
      livemode: false,
      idempotencyKey: `management:${teamId}`,
      stripeScheduleId: "sched_management_fixture",
    });
    expect((await as().mailboxes.billing()).management).toMatchObject({
      scheduledSeats: 2,
      effectiveAt: periodEnd,
    });
    await db
      .update(schema.mailboxSubscriptions)
      .set({ status: "canceled" })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect((await as().mailboxes.billing()).management).toMatchObject({
      scheduledSeats: null,
      effectiveAt: null,
    });
    const [history] = await db
      .select()
      .from(schema.mailboxManagementRequests)
      .where(eq(schema.mailboxManagementRequests.teamId, teamId));
    expect(history).toMatchObject({ status: "scheduled", seats: 2 });
    expect(getStripe).not.toHaveBeenCalled();
  });
  it("permits another guarded Checkout only after a canceled external contract is confirmed", async () => {
    await db.insert(schema.mailboxSubscriptions).values({
      teamId,
      status: "canceled",
      seats: 2,
      storageBytesPerMailbox: price.storageBytesPerMailbox,
      includedOutboundPerMailbox: price.includedOutboundPerMailbox,
      periodStart: new Date(Date.now() - 86400000),
      periodEnd: new Date(Date.now() - 1000),
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      lastEventCreated: Math.floor(Date.now() / 1000),
    });
    const previous = await lease("completed");
    // Stripe creates a distinct Session for the new purchase; the old one remains unique.
    sessionId = `${sessionId}_replacement`;
    checkoutUrl = `https://checkout.stripe.com/c/pay/${sessionId}`;
    expect(await as().mailboxes.billing()).toMatchObject({
      canPurchase: true,
      availability: "available",
    });
    stripe.subscriptions.retrieve = vi.fn(
      async () =>
        ({
          id: subscriptionId,
          customer: customerId,
          livemode: false,
          status: "canceled",
        }) as Stripe.Subscription,
    );
    expect(await as().mailboxes.checkout({ seats: 2 })).toEqual({ url: checkoutUrl });
    expect(createSession).toHaveBeenCalledTimes(1);
    const purchases = await db
      .select()
      .from(schema.mailboxCheckouts)
      .where(eq(schema.mailboxCheckouts.teamId, teamId));
    expect(purchases).toHaveLength(2);
    expect(purchases.find((row) => row.id === previous.id)).toMatchObject({
      status: "completed",
      stripeSessionId: previous.stripeSessionId,
      stripeSubscriptionId: subscriptionId,
    });
    expect(purchases.find((row) => row.id !== previous.id)).toMatchObject({
      status: "ready",
      stripeSessionId: sessionId,
      stripeCustomerId: customerId,
      seats: 2,
    });
    expect(createCustomer).not.toHaveBeenCalled();
  });
  it("does not permit re-contracting from an unconfirmed canceled row or another completed purchase", async () => {
    await db.insert(schema.mailboxSubscriptions).values({
      teamId,
      status: "canceled",
      seats: 2,
      storageBytesPerMailbox: price.storageBytesPerMailbox,
      includedOutboundPerMailbox: price.includedOutboundPerMailbox,
      periodStart: new Date(Date.now() - 86400000),
      periodEnd: new Date(Date.now() - 1000),
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
    });
    expect(await as().mailboxes.billing()).toMatchObject({ canPurchase: false });
    await db
      .update(schema.mailboxSubscriptions)
      .set({ lastEventCreated: Math.floor(Date.now() / 1000) })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    subscriptionId = "sub_other_pending_fixture";
    await lease("completed");
    expect(await as().mailboxes.billing()).toMatchObject({ canPurchase: false });
    expect(getStripe).not.toHaveBeenCalled();
  });
});
