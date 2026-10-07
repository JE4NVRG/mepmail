import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OverageReport, reportOverage } from "../src/overage.js";
import type { BillingStripe } from "../src/stripe.js";
import { applySubscription, changeRung, lockCustomer, setOverage } from "../src/subscription.js";
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
} from "./helpers.js";

let db: Db;
let close: () => Promise<void>;
let stripe: BillingStripe;
let state: ReturnType<typeof fakeStripe>["state"];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ stripe, state } = fakeStripe());
});

afterEach(() => close());

const deps = () => ({ db, stripe, log: () => {} });
const team = (teamId: string) => teamRow(db, teamId);

/** A team whose row mirrors `sub`, with `accepted` sends in the current period. */
async function subscribedTeam(sub: Stripe.Subscription, accepted = 0): Promise<string> {
  const teamId = await createTeam(db);
  state.subscriptions[sub.id] = sub;
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: sub.customer as string })
    .where(eq(schema.teams.id, teamId));
  await applySubscription(db, sub, () => {});
  if (accepted) {
    const [acceptedUnder] = await db
      .select({ billingTerms: schema.teams.billingTerms })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.usagePeriods).values({
      teamId,
      periodStart: new Date(PERIOD_START * 1000),
      accepted,
      billingTerms: acceptedUnder?.billingTerms ?? null,
    });
  }
  return teamId;
}

const withOverage = (
  lookupKey = "millionsend_pro_100k_monthly",
  overageKey = "millionsend_pro_100k_overage",
  extra: { schedule?: Stripe.SubscriptionSchedule } = {},
) => subscription("sub_1", "cus_1", "active", lookupKey, { overageKey, ...extra });

/** What the team's one period row says the meter already knows about. */
async function reportedOverage(teamId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ reportedOverage: schema.usagePeriods.reportedOverage })
    .from(schema.usagePeriods)
    .where(eq(schema.usagePeriods.teamId, teamId));
  return row?.reportedOverage;
}

const callOrder = (first: string, second: string) =>
  expect(state.calls.indexOf(first)).toBeLessThan(state.calls.indexOf(second));

describe("grandfathering during reconciliation", () => {
  it("does not add current-catalog overage to an old or unknown contract", async () => {
    const sub = subscription("sub_legacy", "cus_legacy", "active", "millionsend_pro_100k_monthly");
    const base = sub.items.data[0];
    if (!base) throw new Error("Missing base");
    base.price = {
      ...base.price,
      active: false,
      lookup_key: null,
      metadata: { ...base.price.metadata, overage_cents_per_1k: "90" },
    };
    const teamId = await subscribedTeam(sub);
    await applySubscription(db, sub, () => {}, stripe);
    expect(state.itemCreates).toEqual([]);
    expect(state.itemUpdates).toEqual([]);
    await expect(setOverage(deps(), { teamId, enabled: true })).rejects.toThrow(
      "explicit overage price review",
    );
    expect(state.itemCreates).toEqual([]);
  });

  it("keeps both archived items unchanged on a routine reconcile", async () => {
    const sub = withOverage();
    const base = sub.items.data[0];
    const overage = sub.items.data[1];
    if (!base || !overage) throw new Error("Missing items");
    base.price = {
      ...base.price,
      active: false,
      lookup_key: null,
      metadata: { ...base.price.metadata, overage_cents_per_1k: "90" },
    };
    overage.price = { ...overage.price, active: false, lookup_key: null, unit_amount: 90 };
    await subscribedTeam(sub);
    const before = JSON.stringify(sub.items.data);
    await applySubscription(db, sub, () => {}, stripe);
    expect(JSON.stringify(sub.items.data)).toBe(before);
    expect(state.itemCreates).toEqual([]);
    expect(state.itemUpdates).toEqual([]);
    expect(state.updates).toEqual([]);
  });
});

