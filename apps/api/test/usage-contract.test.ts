import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applySubscription,
  cancelTeamSubscription,
  reconcileTeamPlan,
} from "../../../packages/billing/src/subscription.js";
import { handleWebhook } from "../../../packages/billing/src/webhook.js";
import { fakeStripe, subscription, webhooks } from "../../../packages/billing/test/helpers.js";
import { createApi } from "../src/app.js";
import { usageResponseSchema as previousSchema } from "./usage-previous-schema.js";

let db: Db;
let close: () => Promise<void>;
let api: ReturnType<typeof createApi>;
const fake = fakeStripe();
const start = Math.floor(Date.now() / 1000) - 86400;
const end = start + 30 * 86400;
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing offline fixture");
  return value;
}
const tenants: { id: string; token: string; customer: string; sub: string }[] = [];
const consume = (input: unknown, rate: number) => {
  const parsed = previousSchema.parse(input);
  expect(parsed.period?.overage_usd_per_1k).toBe(rate);
  return parsed.period?.overage_usd_per_1k.toFixed(2);
};
const request = (i = 0) =>
  api.request("/usage", { headers: { authorization: `Bearer ${tenants[i]?.token}` } });
const row = async (i = 0) =>
  required(
    (
      await db
        .select()
        .from(schema.teams)
        .where(eq(schema.teams.id, required(tenants[i]).id))
    )[0],
  );
const apply = (i = 0) =>
  db.transaction((tx) =>
    applySubscription(
      tx as unknown as Db,
      required(fake.state.subscriptions[required(tenants[i]).sub]),
      () => {},
    ),
  );

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  api = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
  for (const [i, cents] of [90, 30].entries()) {
    const id = await createTeam(db, `contract-${i}`);
    const key = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId: id,
      name: "offline",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });
    const customer = `cus_contract_${i}`;
    const subId = `sub_contract_${i}`;
    tenants.push({ id, token: key.token, customer, sub: subId });
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: customer })
      .where(eq(schema.teams.id, id));
    const sub = subscription(subId, customer, "active", "millionsend_pro_100k_monthly", {
      overageKey: "millionsend_pro_100k_overage",
    });
    sub.created = start - 100;
    for (const item of sub.items.data) {
      item.current_period_start = start;
      item.current_period_end = end;
      item.price.active = i !== 0;
      item.price.lookup_key = null;
      item.price.id += `_${i}`;
    }
    required(sub.items.data[1]).price.unit_amount = cents;
    fake.state.subscriptions[subId] = sub;
    await apply(i);
    await db
      .insert(schema.usagePeriods)
      .values({ teamId: id, periodStart: new Date(start * 1000), accepted: 110042 });
  }
});
afterAll(() => close());

