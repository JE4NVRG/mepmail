import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportOverage } from "../src/overage.js";
import { reserveSendSaleCapacity, type SaleReservation } from "../src/send-sale-reservation.js";
import { applySubscription } from "../src/subscription.js";
import { fundedSaleCapacity, installBillingControls } from "./financial-controls-fixture.js";
import { fakeStripe, PERIOD_START, subscription } from "./helpers.js";

let db: Db;
let close: () => Promise<void>;
let fake: ReturnType<typeof fakeStripe>;
const OWNER = "upgrade-settlement-fixture-owner";
const NOW = () => new Date((PERIOD_START + 1000) * 1000);
const deps = (database = db) => ({ db: database, stripe: fake.stripe, log: () => {} });

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await installBillingControls(db);
  fake = fakeStripe();
});
afterEach(() => close());

async function subscribed(suffix = "1") {
  const teamId = await createTeam(db, `settlement-${suffix}`);
  const sub = subscription(
    `sub_${suffix}`,
    `cus_${suffix}`,
    "active",
    "millionsend_pro_100k_monthly",
    {
      overageKey: "millionsend_pro_100k_overage",
    },
  );
  fake.state.subscriptions[sub.id] = sub;
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: sub.customer as string })
    .where(eq(schema.teams.id, teamId));
  await applySubscription(db, sub, () => {});
  await db
    .insert(schema.user)
    .values({
      id: OWNER,
      name: "Settlement fixture",
      email: "settlement-fixture@example.invalid",
    })
    .onConflictDoNothing();
  await db.insert(schema.teamMembers).values({ teamId, userId: OWNER, role: "owner" });
  await db.insert(schema.domains).values({
    teamId,
    name: `settlement-${suffix}.example.invalid`,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  await db.insert(schema.usagePeriods).values({
    teamId,
    periodStart: new Date(PERIOD_START * 1000),
    accepted: 110_500,
    billingTerms: team?.billingTerms ?? null,
  });
  return { teamId, sub };
}

// The existing 110k contract fits the real 4320/day synthetic fixture envelope.
// No capacity assertion or reservation lifecycle is mocked. No larger sale is claimed.
const reserve = (teamId: string, subscriptionId: string) =>
  reserveSendSaleCapacity(
    db,
    {
      teamId,
      userId: OWNER,
      kind: "upgrade",
      rung: "pro_100k",
      subscriptionId,
    },
    fundedSaleCapacity,
  );
const period = async (teamId: string) =>
  (await db.select().from(schema.usagePeriods).where(eq(schema.usagePeriods.teamId, teamId)))[0];
const audit = (teamId: string) =>
  db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, teamId));

async function seedHold(teamId: string, data: Record<string, unknown>, target = randomUUID()) {
  await db.insert(schema.auditLog).values({
    teamId,
    action: "sending.sale_reserved",
    target,
    data,
  });
}

