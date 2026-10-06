import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactRoom, fetchTeamQuota } from "../src/team-plan.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});

describe("fetchTeamQuota with persisted signed contracts", () => {
  it("reads the real identity and financial columns into an annual monthly hard cap", async () => {
    const id = await createTeam(db, "signed-annual");
    const start = new Date("2026-01-31T10:00:00Z");
    const end = new Date("2027-01-31T10:00:00Z");
    const contract: NonNullable<typeof schema.teams.$inferInsert.sendBillingContract> = {
      version: 1,
      teamId: id,
      customerId: "cus_annual_read",
      subscriptionId: "sub_annual_read",
      baseItemId: "si_annual",
      basePriceId: "price_annual",
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
        planQuota: 110_000,
        stripeCustomerId: contract.customerId,
        stripeSubscriptionId: contract.subscriptionId,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        sendBillingContract: contract,
        overageEnabled: true,
      })
      .where(eq(schema.teams.id, id));
    expect(await fetchTeamQuota(db, id, true, new Date("2026-02-28T10:00:00Z"))).toEqual({
      kind: "month",
      plan: "pro",
      included: 110_000,
      periodStart: new Date("2026-02-28T10:00:00Z"),
      periodEnd: new Date("2026-03-31T10:00:00Z"),
      overage: false,
      overageCentsPer1k: null,
    });
    await db
      .update(schema.teams)
      .set({ sendBillingContract: { ...contract, teamId: "other" } })
      .where(eq(schema.teams.id, id));
    expect(await fetchTeamQuota(db, id, true, start)).toEqual({
      kind: "day",
      plan: "free",
      limit: 100,
    });
    expect(
      await fetchTeamQuota(db, "00000000-0000-0000-0000-000000000000", true, start),
    ).toBeNull();
  });
});
afterAll(() => close());

const addContacts = (from: number, n: number) =>
  db
    .insert(schema.contacts)
    .values(Array.from({ length: n }, (_, i) => ({ teamId, email: `c${from + i}@example.com` })));

describe("contactRoom", () => {
  it("is what is left under the Free cap, down to zero", async () => {
    await addContacts(0, 998);
    expect(await contactRoom(db, teamId, "free", true)).toBe(2);
    await addContacts(998, 2);
    expect(await contactRoom(db, teamId, "free", true)).toBe(0);
  });

  it("caps nothing on an uncapped plan, on the system plan, or off Cloud", async () => {
    expect(await contactRoom(db, teamId, "pro", true)).toBeNull();
    expect(await contactRoom(db, teamId, "system", true)).toBeNull();
    expect(await contactRoom(db, teamId, "free", false)).toBeNull();
  });
});
