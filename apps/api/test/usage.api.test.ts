import { randomBytes, randomUUID } from "node:crypto";
import {
  approveProductionVolume,
  DAY_MS,
  EnvKeyring,
  generateApiKey,
  observeProductionVolume,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, verifiedMonthlyBilling } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifiedDns } from "../../../packages/core/test/antiabuse-contract-fixture.js";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let cloud: ReturnType<typeof createApi>;
let selfHost: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
let sendOnlyToken: string;

const get = (app: ReturnType<typeof createApi>, tok = token) =>
  app.request("/usage", { headers: { authorization: `Bearer ${tok}` } });

async function insertKey(overrides: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...overrides,
  });
  return key.token;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "usage-team");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  token = await insertKey();
  sendOnlyToken = await insertKey({ permission: "sending_access" });
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const enqueueEmailSend = async () => {};
  cloud = createApi({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend,
    appBaseUrl: "https://app.example.test",
  });
  selfHost = createApi({ db, keyring, isCloud: false, enqueueEmailSend });
});
afterAll(() => close());

describe("GET /usage", () => {
  it("reports the free plan's limits, an empty day and the dashboard origin on Cloud", async () => {
    const res = await get(cloud);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: { resets_at: string } };
    expect(body).toEqual({
      sending: {
        nominal_emails_per_day: 100,
        effective_emails_per_day: 25,
        state: "restricted",
        reason: "not_approved",
      },
      object: "usage",
      cloud: true,
      plan: "free",
      limits: { emails_per_day: 100, emails_per_month: null, domains: 1, contacts: 1000 },
      today: { emails_sent: 0, resets_at: expect.any(String) },
      period: null,
      team: { id: teamId, name: "usage-team" },
      app_url: "https://app.example.test",
    });
    const resetsAt = new Date(body.today.resets_at);
    expect(resetsAt.toISOString().endsWith("T00:00:00.000Z")).toBe(true);
    expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
    expect(resetsAt.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
  });

  it("counts an accepted send against today", async () => {
    const sent = await cloud.request("/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ from: "a@acme.dev", to: ["r@example.com"], subject: "s", text: "t" }),
    });
    expect(sent.status).toBe(200);
    const body = (await (await get(cloud)).json()) as { today: { emails_sent: number } };
    expect(body.today.emails_sent).toBe(1);
  });

  it("follows the team's effective plan", async () => {
    await db.update(schema.teams).set({ plan: "starter" }).where(eq(schema.teams.id, teamId));
    expect(await (await get(cloud)).json()).toMatchObject({
      plan: "starter",
      limits: { emails_per_day: 1500, emails_per_month: null, domains: 10, contacts: null },
      period: null,
    });
    await db.update(schema.teams).set({ plan: "free" }).where(eq(schema.teams.id, teamId));
  });

  it("reports the billing period's usage on a monthly plan", async () => {
    const start = new Date(Date.now() - 5 * DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    await db
      .update(schema.teams)
      .set({ plan: "pro", planQuota: 110_000, currentPeriodStart: start, currentPeriodEnd: end })
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.usagePeriods).values({ teamId, periodStart: start, accepted: 42 });
    const res = await get(cloud);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      name: "billing_terms_unavailable",
      usage: {
        period: {
          emails_sent: 42,
          included: 110_000,
          overage_enabled: false,
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
        },
      },
    });
    await db
      .update(schema.teams)
      .set({ plan: "free", planQuota: null, currentPeriodStart: null, currentPeriodEnd: null })
      .where(eq(schema.teams.id, teamId));
  });

  it("reports no plan and no limits self-hosted, keeping the counter", async () => {
    expect(await (await get(selfHost)).json()).toMatchObject({
      cloud: false,
      plan: null,
      limits: { emails_per_day: null, emails_per_month: null, domains: null, contacts: null },
      today: { emails_sent: 1 },
      period: null,
      app_url: null,
    });
  });

  it("403s a sending_access key and 401s without one", async () => {
    const res = await get(cloud, sendOnlyToken);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
    expect((await cloud.request("/usage")).status).toBe(401);
  });
});

it("usage separates actual 110K entitlement from explicit young-team effective 4000/day", async () => {
  const id = await createTeam(db, `volume-usage-${randomUUID()}`);
  const op = randomUUID(),
    principal = randomUUID();
  await db.insert(schema.user).values([
    {
      id: op,
      name: "Operator",
      email: `${op}@example.test`,
      emailVerified: true,
      createdAt: new Date(0),
    },
    { id: principal, name: "Principal", email: `${principal}@example.test`, emailVerified: true },
  ]);
  await db.insert(schema.teamSignupRisk).values({
    teamId: id,
    principalUserId: principal,
    level: "good",
    signals: {
      domain: "example.test",
      disposable: false,
      mx: "present",
      domainAgeDays: 100,
      catchAll: "unknown",
      randomLocal: false,
      ipKey: null,
      asn: null,
      signupsIp1h: 0,
      signupsDomain24h: 0,
      signupsAsn1h: 0,
    },
  });
  const start = new Date(Date.now() - DAY_MS),
    end = new Date(Date.now() + 29 * DAY_MS);
  await db
    .update(schema.teams)
    .set({
      ...verifiedMonthlyBilling({
        teamId: id,
        periodStart: start,
        periodEnd: end,
        included: 110000,
      }),
      plan: "pro",
      planStatus: "active",
      planQuota: 110000,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      dailySendCeiling: 4000,
    })
    .where(eq(schema.teams.id, id));
  await db.insert(schema.domains).values({
    teamId: id,
    name: "volume-usage.example.test",
    region: "us-east-1",
    status: "verified",
    ...verifiedDns("volume-usage.example.test"),
    lastCheckedAt: new Date(),
  });
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: id,
    name: "fixture",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const headers = { authorization: `Bearer ${key.token}` };
  expect(await (await cloud.request("/usage", { headers })).json()).toMatchObject({
    limits: { emails_per_month: 110000 },
    sending: { effective_emails_per_day: 25, state: "restricted" },
  });
  await approveProductionVolume(db, {
    teamId: id,
    operatorId: op,
    expectedEpoch: (await observeProductionVolume(db, id)).epoch,
    dailyCeiling: 4000,
    reason: "Synthetic independent reviewed volume",
    evidenceReference: "fixture-evidence-42",
  });
  const body = await (await cloud.request("/usage", { headers })).json();
  expect(body).toMatchObject({
    limits: { emails_per_month: 110000 },
    period: { included: 110000, overage_usd_per_1k: 1.3 },
    sending: {
      nominal_emails_per_day: 4000,
      effective_emails_per_day: 4000,
      state: "approved",
      reason: "approved",
    },
  });
  expect(JSON.stringify(body)).not.toContain("fixture-evidence-42");
  expect(JSON.stringify(body)).not.toContain(principal);
});