describe("durable upgrade settlement fence", () => {
  it("leaves an ordinary reporter unchanged when there is no sale hold", async () => {
    const { teamId } = await subscribed();
    expect(await reportOverage(deps(), { teamId, now: NOW() })).toEqual({ reported: 1, failed: 0 });
    expect(fake.state.meterEvents.map((e) => e.payload.value)).toEqual(["500"]);
  });

  it("commits the hold, rejects copied/raw authority, and lets only its original settle old terms", async () => {
    const { teamId, sub } = await subscribed();
    const capability = await reserve(teamId, sub.id);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(
      (await audit(teamId)).filter((row) => row.action === "sending.sale_reserved"),
    ).toMatchObject([{ target: capability.id, data: { kind: "upgrade", subscriptionId: sub.id } }]);
    const beforePeriod = await period(teamId);
    for (const scope of [
      undefined,
      { ...capability },
      JSON.parse(JSON.stringify(capability)),
      capability.id as unknown as SaleReservation,
    ]) {
      expect(
        await reportOverage(deps(), { teamId, now: NOW(), upgradeReservation: scope }),
      ).toEqual({ reported: 0, failed: 0 });
      expect(await period(teamId)).toEqual(beforePeriod);
    }
    expect(fake.state.meterEvents).toEqual([]);
    expect(
      await reportOverage(deps(), { teamId, now: NOW(), upgradeReservation: capability }),
    ).toEqual({ reported: 1, failed: 0 });
    expect(fake.state.meterEvents.map((e) => e.payload.value)).toEqual(["500"]);
    expect(await period(teamId)).toMatchObject({ reportedOverage: 500, pendingOverage: null });
    expect((await audit(teamId)).filter((row) => row.action === "sending.sale_released")).toEqual(
      [],
    );
  });

  it("rechecks after the pin commit, preserves that pin, and resumes after exact contract release", async () => {
    const { teamId, sub } = await subscribed();
    const originalTransaction = db.transaction.bind(db);
    const observedDb = Object.create(db) as Db;
    let committed = 0;
    let retained: SaleReservation | undefined;
    observedDb.transaction = (async (...args: Parameters<Db["transaction"]>) => {
      const result = await originalTransaction(...args);
      if (++committed === 1) {
        expect(await period(teamId)).toMatchObject({ pendingOverage: 500, reportedOverage: 0 });
        retained = await reserve(teamId, sub.id);
      }
      return result;
    }) as Db["transaction"];
    expect(await reportOverage(deps(observedDb), { teamId, now: NOW() })).toEqual({
      reported: 0,
      failed: 0,
    });
    expect(committed).toBe(2);
    expect(retained).toBeDefined();
    expect(fake.state.meterEvents).toEqual([]);
    expect(await period(teamId)).toMatchObject({ pendingOverage: 500, reportedOverage: 0 });
    // Transport ambiguity/pending update alone cannot retire the reservation.
    await applySubscription(db, { ...sub, pending_update: {} } as typeof sub, () => {});
    expect(await reportOverage(deps(), { teamId, now: NOW() })).toEqual({ reported: 0, failed: 0 });
    expect(await period(teamId)).toMatchObject({ pendingOverage: 500, reportedOverage: 0 });
    // Use the actual lifecycle on exact provider readback; no manual release insert.
    const confirmed = await fake.stripe.subscriptions.retrieve(sub.id);
    await applySubscription(db, confirmed, () => {});
    expect(
      (await audit(teamId)).filter((row) => row.action === "sending.sale_released"),
    ).toMatchObject([{ target: retained?.id }]);
    expect(await reportOverage(deps(), { teamId, now: NOW() })).toEqual({ reported: 1, failed: 0 });
    expect(fake.state.meterEvents.map((e) => e.payload.value)).toEqual(["500"]);
    expect(await period(teamId)).toMatchObject({ pendingOverage: null, reportedOverage: 500 });
  });

  it("binds the original capability to both team and subscription", async () => {
    const own = await subscribed();
    const capability = await reserve(own.teamId, own.sub.id);
    const other = await subscribed("2");
    await seedHold(other.teamId, { ...capability, subscriptionId: other.sub.id }, capability.id);
    expect(
      await reportOverage(deps(), {
        teamId: other.teamId,
        now: NOW(),
        upgradeReservation: capability,
      }),
    ).toEqual({ reported: 0, failed: 0 });
    expect(await period(other.teamId)).toMatchObject({ pendingOverage: null, reportedOverage: 0 });
    await db
      .update(schema.teams)
      .set({ stripeSubscriptionId: "sub_changed" })
      .where(eq(schema.teams.id, own.teamId));
    expect(
      await reportOverage(deps(), {
        teamId: own.teamId,
        now: NOW(),
        upgradeReservation: capability,
      }),
    ).toEqual({ reported: 0, failed: 0 });
    expect(fake.state.meterEvents).toEqual([]);
  });

  it("retains unknown and ambiguous holds even for an otherwise legitimate scope", async () => {
    const { teamId, sub } = await subscribed();
    const capability = await reserve(teamId, sub.id);
    await seedHold(teamId, { kind: "unknown", subscriptionId: sub.id });
    await db
      .update(schema.usagePeriods)
      .set({ pendingOverage: 500 })
      .where(eq(schema.usagePeriods.teamId, teamId));
    const beforePeriod = await period(teamId);
    for (const scope of [undefined, capability]) {
      expect(
        await reportOverage(deps(), { teamId, now: NOW(), upgradeReservation: scope }),
      ).toEqual({ reported: 0, failed: 0 });
      expect(await period(teamId)).toEqual(beforePeriod);
    }
    expect(fake.state.meterEvents).toEqual([]);
    expect((await audit(teamId)).filter((row) => row.action === "sending.sale_released")).toEqual(
      [],
    );
  });
});