describe("durable subscription /usage legacy compatibility", () => {
  it("keeps distinct archived/new prices at the same quota through the real API and old typed consumer", async () => {
    for (const [i, rate] of [0.9, 0.3].entries()) {
      const res = await request(i);
      expect(res.status).toBe(200);
      const body = previousSchema.parse(await res.json());
      expect(consume(body, rate)).toBe(rate.toFixed(2));
      expect(body).toMatchObject({ period: { included: 110000, emails_sent: 110042 } });
      const negative = { ...body, period: { ...body.period, overage_usd_per_1k: null } };
      expect(() => consume(negative, rate)).toThrow();
      expect(() =>
        consume({ ...body, period: { ...body.period, overage_usd_per_1k: rate + 1 } }, rate),
      ).toThrow();
    }
    expect(fake.state.itemUpdates).toEqual([]);
  });

  it("keeps verified terms during Stripe outage, with zero Stripe calls by GET", async () => {
    const before = (await row()).billingTerms;
    const sub = required(fake.state.subscriptions[required(tenants[0]).sub]);
    delete fake.state.subscriptions[sub.id];
    const calls = fake.state.calls.length;
    expect(consume(await (await request()).json(), 0.9)).toBe("0.90");
    expect(fake.state.calls.length).toBe(calls);
    fake.state.subscriptions[sub.id] = sub;
    const original = fake.stripe.subscriptions.retrieve;
    fake.stripe.subscriptions.retrieve = async () => {
      throw new Error("offline");
    };
    await expect(
      reconcileTeamPlan({ db, stripe: fake.stripe }, required(tenants[0]).id),
    ).rejects.toThrow("offline");
    fake.stripe.subscriptions.retrieve = original;
    expect((await row()).billingTerms).toEqual(before);
  });

  it("deduplicates events and refetches instead of applying old payloads", async () => {
    const sub = required(fake.state.subscriptions[required(tenants[0]).sub]);
    const send = async (id: string, created: number) => {
      const payload = JSON.stringify({
        id,
        type: "customer.subscription.updated",
        livemode: false,
        created,
        data: { object: { ...sub, status: "canceled" } },
      });
      const signature = webhooks.generateTestHeaderString({ payload, secret: "whsec_offline" });
      return handleWebhook(payload, signature, {
        db,
        stripe: fake.stripe,
        webhookSecret: "whsec_offline",
        livemode: false,
      });
    };
    expect(await send("evt_new", start)).toBe(200);
    const calls = fake.state.calls.length;
    expect(await send("evt_new", start)).toBe(200);
    expect(fake.state.calls.length).toBe(calls);
    expect(await send("evt_old", start - 1000)).toBe(200);
    expect(consume(await (await request()).json(), 0.9)).toBe("0.90");
  });

  it("returns explicit missing/invalid terms with monthly counters, not null or zero", async () => {
    const saved = (await row()).billingTerms;
    await db
      .update(schema.teams)
      .set({ billingTerms: null })
      .where(eq(schema.teams.id, required(tenants[0]).id));
    const res = await request();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      name: "billing_terms_unavailable",
      usage: { period: { emails_sent: 110042, included: 110000 } },
    });
    await db
      .update(schema.teams)
      .set({ billingTerms: saved })
      .where(eq(schema.teams.id, required(tenants[0]).id));
    const sub = required(fake.state.subscriptions[required(tenants[0]).sub]);
    required(sub.items.data[1]).price.transform_quantity = { divide_by: 1000, round: "down" };
    await apply();
    expect((await request()).status).toBe(409);
    expect((await row()).billingTerms).toBeNull();
    required(sub.items.data[1]).price.transform_quantity = { divide_by: 1000, round: "up" };
    await apply();
  });

  it("rejects tenant leakage and obsolete period snapshots", async () => {
    const saved = (await row()).billingTerms;
    await db
      .update(schema.teams)
      .set({ billingTerms: (await row(1)).billingTerms })
      .where(eq(schema.teams.id, required(tenants[0]).id));
    expect((await request()).status).toBe(409);
    await db
      .update(schema.teams)
      .set({ billingTerms: saved, currentPeriodStart: new Date((start + 1) * 1000) })
      .where(eq(schema.teams.id, required(tenants[0]).id));
    expect((await request()).status).toBe(409);
    await apply();
    expect(consume(await (await request(1)).json(), 0.3)).toBe("0.30");
  });

  it("invalidates removed or unknown items and never extends terms into an unverified renewal", async () => {
    const sub = required(fake.state.subscriptions[required(tenants[0]).sub]);
    const items = [...sub.items.data];
    sub.items.data = items.slice(0, 1);
    await apply();
    expect((await request()).status).toBe(409);
    sub.items.data = items;
    const metadata = required(items[0]).price.metadata;
    required(items[0]).price.metadata = {};
    await apply();
    expect((await row()).billingTerms).toBeNull();
    expect((await request()).status).toBe(409);
    required(items[0]).price.metadata = metadata;
    const expired = Math.floor(Date.now() / 1000) - 3600;
    for (const item of items) item.current_period_end = expired;
    await apply();
    expect((await request()).status).toBe(409);
    for (const item of items) item.current_period_end = end;
    await apply();
    expect(consume(await (await request()).json(), 0.9)).toBe("0.90");
  });

  it("publishes numeric OpenAPI and a distinct documented coverage error", () => {
    const document = api.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "offline", version: "1" },
    });
    const serialized = JSON.stringify(document.components?.schemas?.UsageResponse);
    expect(serialized).toContain('"overage_usd_per_1k":{"type":"number"');
    expect(document.paths?.["/usage"]?.get?.responses?.["409"]).toBeDefined();
  });

  it("switches terms on price change, ignores older subscription, invalidates cancellation", async () => {
    const sub = required(fake.state.subscriptions[required(tenants[0]).sub]);
    required(sub.items.data[1]).price.unit_amount = 28;
    required(sub.items.data[1]).price.id = "price_changed";
    await apply();
    expect(consume(await (await request()).json(), 0.28)).toBe("0.28");
    await db.transaction((tx) =>
      applySubscription(
        tx as unknown as Db,
        { ...sub, id: "sub_older", created: sub.created - 1 },
        () => {},
      ),
    );
    expect((await row()).stripeSubscriptionId).toBe(sub.id);
    sub.status = "canceled";
    await apply();
    expect((await row()).billingTerms).toBeNull();
    const res = await request();
    expect(res.status).toBe(200);
    expect(previousSchema.parse(await res.json()).period).toBeNull();
    expect(consume(await (await request(1)).json(), 0.3)).toBe("0.30");
    await cancelTeamSubscription({ db, stripe: fake.stripe }, required(tenants[0]).id);
    sub.status = "active";
    await apply();
    expect((await row()).stripeSubscriptionId).toBeNull();
    const newer = { ...sub, id: "sub_newer", created: sub.created + 10 };
    await db.transaction((tx) => applySubscription(tx as unknown as Db, newer, () => {}));
    expect((await row()).stripeSubscriptionId).toBe("sub_newer");
    expect(consume(await (await request()).json(), 0.28)).toBe("0.28");
    await apply();
    expect((await row()).stripeSubscriptionId).toBe("sub_newer");
    await db
      .update(schema.teams)
      .set({ plan: "system" })
      .where(eq(schema.teams.id, required(tenants[0]).id));
    const system = previousSchema.parse(await (await request()).json());
    expect(system.plan).toBeNull();
    expect(system.period).toBeNull();
  });
});
