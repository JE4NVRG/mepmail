import { readFileSync } from "node:fs";
import { type BillingStripe, priceMetadata } from "@millionsend/billing";
import {
  DAY_MS,
  PLAN_RUNGS,
  type PlanRungKey,
  rungByKey,
  type SystemMailMessage,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createBillingRouter } from "@/server/routers/billing";
import { createCallerFactory, router } from "@/server/trpc";
import { applySubscription } from "../../../packages/billing/src/subscription";

const h = vi.hoisted(() => ({
  runCronNow: vi.fn(async (_name: string) => {}),
  sent: [] as SystemMailMessage[],
}));
vi.mock("@/server/queue", () => ({ getQueue: async () => ({ runCronNow: h.runCronNow }) }));
// Request-boundary adapters are synthetic; DB, durable checkout and price resolution stay real.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next-intl/server", () => ({ getRequestConfig: (factory: unknown) => factory }));
vi.mock("@/server/auth", () => ({
  resolveBaseUrl: (url: string) => url,
  getAuth: () => {
    throw new Error("Router caller fixture must not initialize authentication");
  },
}));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return { ...actual, sendAccountMail: (m: SystemMailMessage) => void h.sent.push(m) };
});

let db: Db;
let close: () => Promise<void>;
let calls: {
  customers: Stripe.CustomerCreateParams[];
  checkouts: Stripe.Checkout.SessionCreateParams[];
  checkoutOptions: (Stripe.RequestOptions | undefined)[];
  portals: Stripe.BillingPortal.SessionCreateParams[];
  updates: Stripe.SubscriptionUpdateParams[];
  itemCreates: Stripe.SubscriptionItemCreateParams[];
  itemDeletes: string[];
  scheduleCreates: Stripe.SubscriptionScheduleCreateParams[];
  scheduleUpdates: Stripe.SubscriptionScheduleUpdateParams[];
  scheduleReleases: string[];
  meterEvents: Stripe.Billing.MeterEventCreateParams[];
};
let onCustomerCreate: (() => Promise<void>) | undefined;
let checkoutSession: Stripe.Checkout.Session | null;
async function seedBuyer(teamId: string) {
  await db.insert(schema.teamMembers).values({ teamId, userId: "u1", role: "admin" });
}

// Stripe stamps whole seconds; rows and the fake agree from the start.
const wholeSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);
const PERIOD_START = wholeSeconds(Date.now() - 10 * DAY_MS);
const PERIOD_END = wholeSeconds(Date.now() + 20 * DAY_MS);
const seconds = (d: Date) => d.getTime() / 1000;

/** A ladder price as Stripe returns it; the rung is read back off the metadata. */
function price(key: PlanRungKey, metered = false): Stripe.Price {
  const rung = rungByKey(key);
  return {
    active: true,
    livemode: false,
    currency: "usd",
    unit_amount: metered ? rung.overageCentsPer1k : key === "pro_100k" ? 2000 : rung.priceCents,
    transform_quantity: metered ? { divide_by: 1000, round: "up" } : null,
    id: `price_${key}${metered ? "_overage" : ""}`,
    lookup_key: `millionsend_${key}_${metered ? "overage" : "monthly"}`,
    metadata: priceMetadata(rung),
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: metered ? "metered" : "licensed",
    },
    product: "prod_x",
  } as unknown as Stripe.Price;
}
function launchPrice(interval: "month" | "year"): Stripe.Price {
  return {
    ...price("pro_100k"),
    product: "prod_launch",
    id: `price_launch_${interval}`,
    active: true,
    livemode: false,
    lookup_key: `mepmail_send_110k_launch_20261006_${interval}`,
    unit_amount: interval === "year" ? 29_000 : 2_900,
    metadata: {
      ...priceMetadata(rungByKey("pro_100k")),
      mepmail_send_offer: "launch_20261006",
      regular_monthly_cents: "2900",
    },
    recurring: { interval, interval_count: 1, usage_type: "licensed" },
  } as unknown as Stripe.Price;
}
const PRICES = PLAN_RUNGS.filter((r) => r.priceCents > 0)
  .flatMap((r) => [price(r.key), ...(r.period === "month" ? [price(r.key, true)] : [])])
  .concat([launchPrice("month"), launchPrice("year")]);
function priceById(id: string): Stripe.Price {
  const found = PRICES.find((p) => p.id === id);
  if (!found) throw new Error(`no price ${id}`);
  return found;
}

function item(id: string, p: Stripe.Price): Stripe.SubscriptionItem {
  return {
    id,
    price: p,
    ...(p.recurring?.usage_type === "metered" ? {} : { quantity: 1 }),
    current_period_start: seconds(PERIOD_START),
    current_period_end: seconds(PERIOD_END),
  } as unknown as Stripe.SubscriptionItem;
}
/** The one subscription the fake Stripe holds and the schedule pending on it; every change rewrites them like Stripe would. */
let sub: Stripe.Subscription;
let schedule: Stripe.SubscriptionSchedule | null;
function subscription(items: Stripe.SubscriptionItem[]): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    created: seconds(PERIOD_START),
    livemode: false,
    status: "active",
    cancel_at: null,
    items: { data: items },
    schedule,
  } as unknown as Stripe.Subscription;
}