describe("changeRung up", () => {
  it("settles usage under the old rung, then re-prices both items at once and re-reads Stripe", async () => {
    const teamId = await subscribedTeam(withOverage(), 110_500);
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({ applied: "now" });
    expect(state.meterEvents.map((e) => e.payload.value)).toEqual(["500"]);
    callOrder("billing.meterEvents.create", "subscriptions.update");
    expect(state.updates).toEqual([
      [
        "sub_1",
        {
          items: [
            { id: "si_sub_1", price: priceId("millionsend_pro_200k_monthly") },
            { id: "si_sub_1_overage", price: priceId("millionsend_pro_200k_overage") },
          ],
          proration_behavior: "always_invoice",
          payment_behavior: "pending_if_incomplete",
        },
      ],
    ]);
    expect(state.scheduleCreates).toEqual([]);
    // The row is applied from a fetch taken after the update, not from the pre-move read.
    expect(state.retrieves).toEqual(["sub_1", "sub_1", "sub_1"]);
    expect(state.calls.lastIndexOf("subscriptions.retrieve")).toBeGreaterThan(
      state.calls.indexOf("subscriptions.update"),
    );
    // What the old volume included is not re-judged under the new one.
    expect(await reportedOverage(teamId)).toBe(500);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 220_000,
      stripeOverageItemId: "si_sub_1_overage",
      pendingRung: null,
    });
  });

  it("keeps the current rung when the upgrade charge is not paid (pending update)", async () => {
    const teamId = await subscribedTeam(withOverage(), 110_500);
    state.declinePayment = true;
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({
      applied: "payment_pending",
    });
    expect(state.updates[0]?.[1]).toMatchObject({
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
    });
    // Nothing moved: the plan, its quota and the period settlement stay as before.
    expect(await team(teamId)).toMatchObject({ plan: "pro", planQuota: 110_000 });
    expect(await reportedOverage(teamId)).toBe(500);
  });

  it("serializes a reporter started during the price POST until readback persists the new binding", async () => {
    const teamId = await subscribedTeam(withOverage(), 110_500);
    const originalTransaction = db.transaction.bind(db);
    const observedDb = Object.create(db) as Db;
    let activeTransaction: Db | null = null;
    observedDb.transaction = (async (...args: Parameters<Db["transaction"]>) => {
      const [operation, config] = args;
      return originalTransaction(async (transaction) => {
        activeTransaction = transaction as unknown as Db;
        try {
          return await operation(transaction);
        } finally {
          activeTransaction = null;
        }
      }, config);
    }) as Db["transaction"];
    const race: { report?: Promise<OverageReport> } = {};
    const originalUpdate = stripe.subscriptions.update;
    stripe.subscriptions.update = async (...args) => {
      const tx = activeTransaction;
      if (!tx) throw new Error("price POST escaped the shared transaction");
      await tx
        .update(schema.usagePeriods)
        .set({ accepted: 111_000 })
        .where(eq(schema.usagePeriods.teamId, teamId));
      race.report = reportOverage(deps(), { now: new Date((PERIOD_START + 1000) * 1000) });
      return originalUpdate(...args);
    };
    const originalRetrieve = stripe.subscriptions.retrieve;
    let readbackUnderLock = false;
    stripe.subscriptions.retrieve = async (...args) => {
      if (state.updates.length) {
        if (!activeTransaction) throw new Error("readback escaped the shared transaction");
        readbackUnderLock = true;
      }
      return originalRetrieve(...args);
    };
    expect(await changeRung({ ...deps(), db: observedDb }, { teamId, rung: "pro_200k" })).toEqual({
      applied: "now",
    });
    if (!race.report) throw new Error("reporter was not started");
    expect(await race.report).toEqual({ reported: 0, failed: 0 });
    expect(readbackUnderLock).toBe(true);
    expect(state.meterEvents.map((event) => event.payload.value)).toEqual(["500"]);
    expect(await team(teamId)).toMatchObject({ planQuota: 220_000, stripeSubscriptionId: "sub_1" });
  });

  it("rejects a price changed before the locked POST and keeps the prior meter step durable", async () => {
    const teamId = await subscribedTeam(withOverage(), 110_500);
    const originalRetrieve = stripe.subscriptions.retrieve;
    let reads = 0;
    stripe.subscriptions.retrieve = async (...args) => {
      const value = await originalRetrieve(...args);
      if (++reads !== 2) return value;
      return {
        ...value,
        items: {
          ...value.items,
          data: value.items.data.map((item, index) =>
            index === 0
              ? { ...item, price: { ...item.price, id: "price_concurrent_change" } }
              : item,
          ),
        },
      };
    };
    await expect(changeRung(deps(), { teamId, rung: "pro_200k" })).rejects.toThrow(
      "Subscription changed before the plan update",
    );
    expect(state.updates).toEqual([]);
    expect(state.meterEvents.map((event) => event.payload.value)).toEqual(["500"]);
    expect(await reportedOverage(teamId)).toBe(500);
    expect(await team(teamId)).toMatchObject({ planQuota: 110_000 });
  });

  it("drops a pending downgrade before moving up", async () => {
    const teamId = await subscribedTeam(
      withOverage("millionsend_pro_200k_monthly", "millionsend_pro_200k_overage", {
        schedule: schedule([price("millionsend_pro_100k_monthly")]),
      }),
    );
    expect(await team(teamId)).toMatchObject({ planQuota: 220_000, pendingRung: "pro_100k" });
    expect(await changeRung(deps(), { teamId, rung: "scale_500k" })).toEqual({ applied: "now" });
    expect(state.scheduleReleases).toEqual(["sched_0"]);
    callOrder("subscriptionSchedules.release", "subscriptions.update");
    expect(await team(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 550_000,
      pendingRung: null,
    });
  });

  it("adds the metered item to a pre-ladder subscription that has none", async () => {
    const teamId = await subscribedTeam(
      subscription("sub_1", "cus_1", "active", "millionsend_pro_monthly", {
        product: legacyProduct("pro"),
        metadata: { millionsend_rung: "pro_100k", included_emails: "110000", period: "month" },
      }),
    );
    expect(await team(teamId)).toMatchObject({ planQuota: 110_000, stripeOverageItemId: null });
    await changeRung(deps(), { teamId, rung: "pro_200k" });
    expect(state.meterEvents).toEqual([]);
    expect(state.updates[0]?.[1].items).toEqual([
      { id: "si_sub_1", price: priceId("millionsend_pro_200k_monthly") },
      { price: priceId("millionsend_pro_200k_overage") },
    ]);
    expect(await team(teamId)).toMatchObject({
      planQuota: 220_000,
      stripeOverageItemId: "si_sub_1_overage",
    });
  });

  it("refuses a rung that is not for sale", async () => {
    const teamId = await subscribedTeam(withOverage());
    await expect(changeRung(deps(), { teamId, rung: "free" })).rejects.toThrow("not for sale");
    expect(state.updates).toEqual([]);
  });
});

