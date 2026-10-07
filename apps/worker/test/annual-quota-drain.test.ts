import type { SendBillingContract } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { drainQuotaParked } from "../src/handlers/cron.js";

it("drains annual quota against the team binding while preserving the message ID", async () => {
  const { db, close } = await createTestDb();
  try {
    const teamId = await createTeam(db, "annual-drain");
    const start = new Date(Date.now() - 86_400_000);
    const end = new Date(start);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    const contract: SendBillingContract = {
      version: 1,
      teamId,
      customerId: "cus_annual_drain",
      subscriptionId: "sub_annual_drain",
      baseItemId: "si_annual_drain",
      basePriceId: "price_annual_drain",
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
      .where(eq(schema.teams.id, teamId));
    const [email] = await db
      .insert(schema.emails)
      .values({
        teamId,
        from: "sender@example.invalid",
        to: ["recipient@example.invalid"],
        subject: "annual parked",
        latestStatus: "queued_quota",
      })
      .returning({ id: schema.emails.id });
    if (!email) throw Error("missing fixture email");
    const enqueued: string[] = [];
    expect(
      await drainQuotaParked(db, {
        isCloud: true,
        enqueueSends: async (batch) => {
          enqueued.push(...batch.map((job) => job.emailId));
        },
      }),
    ).toEqual({ drained: 1, stillParked: 0 });
    expect(enqueued).toEqual([email.id]);
    expect(enqueued).not.toContain(teamId);
    const [usage] = await db
      .select()
      .from(schema.usagePeriods)
      .where(eq(schema.usagePeriods.teamId, teamId));
    expect(usage).toMatchObject({ accepted: 1, periodStart: start, reportedOverage: 0 });
    expect(usage?.billingTerms).toBeNull();
  } finally {
    await close();
  }
  // The fresh database (every migration) is built inside the test, not in a
  // hook, so it gets the hook budget instead of the 5 s default.
}, 60_000);