const stripe = {
  invoices: { list: async () => ({ data: [], has_more: false }) },
  coupons: {
    retrieve: async () => ({
      id: "mepmail_send_launch_20261006_first_month",
      valid: true,
      livemode: false,
      currency: "usd",
      amount_off: 900,
      percent_off: null,
      duration: "once",
      applies_to: { products: ["prod_launch"] },
      metadata: { mepmail_send_offer: "launch_20261006" },
    }),
  },
  prices: {
    list: async ({ lookup_keys }: Stripe.PriceListParams) => ({
      data: PRICES.filter((p) => lookup_keys?.includes(p.lookup_key ?? "")),
    }),
  },
  customers: {
    create: async (params: Stripe.CustomerCreateParams) => {
      calls.customers.push(params);
      await onCustomerCreate?.();
      return {
        id: "cus_new",
        livemode: false,
        name: params.name,
        email: params.email,
        metadata: params.metadata,
      };
    },
  },
  subscriptions: {
    list: async () => ({ data: [], has_more: false }),
    retrieve: async () => sub,
    update: async (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      calls.updates.push(params);
      const kept = sub.items.data.filter(
        (i) => !params.items?.some((u) => u.id === i.id && u.deleted),
      );
      for (const u of params.items ?? []) {
        if (u.deleted || !u.price) continue;
        const existing = kept.find((i) => i.id === u.id);
        if (existing) existing.price = priceById(u.price);
        else kept.push(item("si_overage", priceById(u.price)));
      }
      sub = subscription(kept);
      return sub;
    },
  },
  subscriptionItems: {
    create: async (params: Stripe.SubscriptionItemCreateParams) => {
      calls.itemCreates.push(params);
      const created = item("si_overage", priceById(params.price ?? ""));
      sub = subscription([...sub.items.data, created]);
      return created;
    },
    del: async (id: string) => {
      calls.itemDeletes.push(id);
      sub = subscription(sub.items.data.filter((i) => i.id !== id));
      return { id, deleted: true };
    },
  },
  subscriptionSchedules: {
    create: async (params: Stripe.SubscriptionScheduleCreateParams) => {
      calls.scheduleCreates.push(params);
      schedule = { id: "sub_sched_1", phases: [] } as unknown as Stripe.SubscriptionSchedule;
      sub = subscription(sub.items.data);
      return schedule;
    },
    update: async (_id: string, params: Stripe.SubscriptionScheduleUpdateParams) => {
      calls.scheduleUpdates.push(params);
      schedule = {
        id: "sub_sched_1",
        phases: (params.phases ?? []).map((phase) => ({
          items: (phase.items ?? []).map((i) => ({
            price: priceById(i.price ?? ""),
            quantity: i.quantity,
          })),
        })),
      } as unknown as Stripe.SubscriptionSchedule;
      sub = subscription(sub.items.data);
      return schedule;
    },
    release: async (id: string) => {
      calls.scheduleReleases.push(id);
      schedule = null;
      sub = subscription(sub.items.data);
      return { id };
    },
  },
  billing: {
    meterEvents: {
      create: async (params: Stripe.Billing.MeterEventCreateParams) => {
        calls.meterEvents.push(params);
        return {};
      },
    },
  },
  checkout: {
    sessions: {
      list: async () => ({ data: checkoutSession ? [checkoutSession] : [], has_more: false }),
      retrieve: async () => checkoutSession,
      create: async (
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ) => {
        calls.checkouts.push(params);
        calls.checkoutOptions.push(options);
        checkoutSession = {
          id: "cs_1",
          url: "https://checkout.stripe.com/c/cs_1",
          mode: "subscription",
          status: "open",
          livemode: false,
          customer: params.customer,
          client_reference_id: params.client_reference_id,
          metadata: params.metadata,
          expires_at: Math.floor(Date.now() / 1000) + 86400,
        } as Stripe.Checkout.Session;
        return checkoutSession;
      },
    },
  },
  billingPortal: {
    sessions: {
      create: async (params: Stripe.BillingPortal.SessionCreateParams) => {
        calls.portals.push(params);
        return { url: "https://billing.stripe.com/p/1" };
      },
    },
  },
} as unknown as BillingStripe;