describe("verified Send projection and event ordering", () => {
  const launchMetadata = {
    millionsend_rung: "pro_100k",
    mepmail_send_offer: "launch_20261006",
    regular_monthly_cents: "2900",
    included_emails: "110000",
    period: "month",
  };

  it("stores an archived monthly contract and excess price IDs without repricing either item", async () => {
    const sub = withOverage();
    const base = sub.items.data[0];
    const overage = sub.items.data[1];
    if (!base || !overage) throw new Error("Missing fixture items");
    base.price = {
      ...base.price,
      active: false,
      lookup_key: null,
      unit_amount: 2_000,
      metadata: {
        millionsend_rung: "pro_100k",
        included_emails: "100001",
        period: "month",
        overage_cents_per_1k: "150",
      },
    };
    overage.price = { ...overage.price, active: false, lookup_key: null, unit_amount: 150 };
    const teamId = await subscribedTeam(sub);
    await applySubscription(db, sub, () => {}, stripe);
    expect(await team(teamId)).toMatchObject({ planQuota: 100_001 });
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(row?.sendBillingContract).toMatchObject({
      basePriceId: base.price.id,
      baseAmountCents: 2_000,
      regularMonthlyCents: 2_000,
      included: 100_001,
      billingInterval: "month",
    });
    expect(row?.billingTerms).toMatchObject({
      basePriceId: base.price.id,
      overagePriceId: overage.price.id,
      centsPerBlock: 150,
      included: 100_001,
    });
    expect(state.itemCreates).toEqual([]);
    expect(state.itemUpdates).toEqual([]);
  });

  it("retains an already-linked legacy quota without inventing a financial snapshot", async () => {
    const sub = subscription("sub_linked", "cus_linked", "active");
    const base = sub.items.data[0];
    if (!base) throw new Error("Missing base");
    base.price.metadata = { millionsend_rung: "pro_100k" };
    const teamId = await createTeam(db);
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 123_456,
        planStatus: "active",
        stripeCustomerId: "cus_linked",
        stripeSubscriptionId: sub.id,
      })
      .where(eq(schema.teams.id, teamId));
    await applySubscription(db, sub, () => {}, stripe);
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(row).toMatchObject({
      plan: "pro",
      planQuota: 123_456,
      sendBillingContract: null,
      billingTerms: null,
    });
    expect(state.itemCreates).toEqual([]);
  });

  it("does not grant a new or returning customer a quota from product identity alone", async () => {
    const sub = subscription("sub_unknown", "cus_unknown", "active", "millionsend_pro_monthly", {
      product: legacyProduct("pro"),
    });
    const teamId = await createTeam(db);
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_unknown" })
      .where(eq(schema.teams.id, teamId));
    await applySubscription(db, sub, () => {}, stripe);
    expect(await team(teamId)).toMatchObject({
      plan: "free",
      planQuota: null,
      stripeSubscriptionId: null,
    });
  });

  it("projects approved annual Send with monthly hard cap and refuses accidental monthly repricing or metering", async () => {
    const sub = subscription("sub_annual", "cus_annual", "active");
    const base = sub.items.data[0];
    if (!base?.price.recurring) throw new Error("Missing base");
    base.price = {
      ...base.price,
      unit_amount: 29_000,
      metadata: { ...launchMetadata },
      recurring: { ...base.price.recurring, interval: "year", interval_count: 1 },
    };
    base.current_period_end = base.current_period_start + 365 * 86_400;
    const teamId = await subscribedTeam(sub);
    await applySubscription(db, sub, () => {}, stripe);
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(row).toMatchObject({
      plan: "pro",
      planQuota: 110_000,
      overageEnabled: false,
      stripeOverageItemId: null,
      billingTerms: null,
      sendBillingContract: {
        billingInterval: "year",
        baseAmountCents: 29_000,
        regularMonthlyCents: 2_900,
        usageInterval: "month",
        included: 110_000,
      },
    });
    delete base.price.metadata.included_emails;
    await applySubscription(db, sub, () => {}, stripe);
    const [unrecognized] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(unrecognized?.sendBillingContract).toEqual(row?.sendBillingContract);
    base.price.metadata = { ...launchMetadata };
    await expect(setOverage(deps(), { teamId, enabled: true })).rejects.toThrow(
      "monthly plans only",
    );
    await expect(changeRung(deps(), { teamId, rung: "pro_200k" })).rejects.toThrow(
      "explicit annual offer",
    );
    expect(state.itemCreates).toEqual([]);
    expect(state.itemUpdates).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("bootstraps the linked subscription timestamp under the customer lock before accepting a newer one", async () => {
    const previous = subscription("sub_bootstrap_old", "cus_bootstrap", "canceled", undefined, {
      created: PERIOD_START - 200,
    });
    const current = subscription("sub_bootstrap_new", "cus_bootstrap", "active", undefined, {
      created: PERIOD_START - 100,
    });
    const teamId = await createTeam(db);
    state.subscriptions[previous.id] = previous;
    state.subscriptions[current.id] = current;
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 110_000,
        planStatus: "canceled",
        stripeCustomerId: "cus_bootstrap",
        stripeSubscriptionId: previous.id,
        stripeSubscriptionCreated: null,
      })
      .where(eq(schema.teams.id, teamId));
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await lockCustomer(tx, "cus_bootstrap");
      await applySubscription(tx, current, () => {}, stripe);
    });
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(state.retrieves).toContain(previous.id);
    expect(row).toMatchObject({
      stripeSubscriptionId: current.id,
      stripeSubscriptionCreated: current.created,
      planStatus: "active",
    });
  });

  it("does not mint a new paid year when annual renewal fails", async () => {
    const sub = subscription("sub_annual_due", "cus_annual_due", "active");
    const base = sub.items.data[0];
    if (!base?.price.recurring) throw new Error("Missing base");
    base.price = {
      ...base.price,
      unit_amount: 29_000,
      metadata: { ...launchMetadata },
      recurring: { ...base.price.recurring, interval: "year", interval_count: 1 },
    };
    base.current_period_end = base.current_period_start + 365 * 86_400;
    const teamId = await subscribedTeam(sub);
    const [before] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    sub.status = "past_due";
    base.current_period_start = base.current_period_end;
    base.current_period_end += 365 * 86_400;
    await applySubscription(db, sub, () => {}, stripe);
    const [after] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(after?.planStatus).toBe("past_due");
    expect(after?.sendBillingContract).toEqual(before?.sendBillingContract);
    expect(after?.currentPeriodStart).toEqual(before?.currentPeriodStart);
    expect(after?.currentPeriodEnd).toEqual(before?.currentPeriodEnd);
    sub.status = "active";
    await applySubscription(db, sub, () => {}, stripe);
    const [paid] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(paid?.currentPeriodStart).toEqual(new Date(base.current_period_start * 1000));
    expect(paid?.sendBillingContract?.financialPeriodEnd).toBe(
      new Date(base.current_period_end * 1000).toISOString(),
    );
  });

  it("rejects old active and deleted subscription deliveries after a newer verified contract", async () => {
    const current = subscription("sub_order_current", "cus_order", "active", undefined, {
      created: PERIOD_START - 100,
    });
    const teamId = await subscribedTeam(current);
    const stale = subscription(
      "sub_order_stale",
      "cus_order",
      "active",
      "millionsend_scale_500k_monthly",
      { created: PERIOD_START - 200 },
    );
    await applySubscription(db, stale, () => {}, stripe);
    stale.status = "canceled";
    await applySubscription(db, stale, () => {}, stripe);
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(row).toMatchObject({
      stripeSubscriptionId: current.id,
      plan: "pro",
      planQuota: 110_000,
      sendBillingContract: { subscriptionId: current.id },
    });
  });

  it("clears current financial snapshots at cancellation and keeps the ordering tombstone", async () => {
    const sub = withOverage();
    const teamId = await subscribedTeam(sub);
    sub.status = "canceled";
    await applySubscription(db, sub, () => {}, stripe);
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(row).toMatchObject({
      plan: "free",
      sendBillingContract: null,
      billingTerms: null,
      stripeSubscriptionCreated: sub.created,
    });
  });
});

