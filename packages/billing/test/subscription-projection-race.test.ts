import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  applyPreparedSubscription,
  prepareSubscription,
  syncSubscription,
} from "../src/subscription.js";
import {
  SubscriptionProjectionChangedError,
  withSubscriptionProjectionRetry,
} from "../src/subscription-projection-retry.js";
import { handleWebhook } from "../src/webhook.js";
import { fakeStripe, subscription, webhooks } from "./helpers.js";

it("serializes two prepared real webhook transactions by one fresh retry, without duplicating committed hooks", async () => {
  const { db, close } = await createTestDb();
  try {
    const teamId = await createTeam(db);
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_race" })
      .where(eq(schema.teams.id, teamId));
    const { stripe, state } = fakeStripe();
    state.subscriptions.sub_race = subscription(
      "sub_race",
      "cus_race",
      "active",
      "millionsend_pro_100k_monthly",
      { overageKey: "millionsend_pro_100k_overage" },
    );
    const committed: string[] = [];
    const deliver = (id: string) => {
      const payload = JSON.stringify({
        id,
        object: "event",
        type: "customer.subscription.updated",
        livemode: false,
        data: { object: { id: "sub_race", object: "subscription", customer: "cus_race" } },
      });
      return handleWebhook(
        payload,
        webhooks.generateTestHeaderString({ payload, secret: "whsec_race" }),
        {
          db,
          stripe,
          webhookSecret: "whsec_race",
          livemode: false,
          log: () => {},
          afterApply: async (event) => {
            committed.push(event.id);
          },
        },
      );
    };
    expect(await deliver("evt_race_seed")).toBe(200);
    const [seed] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    if (!seed?.billingTerms) throw new Error("fixture requires verified terms");
    await db
      .update(schema.teams)
      .set({ billingTerms: { ...seed.billingTerms, verifiedAt: "2000-01-01T00:00:00.000Z" } })
      .where(eq(schema.teams.id, teamId));
    committed.length = 0;
    state.retrieves.length = 0;
    const original = stripe.subscriptions.retrieve.bind(stripe.subscriptions);
    let arrivals = 0;
    let release: () => void = () => {
      throw new Error("barrier unavailable");
    };
    const bothPrepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    stripe.subscriptions.retrieve = async (id, params) => {
      const snapshot = structuredClone(await original(id, params));
      arrivals++;
      if (arrivals <= 2) {
        if (arrivals === 2) release();
        await bothPrepared;
      }
      return snapshot;
    };
    expect(await Promise.all([deliver("evt_race_a"), deliver("evt_race_b")])).toEqual([200, 200]);
    expect(arrivals).toBe(3);
    expect(committed.sort()).toEqual(["evt_race_a", "evt_race_b"]);
    expect((await db.select().from(schema.stripeEvents)).map((event) => event.id).sort()).toEqual([
      "evt_race_a",
      "evt_race_b",
      "evt_race_seed",
    ]);
    const reads = arrivals;
    stripe.subscriptions.retrieve = async () => {
      throw new Error("provider unavailable during redelivery");
    };
    expect(await deliver("evt_race_b")).toBe(200);
    expect(arrivals).toBe(reads);
    expect(committed).toHaveLength(2);
    // Reconciliation/cancellation also uses a fresh prepared retry, not only webhooks.
    await db
      .update(schema.teams)
      .set({ billingTerms: { ...seed.billingTerms, verifiedAt: "2001-01-01T00:00:00.000Z" } })
      .where(eq(schema.teams.id, teamId));
    let syncArrivals = 0;
    let releaseSync: () => void = () => {
      throw new Error("sync barrier unavailable");
    };
    const syncBarrier = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    stripe.subscriptions.retrieve = async (id, params) => {
      const snapshot = structuredClone(await original(id, params));
      syncArrivals++;
      if (syncArrivals <= 2) {
        if (syncArrivals === 2) releaseSync();
        await syncBarrier;
      }
      return snapshot;
    };
    await Promise.all([
      syncSubscription({ db, stripe }, "cus_race", "sub_race"),
      syncSubscription({ db, stripe }, "cus_race", "sub_race"),
    ]);
    expect(syncArrivals).toBe(3);
    expect(committed).toHaveLength(2);
    expect(state.itemCreates).toEqual([]);
    expect(state.itemUpdates).toEqual([]);
  } finally {
    await close();
  }
}, 60000);

it("rolls back dedupe and never restores stale terms when authority changes on every prepared attempt", async () => {
  const { db, close } = await createTestDb();
  try {
    const teamId = await createTeam(db);
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_stale" })
      .where(eq(schema.teams.id, teamId));
    const { stripe, state } = fakeStripe();
    state.subscriptions.sub_stale = subscription(
      "sub_stale",
      "cus_stale",
      "active",
      "millionsend_pro_100k_monthly",
      { overageKey: "millionsend_pro_100k_overage" },
    );
    let reads = 0;
    await expect(
      withSubscriptionProjectionRetry(
        async () => {
          reads++;
          return prepareSubscription({ db, stripe }, "cus_stale", "sub_stale");
        },
        async (prepared) => {
          await db
            .update(schema.teams)
            .set({ planQuota: 40 + reads })
            .where(eq(schema.teams.id, teamId));
          return db.transaction(async (tx) => {
            await tx
              .insert(schema.stripeEvents)
              .values({ id: "evt_stale", type: "customer.subscription.updated" });
            await applyPreparedSubscription(tx, prepared, () => {}, stripe);
          });
        },
      ),
    ).rejects.toBeInstanceOf(SubscriptionProjectionChangedError);
    expect(reads).toBe(2);
    expect(state.retrieves).toEqual(["sub_stale", "sub_stale"]);
    expect(await db.select().from(schema.stripeEvents)).toEqual([]);
    const [final] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(final).toMatchObject({
      planQuota: 42,
      stripeSubscriptionId: null,
      billingTerms: null,
      sendBillingContract: null,
    });
    expect(state.itemCreates).toEqual([]);
    expect(state.itemUpdates).toEqual([]);
  } finally {
    await close();
  }
}, 60000);

it("never repairs provider billing for a system team with an accidentally associated customer", async () => {
  const { db, close } = await createTestDb();
  try {
    const teamId = await createTeam(db);
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_system", plan: "system" })
      .where(eq(schema.teams.id, teamId));
    const { stripe, state } = fakeStripe();
    state.subscriptions.sub_system = subscription(
      "sub_system",
      "cus_system",
      "active",
      "millionsend_pro_100k_monthly",
    );
    const payload = JSON.stringify({
      id: "evt_system",
      type: "customer.subscription.updated",
      livemode: false,
      data: { object: { id: "sub_system", object: "subscription", customer: "cus_system" } },
    });
    expect(
      await handleWebhook(
        payload,
        webhooks.generateTestHeaderString({ payload, secret: "whsec_system" }),
        { db, stripe, webhookSecret: "whsec_system", livemode: false, log: () => {} },
      ),
    ).toBe(200);
    expect(state.itemCreates).toEqual([]);
    expect(state.itemUpdates).toEqual([]);
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team).toMatchObject({
      plan: "system",
      stripeSubscriptionId: null,
      billingTerms: null,
      sendBillingContract: null,
    });
  } finally {
    await close();
  }
}, 60000);