describe("billing maintenance window", () => {
  it("blocks financial mutations before loading team or calling Stripe", async () => {
    vi.stubEnv("BILLING_MUTATIONS_PAUSED", "true");
    const teamId = await createTeam(db, "Testes QA");
    const caller = callerFor(teamId, "owner");
    for (const action of [
      () => caller.billing.checkout({ rung: "pro_100k" }),
      () => caller.billing.changePlan({ rung: "pro_200k" }),
      () => caller.billing.portal(),
      () => caller.billing.setOverage({ enabled: true }),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    }
    for (const writes of Object.values(calls)) expect(writes).toEqual([]);
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team?.plan).toBe("free");
    expect(team?.stripeCustomerId).toBeNull();
    expect((await caller.billing.status()).plan).toBe("free");
  });
});

const createCaller = createCallerFactory(
  router({ billing: createBillingRouter({ stripe: () => stripe }) }),
);

function callerFor(teamId: string, role: TeamRole) {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role,
  });
}

/**
 * A team mid-period on `key`, with the matching subscription in the fake
 * Stripe. A monthly rung carries its metered item unless `metered` is false
 * (a subscription from before the ladder); `overage` is the row's switch.
 */
async function subscribedTeam(
  key: PlanRungKey,
  opts: { overage?: boolean; metered?: boolean } = {},
): Promise<string> {
  const teamId = await createTeam(db);
  const rung = rungByKey(key);
  const metered = opts.metered ?? rung.period === "month";
  schedule = null;
  sub = subscription([
    item("si_base", price(key)),
    ...(metered ? [item("si_overage", price(key, true))] : []),
  ]);
  await db
    .update(schema.teams)
    .set({
      plan: rung.plan,
      planQuota: rung.period === "month" ? rung.included : null,
      planStatus: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeOverageItemId: metered ? "si_overage" : null,
      overageEnabled: opts.overage ?? false,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    })
    .where(eq(schema.teams.id, teamId));
  await persistSubscriptionTerms();
  return teamId;
}

async function persistSubscriptionTerms() {
  await db.transaction(async (tx) => {
    await applySubscription(tx as unknown as Db, sub, (message) => {
      throw new Error(message);
    });
  });
}

async function teamRow(teamId: string) {
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  return team;
}

const auditRows = () =>
  db.select({ action: schema.auditLog.action, data: schema.auditLog.data }).from(schema.auditLog);

const notificationRows = () =>
  db
    .select({ kind: schema.teamNotifications.kind, key: schema.teamNotifications.periodKey })
    .from(schema.teamNotifications);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const ddl = readFileSync(
    new URL(
      "../../../packages/db/mailbox-drizzle/0007_mailbox_customer_request.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const statement of ddl.split("--> statement-breakpoint").filter((s) => s.trim()))
    await db.execute(sql.raw(statement));
  await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
  checkoutSession = null;
  calls = {
    customers: [],
    checkouts: [],
    checkoutOptions: [],
    portals: [],
    updates: [],
    itemCreates: [],
    itemDeletes: [],
    scheduleCreates: [],
    scheduleUpdates: [],
    scheduleReleases: [],
    meterEvents: [],
  };
  schedule = null;
  onCustomerCreate = undefined;
  vi.stubEnv("IS_CLOUD", "true");
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
  vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "false");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  h.runCronNow.mockClear();
  h.sent = [];
  await close();
});