describe("changeRung down", () => {
  const pro200k = () => withOverage("millionsend_pro_200k_monthly", "millionsend_pro_200k_overage");

  it("schedules the cheaper rung for the period end and keeps the paid volume until then", async () => {
    const teamId = await subscribedTeam(pro200k(), 180_000);
    expect(await changeRung(deps(), { teamId, rung: "pro_100k" })).toEqual({
      applied: "period_end",
      at: new Date(PERIOD_END * 1000),
    });
    expect(state.updates).toEqual([]);
    expect(state.meterEvents).toEqual([]);
    expect(state.scheduleCreates).toEqual([{ from_subscription: "sub_1" }]);
    expect(state.scheduleUpdates).toEqual([
      [
        "sched_1",
        {
          end_behavior: "release",
          phases: [
            {
              items: [
                { price: priceId("millionsend_pro_200k_monthly"), quantity: 1 },
                { price: priceId("millionsend_pro_200k_overage") },
              ],
              start_date: PERIOD_START,
              end_date: PERIOD_END,
              proration_behavior: "none",
            },
            {
              items: [
                { price: priceId("millionsend_pro_100k_monthly"), quantity: 1 },
                { price: priceId("millionsend_pro_100k_overage") },
              ],
              duration: { interval: "month", interval_count: 1 },
              proration_behavior: "none",
            },
          ],
        },
      ],
    ]);
    expect(await reportedOverage(teamId)).toBe(0);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 220_000,
      pendingRung: "pro_100k",
    });
  });

  it("choosing the current rung drops the pending downgrade", async () => {
    const teamId = await subscribedTeam(pro200k());
    await changeRung(deps(), { teamId, rung: "pro_100k" });
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({
      applied: "unscheduled",
    });
    expect(state.scheduleReleases).toEqual(["sched_1"]);
    expect(state.scheduleCreates).toHaveLength(1);
    expect(state.updates).toEqual([]);
    expect(await team(teamId)).toMatchObject({ planQuota: 220_000, pendingRung: null });

    // Nothing pending: choosing the current rung touches nothing.
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({
      applied: "unscheduled",
    });
    expect(state.scheduleReleases).toHaveLength(1);
  });

  it("a daily rung's phase carries only the plan price, and a later move reuses the schedule", async () => {
    const teamId = await subscribedTeam(pro200k());
    await changeRung(deps(), { teamId, rung: "pro_100k" });
    await changeRung(deps(), { teamId, rung: "starter" });
    expect(state.scheduleCreates).toHaveLength(1);
    expect(state.scheduleUpdates.map(([id]) => id)).toEqual(["sched_1", "sched_1"]);
    expect(state.scheduleUpdates[1]?.[1].phases?.[1]?.items).toEqual([
      { price: priceId("millionsend_starter_monthly"), quantity: 1 },
    ]);
    expect(await team(teamId)).toMatchObject({ planQuota: 220_000, pendingRung: "starter" });
  });
});

