import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticateApiKey } from "../src/api-key-auth.js";
import { generateApiKey } from "../src/api-keys.js";
import { teamQuota } from "../src/plans.js";
import type { SendBillingContract } from "../src/send-billing-contract.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "auth-team");
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "acme.dev", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  domainId = domain.id;
});
afterAll(() => close());

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

describe("authenticateApiKey scope", () => {
  it("defaults to full_access with no domain restriction", async () => {
    const token = await insertKey();
    const auth = await authenticateApiKey(db, token);
    expect(auth).toMatchObject({ teamId, permission: "full_access", domainId: null });
  });

  it("returns a sending_access key's permission", async () => {
    const token = await insertKey({ permission: "sending_access" });
    const auth = await authenticateApiKey(db, token);
    expect(auth?.permission).toBe("sending_access");
    expect(auth?.domainId).toBeNull();
  });

  it("returns the domain a key is scoped to", async () => {
    const token = await insertKey({ domainId });
    const auth = await authenticateApiKey(db, token);
    expect(auth?.domainId).toBe(domainId);
  });
});

describe("authenticateApiKey billing", () => {
  it("carries the team's billing columns as written, and the effective plan beside them", async () => {
    const token = await insertKey();
    expect((await authenticateApiKey(db, token))?.billing).toEqual({
      id: teamId,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeOverageItemId: null,
      billingTerms: null,
      sendBillingContract: null,
      plan: "free",
      planQuota: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      overageEnabled: true,
      dailySendCeiling: null,
    });
    const currentPeriodStart = new Date("2026-09-01T00:00:00Z");
    const currentPeriodEnd = new Date("2026-10-01T00:00:00Z");
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 220_000,
        currentPeriodStart,
        currentPeriodEnd,
        overageEnabled: true,
        dailySendCeiling: null,
      })
      .where(eq(schema.teams.id, teamId));
    const auth = await authenticateApiKey(db, token);
    expect(auth?.billing).toEqual({
      id: teamId,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeOverageItemId: null,
      billingTerms: null,
      sendBillingContract: null,
      plan: "pro",
      planQuota: 220_000,
      currentPeriodStart,
      currentPeriodEnd,
      overageEnabled: true,
      dailySendCeiling: null,
    });
    expect(auth?.plan).toBe("pro");
  });

  it("carries a verified annual contract into API and SMTP monthly quota enforcement", async () => {
    const id = await createTeam(db, "annual-auth");
    const start = new Date("2030-01-31T12:30:00Z");
    const end = new Date("2031-01-31T12:30:00Z");
    const contract: SendBillingContract = {
      version: 1,
      teamId: id,
      customerId: "cus_annual_auth",
      subscriptionId: "sub_annual_auth",
      baseItemId: "si_annual_auth",
      basePriceId: "price_annual_auth",
      currency: "usd",
      baseAmountCents: 29_000,
      billingInterval: "year",
      intervalCount: 1,
      included: 110_000,
      usageInterval: "month",
      regularMonthlyCents: 2_900,
      financialPeriodStart: start.toISOString(),
      financialPeriodEnd: end.toISOString(),
      usageAnchor: start.toISOString(),
      verifiedAt: start.toISOString(),
    };
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planStatus: "active",
        planQuota: 110_000,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        stripeCustomerId: contract.customerId,
        stripeSubscriptionId: contract.subscriptionId,
        sendBillingContract: contract,
        overageEnabled: false,
      })
      .where(eq(schema.teams.id, id));
    const token = await insertKey({ teamId: id });
    const auth = await authenticateApiKey(db, token);
    expect(auth?.apiKeyId).toBeTruthy();
    expect(auth?.billing.id).toBe(id);
    expect(auth?.billing.sendBillingContract).toEqual(contract);
    if (!auth) throw Error("annual authentication failed");
    expect(teamQuota(auth.billing, true, new Date("2030-02-15T00:00:00Z"))).toMatchObject({
      kind: "month",
      included: 110_000,
      overage: false,
      periodStart: start,
      periodEnd: new Date("2030-02-28T12:30:00Z"),
    });
    expect(teamQuota(auth.billing, true, new Date("2030-03-01T00:00:00Z"))).toMatchObject({
      kind: "month",
      included: 110_000,
      overage: false,
      periodStart: new Date("2030-02-28T12:30:00Z"),
      periodEnd: new Date("2030-03-31T12:30:00Z"),
    });
  });
});
