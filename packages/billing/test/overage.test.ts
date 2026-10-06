import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportOverage } from "../src/overage.js";
import type { BillingStripe } from "../src/stripe.js";
import { lockCustomer } from "../src/subscription.js";
import { fakeStripe } from "./helpers.js";

const START = new Date("2026-03-01T00:00:00Z");
const END = new Date("2026-04-01T00:00:00Z");
const NOW = new Date("2026-03-15T12:00:00Z");

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

/** A Pro 110K team with one usage row; `overageItem: null` models a subscription without the metered item. */
async function proTeam(
  slug: string,
  opts: {
    accepted: number;
    overageItem?: string | null;
    periodStart?: Date;
    start?: Date;
    end?: Date;
    included?: number;
    centsPerBlock?: number;
  },
): Promise<string> {
  const teamId = await createTeam(db, slug);
  const overageItemId = opts.overageItem === undefined ? `si_${slug}` : opts.overageItem;
  const start = opts.start ?? START;
  const end = opts.end ?? END;
  const terms = {
    version: 1 as const,
    teamId,
    customerId: `cus_${slug}`,
    subscriptionId: `sub_${slug}`,
    baseItemId: `si_${slug}_base`,
    basePriceId: "price_signed_base20",
    overageItemId: overageItemId ?? "si_missing",
    overagePriceId: "price_signed_overage90",
    currency: "usd" as const,
    centsPerBlock: opts.centsPerBlock ?? 90,
    blockSize: 1000 as const,
    rounding: "up" as const,
    included: opts.included ?? 110000,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    verifiedAt: NOW.toISOString(),
  };
  const usageStart = opts.periodStart ?? start;
  const historicalTerms =
    usageStart < start
      ? { ...terms, periodStart: usageStart.toISOString(), periodEnd: start.toISOString() }
      : usageStart.getTime() === start.getTime()
        ? terms
        : null;
  await db
    .update(schema.teams)
    .set({
      plan: "pro",
      planQuota: opts.included ?? 110_000,
      overageEnabled: true,
      stripeCustomerId: `cus_${slug}`,
      stripeOverageItemId: overageItemId,
      stripeSubscriptionId: `sub_${slug}`,
      billingTerms: terms,
      currentPeriodStart: opts.start ?? START,
      currentPeriodEnd: opts.end ?? END,
    })
    .where(eq(schema.teams.id, teamId));
  await db.insert(schema.usagePeriods).values({
    teamId,
    periodStart: usageStart,
    accepted: opts.accepted,
    billingTerms: historicalTerms,
  });
  return teamId;
}

/** What the period row says the meter knows (`reportedOverage`) and is being told (`pendingOverage`). */
async function periodRow(teamId: string, periodStart = START) {
  const t = schema.usagePeriods;
  const [row] = await db
    .select({ reportedOverage: t.reportedOverage, pendingOverage: t.pendingOverage })
    .from(t)
    .where(and(eq(t.teamId, teamId), eq(t.periodStart, periodStart)));
  return row;
}

async function setPeriod(
  teamId: string,
  values: { accepted?: number; reportedOverage?: number; pendingOverage?: number | null },
) {
  await db.update(schema.usagePeriods).set(values).where(eq(schema.usagePeriods.teamId, teamId));
}

const settled = (reportedOverage: number) => ({ reportedOverage, pendingOverage: null });

/** Commit a competing change after the durable pin, before the second locked read. */
function interveningDeps(change: () => Promise<unknown>) {
  const original = db.transaction.bind(db);
  const intercepted = Object.create(db) as Db;
  let transactions = 0;
  intercepted.transaction = (async (...args: Parameters<Db["transaction"]>) => {
    const result = await original(...args);
    if (++transactions === 1) await change();
    return result;
  }) as Db["transaction"];
  return { ...deps(), db: intercepted };
}