describe("billing router", () => {
  it("keeps the real legacy USD20 price and checkout when the new offer is disabled", async () => {
    vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "false");
    const existing = await subscribedTeam("pro_100k");
    await db
      .update(schema.teams)
      .set({ sendBillingContract: null })
      .where(eq(schema.teams.id, existing));
    const before = await teamRow(existing);
    const status = await callerFor(existing, "owner").billing.status();
    expect(status).toMatchObject({
      effectiveRung: { priceCents: 2000 },
      billingInterval: "month",
      subscriptionState: "confirmed",
      launchOffer: null,
    });
    expect(await teamRow(existing)).toEqual(before);
    const fresh = await createTeam(db, "legacy-checkout");
    await seedBuyer(fresh);
    await callerFor(fresh, "owner").billing.checkout({ rung: "pro_100k" });
    const baseId = calls.checkouts[0]?.line_items?.[0]?.price;
    expect(baseId).toBe("price_pro_100k");
    expect(priceById(baseId as string).unit_amount).toBe(2000);
    expect(calls.checkouts[0]?.metadata?.mepmail_send_offer).toBeUndefined();
  });

  it.each(["interval", "amount", "binding"] as const)(
    "hides inconsistent %s readback without changing the customer's contract",
    async (mismatch) => {
      const teamId = await subscribedTeam("pro_100k", { overage: true });
      const before = await teamRow(teamId);
      const base = sub.items.data[0];
      if (!base) throw new Error("Missing licensed item");
      if (mismatch === "interval") sub = subscription([item("si_base", launchPrice("year"))]);
      else if (mismatch === "amount") base.price = { ...base.price, unit_amount: 2900 };
      else sub = { ...sub, customer: "cus_other" };
      const status = await callerFor(teamId, "owner").billing.status();
      expect(status).toMatchObject({
        subscriptionState: "pending_confirmation",
        effectiveRung: null,
        quota: { overage: false, overageCentsPer1k: null },
      });
      expect(status.quota).not.toHaveProperty("billingTerms");
      expect(await teamRow(teamId)).toEqual(before);
      expect(calls.updates).toEqual([]);
      expect(calls.itemCreates).toEqual([]);
      expect(JSON.stringify(status)).not.toMatch(/cus_|price_|sub_|si_/);
    },
  );

  it("reports a validated annual interval and amount without changing an existing customer's terms", async () => {
    const teamId = await subscribedTeam("pro_100k", { metered: false });
    sub = subscription([item("si_base", launchPrice("year"))]);
    await persistSubscriptionTerms();
    const before = await teamRow(teamId);
    const state = await callerFor(teamId, "member").billing.status();
    expect(state.billingInterval).toBe("year");
    expect(state.effectiveRung?.priceCents).toBe(29000);
    expect(state.launchOffer).toBeNull();
    expect(await teamRow(teamId)).toEqual(before);
    expect(JSON.stringify(state)).not.toMatch(/price_|cus_|sub_/);
  });
  it("returns the enabled offer without provider IDs only to a team without an active subscription", async () => {
    vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
    const teamId = await createTeam(db, "offer-free");
    const state = await callerFor(teamId, "member").billing.status();
    expect(state.launchOffer).toEqual({
      rung: "pro_100k",
      monthlyCents: 2900,
      firstMonthlyCents: 2000,
      annualCents: 29000,
      monthlyRecipientDeliveries: 110000,
    });
    expect(state).not.toHaveProperty("sendBillingContract");
    expect(JSON.stringify(state)).not.toMatch(/price_|cus_|sub_/);
    const existing = await subscribedTeam("pro_100k");
    expect((await callerFor(existing, "member").billing.status()).launchOffer).toBeNull();
    expect((await callerFor(existing, "member").billing.status()).billingInterval).toBe("month");
    const system = await createTeam(db, "offer-system");
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, system));
    expect((await callerFor(system, "member").billing.status()).launchOffer).toBeNull();
  });

  it.each([
    { flag: "false", rung: "pro_100k" as const },
    { flag: "1", rung: "pro_100k" as const },
    { flag: "true", rung: "starter" as const },
    { flag: "true", rung: "pro_200k" as const },
  ])(
    "refuses unapproved annual checkout before any provider write ($flag, $rung)",
    async ({ flag, rung }) => {
      vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", flag);
      const teamId = await createTeam(db);
      await expect(
        callerFor(teamId, "owner").billing.checkout({ rung, interval: "year" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "SEND_CHECKOUT_INVALID" });
      expect(calls.customers).toEqual([]);
      expect(calls.checkouts).toEqual([]);
    },
  );

  it.each(["month", "year"] as const)(
    "captures the enabled %s offer in one durable checkout with no annual promo stacking",
    async (interval) => {
      vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
      const teamId = await createTeam(db);
      await seedBuyer(teamId);
      const caller = callerFor(teamId, "owner");
      await caller.billing.checkout({ rung: "pro_100k", interval });
      await caller.billing.checkout({ rung: "pro_100k", interval });
      expect(calls.checkouts).toHaveLength(1);
      expect(calls.checkouts[0]?.line_items?.[0]).toEqual({
        price: `price_launch_${interval}`,
        quantity: 1,
      });
      expect(calls.checkouts[0]?.metadata?.mepmail_send_interval).toBe(interval);
      if (interval === "year") {
        expect(calls.checkouts[0]?.line_items).toHaveLength(1);
        expect(calls.checkouts[0]?.discounts).toBeUndefined();
        expect(calls.checkouts[0]?.allow_promotion_codes).not.toBe(true);
      } else {
        expect(calls.checkouts[0]?.discounts).toEqual([
          { coupon: "mepmail_send_launch_20261006_first_month" },
        ]);
      }
      expect(await db.select().from(schema.sendCheckoutAttempts)).toHaveLength(1);
      expect((await auditRows())[0]?.data).toMatchObject({
        interval,
        checkoutAttemptId: expect.any(String),
      });
    },
  );
  it("status preserves archived subscription prices through the real resolver and quota path", async () => {
    const teamId = await subscribedTeam("pro_100k", { overage: true });
    const base = sub.items.data[0];
    const metered = sub.items.data[1];
    if (!base || !metered) throw new Error("Missing subscribed items");
    base.price = {
      ...base.price,
      id: "price_old_base",
      active: false,
      lookup_key: null,
      unit_amount: 2000,
      metadata: { ...base.price.metadata, overage_cents_per_1k: "90" },
    };
    metered.price = {
      ...metered.price,
      id: "price_old_metered",
      active: false,
      lookup_key: null,
      unit_amount: 90,
    };
    await persistSubscriptionTerms();
    await db
      .insert(schema.usagePeriods)
      .values({ teamId, periodStart: PERIOD_START, accepted: 111001 });
    const result = await callerFor(teamId, "member").billing.status();
    expect(result.effectiveRung).toMatchObject({ priceCents: 2000, overageCentsPer1k: 90 });
    expect(result.quota).toMatchObject({ kind: "month", overageCentsPer1k: 90 });
    expect(result.quota).not.toHaveProperty("billingTerms");
    expect(JSON.stringify(result)).not.toMatch(/price_old_|cus_1|sub_1|si_/);
    expect(calls.updates).toEqual([]);
    expect(calls.itemCreates).toEqual([]);
    metered.price.transform_quantity = { divide_by: 1000, round: "down" };
    expect((await callerFor(teamId, "member").billing.status()).quota).toMatchObject({
      overageCentsPer1k: null,
    });
  });

  it("status keeps unknown rates unavailable rather than falling back to catalog", async () => {
    const teamId = await subscribedTeam("pro_100k", { overage: true });
    await db
      .update(schema.teams)
      .set({ stripeSubscriptionId: null })
      .where(eq(schema.teams.id, teamId));
    expect((await callerFor(teamId, "member").billing.status()).quota).toMatchObject({
      overageCentsPer1k: null,
    });
  });
  it("does not exist on self-host", async () => {
    vi.stubEnv("IS_CLOUD", "");
    const teamId = await createTeam(db);
    const owner = callerFor(teamId, "owner");
    await expect(owner.billing.status()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(owner.billing.checkout({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(owner.billing.changePlan({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(owner.billing.setOverage({ enabled: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(owner.billing.portal()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.checkouts).toEqual([]);
  });

  it("status reports the entitlement to any member", async () => {
    const teamId = await createTeam(db);
    expect(await callerFor(teamId, "member").billing.status()).toEqual({
      plan: "free",
      effectiveRung: null,
      subscriptionState: "none",
      planQuota: null,
      rung: "free",
      pendingRung: null,
      planStatus: "none",
      currentPeriodEnd: null,
      quota: { kind: "day", plan: "free", limit: 100 },
      usage: { accepted: 0, reportedOverage: 0 },
      hasCustomer: false,
      hasLiveSubscription: false,
      billingInterval: null,
      launchOffer: null,
    });
  });

  it("status counts a monthly plan against its billing period", async () => {
    const teamId = await subscribedTeam("pro_200k", { overage: true });
    await db
      .insert(schema.usagePeriods)
      .values({ teamId, periodStart: PERIOD_START, accepted: 1234, reportedOverage: 0 });
    expect(await callerFor(teamId, "member").billing.status()).toMatchObject({
      plan: "pro",
      planQuota: 220_000,
      rung: "pro_200k",
      pendingRung: null,
      planStatus: "active",
      currentPeriodEnd: PERIOD_END,
      quota: {
        kind: "month",
        plan: "pro",
        included: 220_000,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        overage: true,
        overageCentsPer1k: 35,
      },
      usage: { accepted: 1234, reportedOverage: 0 },
      hasCustomer: true,
      hasLiveSubscription: true,
    });
  });

  it("checkout, plan changes, overage and the portal are owner/admin only", async () => {
    const teamId = await createTeam(db);
    const member = callerFor(teamId, "member");
    await expect(member.billing.checkout({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.billing.changePlan({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.billing.setOverage({ enabled: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.billing.portal()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("checkout creates the customer once, stores it, and sells the rung's price with its metered item", async () => {
    const teamId = await createTeam(db, "acme");
    await seedBuyer(teamId);
    const admin = callerFor(teamId, "admin");
    expect(await admin.billing.checkout({ rung: "scale_1m" })).toEqual({
      url: "https://checkout.stripe.com/c/cs_1",
    });
    expect(calls.customers).toEqual([
      {
        name: "acme",
        email: "u1@example.com",
        metadata: { team_id: teamId, mepmail_customer_key: expect.any(String) },
      },
    ]);
    expect(calls.checkouts[0]).toMatchObject({
      mode: "subscription",
      customer: "cus_new",
      client_reference_id: teamId,
      line_items: [{ price: "price_scale_1m", quantity: 1 }, { price: "price_scale_1m_overage" }],
      success_url: "https://app.example.com/settings/billing?checkout=success",
      cancel_url: "https://app.example.com/settings/billing",
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
    });
    expect(calls.checkoutOptions[0]?.idempotencyKey).toMatch(/^send-checkout:[a-f0-9-]{36}$/);
    expect(await teamRow(teamId)).toMatchObject({
      stripeCustomerId: "cus_new",
      plan: "free",
      planStatus: "none",
    });
    expect(await auditRows()).toEqual([
      {
        action: "billing.checkout_started",
        data: { rung: "scale_1m", interval: "month", checkoutAttemptId: expect.any(String) },
      },
    ]);

    // An open financial intent is reused, and changing its plan is refused.
    await admin.billing.checkout({ rung: "scale_1m" });
    expect(calls.customers).toHaveLength(1);
    expect(calls.checkouts).toHaveLength(1);
    await expect(admin.billing.checkout({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "SEND_CHECKOUT_CONFLICT",
    });
    expect(calls.checkouts).toHaveLength(1);
  });

  it("checkout refuses the free rung: Free is reached by cancelling", async () => {
    const teamId = await createTeam(db);
    await expect(callerFor(teamId, "owner").billing.checkout({ rung: "free" })).rejects.toThrow();
    expect(calls.checkouts).toEqual([]);
  });

  it("checkout exposes an uncertain Customer as pending without another POST", async () => {
    const teamId = await createTeam(db);
    await seedBuyer(teamId);
    onCustomerCreate = async () => {
      throw new Error("lost provider reply");
    };
    const owner = callerFor(teamId, "owner");
    await expect(owner.billing.checkout({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "SEND_CHECKOUT_PENDING",
    });
    onCustomerCreate = undefined;
    await expect(owner.billing.checkout({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "SEND_CHECKOUT_PENDING",
    });
    expect(calls.customers).toHaveLength(1);
    expect(calls.checkouts).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("checkout is refused while a subscription is live; status says so", async () => {
    const teamId = await createTeam(db);
    await seedBuyer(teamId);
    const owner = callerFor(teamId, "owner");
    for (const planStatus of ["active", "trialing", "past_due", "unpaid"] as const) {
      await db
        .update(schema.teams)
        .set({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", planStatus })
        .where(eq(schema.teams.id, teamId));
      expect((await owner.billing.status()).hasLiveSubscription).toBe(true);
      await expect(owner.billing.checkout({ rung: "scale_500k" })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    }
    expect(calls.checkouts).toEqual([]);

    await db
      .update(schema.teams)
      .set({ planStatus: "canceled" })
      .where(eq(schema.teams.id, teamId));
    expect((await owner.billing.status()).hasLiveSubscription).toBe(false);
    expect(await owner.billing.checkout({ rung: "scale_500k" })).toEqual({
      url: "https://checkout.stripe.com/c/cs_1",
    });
  });

  it("checkout rejects stale role context using current persisted membership", async () => {
    const teamId = await createTeam(db);
    await db.insert(schema.teamMembers).values({ teamId, userId: "u1", role: "member" });
    await expect(
      callerFor(teamId, "admin").billing.checkout({ rung: "pro_100k" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "SEND_CHECKOUT_FORBIDDEN" });
    expect(calls.customers).toHaveLength(0);
  });

  it("an incomplete subscription blocks a new checkout before creating a Customer", async () => {
    const teamId = await createTeam(db);
    await seedBuyer(teamId);
    await db
      .update(schema.teams)
      .set({ planStatus: "incomplete", stripeSubscriptionId: "sub_pending" })
      .where(eq(schema.teams.id, teamId));
    await expect(
      callerFor(teamId, "owner").billing.checkout({ rung: "pro_100k" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "SEND_CHECKOUT_SUBSCRIPTION_EXISTS",
    });
    expect(calls.customers).toHaveLength(0);
    expect(calls.checkouts).toHaveLength(0);
  });

  it("a persisted checkout UUID deduplicates the funnel when the same Session is reopened", async () => {
    vi.stubEnv("UMAMI_ENDPOINT", "https://collector.example.test/api/send");
    vi.stubEnv("UMAMI_WEBSITE_ID", "00000000-0000-4000-8000-000000000001");
    const collector = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", collector);
    const teamId = await createTeam(db);
    await seedBuyer(teamId);
    const owner = callerFor(teamId, "owner");
    await owner.billing.checkout({ rung: "pro_100k" });
    await owner.billing.checkout({ rung: "pro_100k" });
    const attempts = await db.select().from(schema.sendCheckoutAttempts);
    const events = await db.select().from(schema.funnelEvents);
    expect(attempts).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.dedupeKey).toBe(`checkout_started:${teamId}:${attempts[0]?.id}`);
    expect(calls.checkouts).toHaveLength(1);
    expect(collector).toHaveBeenCalledTimes(1);
  });

  it("changePlan moves up at once with prorations, re-pricing the metered item, and drains on a raise", async () => {
    const teamId = await subscribedTeam("pro_100k");
    const owner = callerFor(teamId, "owner");
    expect(await owner.billing.changePlan({ rung: "scale_500k" })).toEqual({ applied: "now" });
    expect(calls.updates).toEqual([
      {
        items: [
          { id: "si_base", price: "price_scale_500k" },
          { id: "si_overage", price: "price_scale_500k_overage" },
        ],
        proration_behavior: "create_prorations",
      },
    ]);
    expect(calls.scheduleCreates).toEqual([]);
    expect(await teamRow(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 550_000,
      stripeOverageItemId: "si_overage",
      pendingRung: null,
    });
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");
    expect(await auditRows()).toEqual([
      { action: "billing.plan_changed", data: { rung: "scale_500k", applied: "now" } },
    ]);
  });

  it("changePlan adds the metered item a subscription from before the ladder lacks", async () => {
    const teamId = await subscribedTeam("pro_100k", { metered: false });
    await callerFor(teamId, "owner").billing.changePlan({ rung: "pro_200k" });
    expect(calls.updates[0]?.items).toEqual([
      { id: "si_base", price: "price_pro_200k" },
      { price: "price_pro_200k_overage" },
    ]);
    expect(await teamRow(teamId)).toMatchObject({
      planQuota: 220_000,
      stripeOverageItemId: "si_overage",
    });
  });

  it("changePlan schedules a move down for the period end and leaves the row alone until then; the current rung drops it", async () => {
    const teamId = await subscribedTeam("scale_500k");
    const owner = callerFor(teamId, "owner");
    expect(await owner.billing.changePlan({ rung: "pro_100k" })).toEqual({
      applied: "period_end",
      at: PERIOD_END,
    });
    expect(calls.updates).toEqual([]);
    expect(calls.scheduleCreates).toEqual([{ from_subscription: "sub_1" }]);
    expect(calls.scheduleUpdates).toEqual([
      {
        end_behavior: "release",
        phases: [
          {
            items: [
              { price: "price_scale_500k", quantity: 1 },
              { price: "price_scale_500k_overage" },
            ],
            start_date: seconds(PERIOD_START),
            end_date: seconds(PERIOD_END),
            proration_behavior: "none",
          },
          {
            items: [{ price: "price_pro_100k", quantity: 1 }, { price: "price_pro_100k_overage" }],
            duration: { interval: "month", interval_count: 1 },
            proration_behavior: "none",
          },
        ],
      },
    ]);
    expect(await teamRow(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 550_000,
      pendingRung: "pro_100k",
    });
    expect((await owner.billing.status()).pendingRung).toBe("pro_100k");
    expect(h.runCronNow).not.toHaveBeenCalled();

    // Another move down rewrites the same schedule; a daily rung's phase carries no metered item.
    await owner.billing.changePlan({ rung: "starter" });
    expect(calls.scheduleCreates).toHaveLength(1);
    expect(calls.scheduleUpdates[1]?.phases?.[1]?.items).toEqual([
      { price: "price_starter", quantity: 1 },
    ]);
    expect((await teamRow(teamId))?.pendingRung).toBe("starter");

    // Keeping the current rung releases the schedule.
    expect(await owner.billing.changePlan({ rung: "scale_500k" })).toEqual({
      applied: "unscheduled",
    });
    expect(calls.scheduleReleases).toEqual(["sub_sched_1"]);
    expect(await teamRow(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 550_000,
      pendingRung: null,
    });
    expect(await auditRows()).toEqual([
      { action: "billing.plan_changed", data: { rung: "pro_100k", applied: "period_end" } },
      { action: "billing.plan_changed", data: { rung: "starter", applied: "period_end" } },
      { action: "billing.plan_changed", data: { rung: "scale_500k", applied: "unscheduled" } },
    ]);
  });

  it("changePlan tells the owners about a move once per period, keyed like the webhook's own report", async () => {
    vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "MillionSend <notices@mail.example.com>");
    const teamId = await subscribedTeam("pro_100k");
    await db.insert(schema.user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
    await db.insert(schema.teamMembers).values({ teamId, userId: "ada", role: "owner" });
    const owner = callerFor(teamId, "owner");
    await owner.billing.changePlan({ rung: "scale_500k" });
    expect(h.sent.map((m) => [m.kind, m.to, m.subject])).toEqual([
      ["billing.plan_changed", "ada@example.com", "acme moved from Pro 110K to Scale 550K"],
    ]);
    expect(h.sent[0]?.from).toBe("MillionSend <notices@mail.example.com>");
    expect(h.sent[0]?.text).toContain("https://app.example.com/settings/billing");
    expect(await notificationRows()).toEqual([
      { kind: "billing.plan_changed", key: `pro_100k>scale_500k:${PERIOD_END.toISOString()}` },
    ]);

    // A scheduled move down is not a move yet; the move up that drops it is news of its own.
    await owner.billing.changePlan({ rung: "pro_200k" });
    expect(h.sent).toHaveLength(1);
    await owner.billing.changePlan({ rung: "scale_1m" });
    expect(calls.scheduleReleases).toEqual(["sub_sched_1"]);
    expect(h.sent.map((m) => m.subject)).toEqual([
      "acme moved from Pro 110K to Scale 550K",
      "acme moved from Scale 550K to Scale 1.1M",
    ]);
    expect((await teamRow(teamId))?.pendingRung).toBeNull();
  });

  it("changePlan needs a live subscription", async () => {
    const teamId = await createTeam(db);
    await expect(
      callerFor(teamId, "owner").billing.changePlan({ rung: "pro_100k" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(calls.updates).toEqual([]);
  });

  it("setOverage is a switch on the row; off first reports what the meter has not seen", async () => {
    const teamId = await subscribedTeam("pro_100k");
    const owner = callerFor(teamId, "owner");
    await owner.billing.setOverage({ enabled: true });
    expect(calls.itemCreates).toEqual([]);
    expect(calls.updates).toEqual([]);
    expect(await teamRow(teamId)).toMatchObject({
      overageEnabled: true,
      stripeOverageItemId: "si_overage",
    });
    expect((await owner.billing.status()).quota).toMatchObject({ kind: "month", overage: true });
    // Overage lets parked broadcast mail through: drained at once.
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");

    h.runCronNow.mockClear();
    const subscribed = await teamRow(teamId);
    if (!subscribed?.billingTerms) {
      throw new Error(
        "Subscribed fixture must retain verified billing terms before recording usage",
      );
    }
    await db.insert(schema.usagePeriods).values({
      teamId,
      periodStart: PERIOD_START,
      accepted: 110_500,
      billingTerms: subscribed.billingTerms,
    });
    await owner.billing.setOverage({ enabled: false });
    expect(calls.meterEvents).toEqual([
      expect.objectContaining({
        event_name: "emails_over_quota",
        payload: { stripe_customer_id: "cus_1", value: "500" },
      }),
    ]);
    expect(
      await db
        .select({
          reportedOverage: schema.usagePeriods.reportedOverage,
          pendingOverage: schema.usagePeriods.pendingOverage,
        })
        .from(schema.usagePeriods),
    ).toEqual([{ reportedOverage: 500, pendingOverage: null }]);
    expect(calls.itemDeletes).toEqual([]);
    expect(await teamRow(teamId)).toMatchObject({
      overageEnabled: false,
      stripeOverageItemId: "si_overage",
    });
    expect((await owner.billing.status()).quota).toMatchObject({ kind: "month", overage: false });
    expect(h.runCronNow).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([
      { action: "billing.overage_toggled", data: { enabled: true } },
      { action: "billing.overage_toggled", data: { enabled: false } },
    ]);
  });

  it("setOverage on adds the metered item to a subscription from before the ladder", async () => {
    const teamId = await subscribedTeam("pro_100k", { metered: false });
    await callerFor(teamId, "owner").billing.setOverage({ enabled: true });
    expect(calls.itemCreates).toEqual([{ subscription: "sub_1", price: "price_pro_100k_overage" }]);
    expect(await teamRow(teamId)).toMatchObject({
      overageEnabled: true,
      stripeOverageItemId: "si_overage",
    });
  });

  it("setOverage is refused on a daily plan and without a live subscription", async () => {
    const daily = await subscribedTeam("starter");
    await expect(
      callerFor(daily, "owner").billing.setOverage({ enabled: true }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const free = await createTeam(db, "free-team");
    await expect(
      callerFor(free, "owner").billing.setOverage({ enabled: true }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(calls.itemCreates).toEqual([]);
  });

  it("portal needs a customer and passes the configured portal id", async () => {
    const teamId = await createTeam(db);
    const owner = callerFor(teamId, "owner");
    await expect(owner.billing.portal()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_1" })
      .where(eq(schema.teams.id, teamId));
    expect(await owner.billing.portal()).toEqual({ url: "https://billing.stripe.com/p/1" });
    expect(calls.portals).toEqual([
      { customer: "cus_1", return_url: "https://app.example.com/settings/billing" },
    ]);

    vi.stubEnv("STRIPE_PORTAL_CONFIG", "bpc_1");
    await owner.billing.portal();
    expect(calls.portals[1]).toMatchObject({ configuration: "bpc_1" });
  });
});

describe("the system team", () => {
  async function systemTeam(): Promise<string> {
    const teamId = await createTeam(db);
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, teamId));
    return teamId;
  }

  it("reports its plan with no rung and no cap", async () => {
    const owner = callerFor(await systemTeam(), "owner");
    expect(await owner.billing.status()).toMatchObject({
      plan: "system",
      rung: null,
      quota: { kind: "none" },
      hasCustomer: false,
      hasLiveSubscription: false,
    });
  });

  it("refuses checkout, plan changes, the overage switch and the portal", async () => {
    const owner = callerFor(await systemTeam(), "owner");
    const forbidden = { code: "FORBIDDEN" };
    await expect(owner.billing.checkout({ rung: "pro_100k" })).rejects.toMatchObject(forbidden);
    await expect(owner.billing.changePlan({ rung: "pro_100k" })).rejects.toMatchObject(forbidden);
    await expect(owner.billing.setOverage({ enabled: true })).rejects.toMatchObject(forbidden);
    await expect(owner.billing.portal()).rejects.toMatchObject(forbidden);
    expect(calls.customers).toEqual([]);
    expect(calls.checkouts).toEqual([]);
    expect(calls.portals).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });
});