describe("setOverage", () => {
  it("on is a row flag when the metered item is already there", async () => {
    const teamId = await subscribedTeam(withOverage());
    await setOverage(deps(), { teamId, enabled: true });
    expect(state.calls.filter((c) => c !== "subscriptions.retrieve")).toEqual([]);
    expect(await team(teamId)).toMatchObject({
      overageEnabled: true,
      stripeOverageItemId: "si_sub_1_overage",
    });
  });

  it("on adds the rung's metered item to a subscription without one, once", async () => {
    const teamId = await subscribedTeam(subscription("sub_1", "cus_1", "active"));
    await setOverage(deps(), { teamId, enabled: true });
    expect(state.itemCreates).toEqual([
      { subscription: "sub_1", price: priceId("millionsend_pro_100k_overage") },
    ]);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 110_000,
      overageEnabled: true,
      stripeOverageItemId: "si_sub_1_overage",
    });

    await setOverage(deps(), { teamId, enabled: true });
    expect(state.itemCreates).toHaveLength(1);
  });

  it("off flushes unreported usage, then flips the flag and leaves the item", async () => {
    const teamId = await subscribedTeam(withOverage(), 110_500);
    await setOverage(deps(), { teamId, enabled: true });
    await setOverage(deps(), { teamId, enabled: false });
    expect(state.meterEvents.map((e) => e.payload.value)).toEqual(["500"]);
    expect(state.itemDeletes).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(await reportedOverage(teamId)).toBe(500);
    expect(await team(teamId)).toMatchObject({
      overageEnabled: false,
      stripeOverageItemId: "si_sub_1_overage",
    });
  });

  it("is refused on a daily plan", async () => {
    const teamId = await subscribedTeam(
      subscription("sub_1", "cus_1", "active", "millionsend_starter_monthly"),
    );
    await expect(setOverage(deps(), { teamId, enabled: true })).rejects.toThrow(
      "monthly plans only",
    );
    expect(state.itemCreates).toEqual([]);
    expect((await team(teamId))?.overageEnabled).toBe(true);
  });
});