describe("reportOverage", () => {
  it("skips a system team that still carries Stripe ids and meters the rest", async () => {
    const systemTeam = await proTeam("own", { accepted: 110_500 });
    await db
      .update(schema.teams)
      .set({ plan: "system", planQuota: null })
      .where(eq(schema.teams.id, systemTeam));
    const paying = await proTeam("acme", { accepted: 110_200 });
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents.map((e) => e.payload.stripe_customer_id)).toEqual(["cus_acme"]);
    expect(await periodRow(paying)).toEqual(settled(200));
    expect(await periodRow(systemTeam)).toEqual(settled(0));
  });

  it("meters what is past the included volume once, advancing from the last report", async () => {
    const teamId = await proTeam("acme", { accepted: 110_500 });

    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents).toEqual([
      {
        event_name: "emails_over_quota",
        identifier: `${teamId}:${START.getTime()}:0:500`,
        timestamp: Math.floor(NOW.getTime() / 1000),
        payload: { stripe_customer_id: "cus_acme", value: "500" },
      },
    ]);
    expect(await periodRow(teamId)).toEqual(settled(500));

    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 0, failed: 0 });
    expect(state.meterEvents).toHaveLength(1);

    await setPeriod(teamId, { accepted: 111_200 });
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[1]).toMatchObject({
      identifier: `${teamId}:${START.getTime()}:500:1200`,
      payload: { stripe_customer_id: "cus_acme", value: "700" },
    });
    expect(await periodRow(teamId)).toEqual(settled(1200));
  });

  it("keeps the pin when Stripe fails, so the next run re-sends the same step", async () => {
    const teamId = await proTeam("acme", { accepted: 110_500 });
    state.meterError = new Error("stripe down");
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 0, failed: 1 });
    expect(await periodRow(teamId)).toEqual({ reportedOverage: 0, pendingOverage: 500 });

    state.meterError = null;
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[0]).toMatchObject({
      identifier: `${teamId}:${START.getTime()}:0:500`,
      payload: { value: "500" },
    });
    expect(await periodRow(teamId)).toEqual(settled(500));
  });

  it("a pinned row re-sends the pinned value under the same identifier even after more sends", async () => {
    const teamId = await proTeam("acme", { accepted: 110_500 });
    // The event went out but the row never caught up (crash after the send).
    await setPeriod(teamId, { pendingOverage: 500, accepted: 111_200 });
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[0]).toMatchObject({
      identifier: `${teamId}:${START.getTime()}:0:500`,
      payload: { value: "500" },
    });
    expect(await periodRow(teamId)).toEqual(settled(500));

    // The step that follows picks up the rest.
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[1]).toMatchObject({
      identifier: `${teamId}:${START.getTime()}:500:1200`,
      payload: { value: "700" },
    });
    expect(await periodRow(teamId)).toEqual(settled(1200));
  });

  it("two runs over the same row: the one that pins sends, the other skips", async () => {
    const teamId = await proTeam("acme", { accepted: 110_500 });
    const results = await Promise.all([
      reportOverage(deps(), { now: NOW }),
      reportOverage(deps(), { now: NOW }),
    ]);
    expect(results.map((r) => r.reported + r.failed).sort()).toEqual([0, 1]);
    expect(results.map((r) => r.failed)).toEqual([0, 0]);
    expect(state.meterEvents).toHaveLength(1);
    expect(await periodRow(teamId)).toEqual(settled(500));
  });

  it("stamps usage of an ended period one second before the current one began", async () => {
    const previous = new Date("2026-02-01T00:00:00Z");
    const teamId = await proTeam("acme", { accepted: 110_500, periodStart: previous });
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[0]).toMatchObject({
      identifier: `${teamId}:${previous.getTime()}:0:500`,
      timestamp: START.getTime() / 1000 - 1,
      payload: { value: "500" },
    });
    expect(await periodRow(teamId, previous)).toEqual(settled(500));
  });

  it("preserves an unverified new renewal window instead of billing inferred terms", async () => {
    const later = new Date("2026-04-01T06:00:00Z");
    const teamId = await proTeam("acme", { accepted: 110_500, periodStart: END });
    expect(await reportOverage(deps(), { now: later })).toEqual({ reported: 0, failed: 1 });
    expect(state.meterEvents).toEqual([]);
    expect(await periodRow(teamId, END)).toEqual(settled(0));
  });

  it("does not reprice an older usage snapshot after the actual price was changed", async () => {
    const teamId = await proTeam("changed", { accepted: 110500 });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    const terms = team?.billingTerms;
    if (!terms) throw new Error("missing fixture terms");
    await db
      .update(schema.teams)
      .set({
        billingTerms: {
          ...terms,
          basePriceId: "price_changed",
          overagePriceId: "price_changed_meter",
          centsPerBlock: 500,
        },
      })
      .where(eq(schema.teams.id, teamId));
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 0, failed: 1 });
    expect(state.meterEvents).toEqual([]);
    expect(await periodRow(teamId)).toEqual(settled(0));
  });

  it.each(["missing", "foreign", "window"] as const)(
    "does not meter a historical snapshot when current terms are %s",
    async (change) => {
      const teamId = await proTeam("invalid", { accepted: 110500 });
      await setPeriod(teamId, { pendingOverage: 500 });
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      const terms = team?.billingTerms;
      if (!terms) throw new Error("missing fixture terms");
      await db
        .update(schema.teams)
        .set(
          change === "missing"
            ? { billingTerms: null }
            : change === "foreign"
              ? { billingTerms: { ...terms, customerId: "cus_someone_else" } }
              : { currentPeriodEnd: new Date("2026-05-01T00:00:00Z") },
        )
        .where(eq(schema.teams.id, teamId));
      expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 0, failed: 1 });
      expect(state.meterEvents).toEqual([]);
      expect(await periodRow(teamId)).toEqual({ reportedOverage: 0, pendingOverage: 500 });
    },
  );

  it("never retroactively assigns current terms to usage that has no snapshot", async () => {
    const teamId = await proTeam("unsigned", { accepted: 110500 });
    await db
      .update(schema.usagePeriods)
      .set({ billingTerms: null })
      .where(eq(schema.usagePeriods.teamId, teamId));
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 0, failed: 1 });
    expect(state.meterEvents).toEqual([]);
    const [period] = await db
      .select()
      .from(schema.usagePeriods)
      .where(eq(schema.usagePeriods.teamId, teamId));
    expect(period).toMatchObject({
      accepted: 110500,
      reportedOverage: 0,
      pendingOverage: null,
      billingTerms: null,
    });
  });

  it.each(["price", "missing", "item", "deleted"] as const)(
    "rereads a %s change committed between the pin and provider invocation",
    async (change) => {
      const teamId = await proTeam("race", { accepted: 110500 });
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      const terms = team?.billingTerms;
      if (!terms) throw new Error("missing fixture terms");
      const interrupted = interveningDeps(async () => {
        expect(await periodRow(teamId)).toEqual({ reportedOverage: 0, pendingOverage: 500 });
        if (change === "deleted") {
          await db.delete(schema.usagePeriods).where(eq(schema.usagePeriods.teamId, teamId));
          return;
        }
        await db
          .update(schema.teams)
          .set(
            change === "price"
              ? {
                  billingTerms: {
                    ...terms,
                    overagePriceId: "price_rotated",
                    centsPerBlock: 500,
                  },
                }
              : change === "missing"
                ? { billingTerms: null }
                : { stripeOverageItemId: null },
          )
          .where(eq(schema.teams.id, teamId));
      });
      expect(await reportOverage(interrupted, { now: NOW })).toEqual({ reported: 0, failed: 1 });
      expect(state.meterEvents).toEqual([]);
      if (change !== "deleted")
        expect(await periodRow(teamId)).toEqual({ reportedOverage: 0, pendingOverage: 500 });
    },
  );

  it("keeps the committed pin if execution stops before the second transaction", async () => {
    const teamId = await proTeam("crash", { accepted: 110500 });
    const interrupted = interveningDeps(async () => {
      throw new Error("execution interrupted after pin commit");
    });
    expect(await reportOverage(interrupted, { now: NOW })).toEqual({ reported: 0, failed: 1 });
    expect(state.meterEvents).toEqual([]);
    expect(await periodRow(teamId)).toEqual({ reportedOverage: 0, pendingOverage: 500 });
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[0]?.identifier).toBe(`${teamId}:${START.getTime()}:0:500`);
  });

  it("uses the archived signed quota and96-cent price instead of today's catalog", async () => {
    const teamId = await proTeam("legacy", {
      accepted: 124456,
      included: 123456,
      centsPerBlock: 96,
    });
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[0]?.payload.value).toBe("1000");
    expect(await periodRow(teamId)).toEqual(settled(1000));
    const [period] = await db
      .select()
      .from(schema.usagePeriods)
      .where(eq(schema.usagePeriods.teamId, teamId));
    expect(period?.billingTerms).toMatchObject({ centsPerBlock: 96, included: 123456 });
  });

  it("works inside an existing customer-locked transaction without releasing the caller", async () => {
    const teamId = await proTeam("nested", { accepted: 110500 });
    const result = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await lockCustomer(tx, "cus_nested");
      return reportOverage({ ...deps(), db: tx }, { now: NOW });
    });
    expect(result).toEqual({ reported: 1, failed: 0 });
    expect(await periodRow(teamId)).toEqual(settled(500));
  });

  it("skips teams without the metered item or under their volume, and narrows to one team", async () => {
    const off = await proTeam("off", { accepted: 110_500, overageItem: null });
    const under = await proTeam("under", { accepted: 109_000 });
    const a = await proTeam("a", { accepted: 110_100 });
    const b = await proTeam("b", { accepted: 110_200 });

    expect(await reportOverage(deps(), { now: NOW, teamId: a })).toEqual({
      reported: 1,
      failed: 0,
    });
    expect(state.meterEvents.map((e) => e.payload.stripe_customer_id)).toEqual(["cus_a"]);
    expect(await periodRow(b)).toEqual(settled(0));

    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents.map((e) => e.payload.stripe_customer_id)).toEqual(["cus_a", "cus_b"]);
    expect(await periodRow(off)).toEqual(settled(0));
    expect(await periodRow(under)).toEqual(settled(0));
  });
});
