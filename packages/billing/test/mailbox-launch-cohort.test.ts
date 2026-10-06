import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MailboxLaunchCohort } from "../../core/src/mailbox-launch-cohort.js";
import type { SendBillingContract } from "../../core/src/send-billing-contract.js";
import type { MailboxBillingStripe, MailboxCatalog } from "../src/mailbox.js";
import { hasPaidSendingPlan, hasPaidSendingPlanForMailbox } from "../src/mailbox-addon.js";
import { beginMailboxCheckout } from "../src/mailbox-lifecycle.js";
import { fakeStripe } from "./helpers.js";

const now = new Date("2026-10-06T13:00:00.000Z");
const teamId = "11111111-1111-4111-8111-111111111111";
const start = new Date("2026-10-01T00:00:00.000Z");
const end = new Date("2026-11-01T00:00:00.000Z");
const contract = {
  version: 1,
  teamId,
  customerId: "cus_captured",
  subscriptionId: "sub_captured",
  baseItemId: "si_captured",
  basePriceId: "price_captured_twenty",
  currency: "usd",
  baseAmountCents: 2000,
  billingInterval: "month",
  intervalCount: 1,
  included: 110_000,
  usageInterval: "month",
  regularMonthlyCents: 2000,
  financialPeriodStart: start.toISOString(),
  financialPeriodEnd: end.toISOString(),
  usageAnchor: start.toISOString(),
  verifiedAt: now.toISOString(),
} satisfies SendBillingContract;
const team = {
  id: teamId,
  plan: "pro",
  planStatus: "active",
  stripeCustomerId: "cus_captured",
  stripeSubscriptionId: "sub_captured",
  currentPeriodStart: start,
  currentPeriodEnd: end,
  sendBillingContract: contract,
};
const captured: MailboxLaunchCohort = {
  version: 1,
  capturedAt: "2026-10-06T12:00:00.000Z",
  members: [{ teamId, customerId: "cus_captured", subscriptionId: "sub_captured" }],
};
const granted: MailboxLaunchCohort = {
  ...captured,
  members: captured.members.map((member) => ({ ...member, grandfatheredTwentyDollarPlan: true })),
};

describe("Correio explicit existing-US20 eligibility", () => {
  it("preserves the original >US20 default without inferring an exception", () => {
    expect(hasPaidSendingPlan(team, now)).toBe(false);
    expect(hasPaidSendingPlanForMailbox(team, undefined, now)).toBe(false);
    expect(hasPaidSendingPlanForMailbox(team, null, now)).toBe(false);
    expect(hasPaidSendingPlanForMailbox(team, captured, now)).toBe(false);
    expect(hasPaidSendingPlanForMailbox(team, granted, now)).toBe(true);
    expect(team.sendBillingContract).toEqual(contract);
  });
  it("cannot transfer an explicit grant to another team or customer", () => {
    expect(hasPaidSendingPlanForMailbox({ ...team, id: "other-team" }, granted, now)).toBe(false);
    expect(
      hasPaidSendingPlanForMailbox({ ...team, stripeCustomerId: "cus_other" }, granted, now),
    ).toBe(false);
    const foreign: MailboxLaunchCohort = { ...granted, members: [] };
    expect(hasPaidSendingPlanForMailbox(team, foreign, now)).toBe(false);
  });
  it("requires the original captured subscription for the specific US20 exception", () => {
    const replacement = {
      ...team,
      stripeSubscriptionId: "sub_new",
      sendBillingContract: { ...contract, subscriptionId: "sub_new" },
    };
    expect(hasPaidSendingPlanForMailbox(replacement, granted, now)).toBe(false);
    expect(
      hasPaidSendingPlanForMailbox(
        {
          ...replacement,
          sendBillingContract: {
            ...replacement.sendBillingContract,
            baseAmountCents: 2900,
            regularMonthlyCents: 2900,
          },
        },
        granted,
        now,
      ),
    ).toBe(true);
  });
  it.each(["past_due", "trialing", "canceled", "paused"])(
    "requires a paid-active current contract (%s)",
    (planStatus) => {
      expect(hasPaidSendingPlanForMailbox({ ...team, planStatus }, granted, now)).toBe(false);
    },
  );
  it("denies expired, canceled or mismatched financial windows", () => {
    expect(hasPaidSendingPlanForMailbox({ ...team, currentPeriodEnd: now }, granted, now)).toBe(
      false,
    );
    expect(hasPaidSendingPlanForMailbox({ ...team, cancelAt: now }, granted, now)).toBe(false);
    expect(hasPaidSendingPlanForMailbox({ ...team, currentPeriodStart: now }, granted, now)).toBe(
      false,
    );
    expect(hasPaidSendingPlanForMailbox({ ...team, sendBillingContract: null }, granted, now)).toBe(
      false,
    );
  });
  it("cannot turn discounts, cheaper plans or catalog labels into a US20 grant", () => {
    expect(
      hasPaidSendingPlanForMailbox(
        { ...team, sendBillingContract: { ...contract, regularMonthlyCents: 2900 } },
        granted,
        now,
      ),
    ).toBe(false);
    expect(
      hasPaidSendingPlanForMailbox(
        {
          ...team,
          sendBillingContract: { ...contract, baseAmountCents: 900, regularMonthlyCents: 900 },
        },
        granted,
        now,
      ),
    ).toBe(false);
    expect(hasPaidSendingPlanForMailbox({ ...team, plan: "system" }, granted, now)).toBe(false);
  });
});

describe("private cohort at durable Checkout boundaries", () => {
  const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
  const catalog: MailboxCatalog = {
    livemode: false,
    checkoutPriceId: "price_fixture_correio",
    prices: [
      {
        priceId: "price_fixture_correio",
        currency: "usd",
        unitAmount: 590,
        interval: "month",
        storageBytesPerMailbox: 1024 ** 3,
        includedOutboundPerMailbox: 500,
      },
    ],
  };
  const userId = "cohort_checkout_fixture";
  let db: Db, close: () => Promise<void>, teamId: string, sending: SendBillingContract;
  let stripe: MailboxBillingStripe, state: ReturnType<typeof fakeStripe>["state"];
  let cohort: MailboxLaunchCohort,
    sequence = 0;
  const input = () => ({
    teamId,
    userId,
    seats: 1,
    successUrl: "https://fixture.example.invalid/mailboxes?checkout=success",
    cancelUrl: "https://fixture.example.invalid/mailboxes",
  });
  const purchase = (earlyAccessCohort: MailboxLaunchCohort | null = cohort, database = db) =>
    beginMailboxCheckout(
      { db: database, stripe, requirePaidSendingPlan: true, earlyAccessCohort },
      catalog,
      input(),
    );
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    for (const name of readdirSync(extension)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      for (const statement of readFileSync(extension + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await db.execute(sql.raw(statement));
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Fixture", email: "fixture@example.invalid" });
  });
  afterAll(async () => close());
  beforeEach(async () => {
    sequence++;
    ({ stripe, state } = fakeStripe());
    teamId = await createTeam(db, `cohort-checkout-${sequence}`);
    await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
    const periodStart = new Date(Date.now() - 60_000),
      periodEnd = new Date(Date.now() + 86400_000);
    sending = {
      ...contract,
      teamId,
      customerId: `cus_cohort_checkout_${sequence}`,
      subscriptionId: `sub_cohort_checkout_${sequence}`,
      baseAmountCents: 2900,
      regularMonthlyCents: 2900,
      financialPeriodStart: periodStart.toISOString(),
      financialPeriodEnd: periodEnd.toISOString(),
      usageAnchor: periodStart.toISOString(),
      verifiedAt: new Date().toISOString(),
    };
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planStatus: "active",
        stripeCustomerId: sending.customerId,
        stripeSubscriptionId: sending.subscriptionId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        sendBillingContract: sending,
      })
      .where(eq(schema.teams.id, teamId));
    cohort = {
      version: 1,
      capturedAt: "2020-01-01T00:00:00.000Z",
      members: [{ teamId, customerId: sending.customerId, subscriptionId: sending.subscriptionId }],
    };
    const create = stripe.checkout.sessions.create;
    stripe.checkout.sessions.create = async (params, options) =>
      ({
        ...(await create(params, options)),
        id: `cs_fixture_${sequence}`,
        mode: "subscription",
        customer: params.customer,
        livemode: false,
        metadata: params.metadata,
        status: "open",
        subscription: null,
      }) as Stripe.Checkout.Session;
  });
  it.each(["outside", "invalid"] as const)(
    "denies %s configuration before Checkout or Customer creation",
    async (configuration) => {
      await expect(
        purchase(configuration === "invalid" ? null : { ...cohort, members: [] }),
      ).rejects.toMatchObject({ code: "early_access_required" });
      expect(state.checkouts).toHaveLength(0);
      expect(state.customers).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.mailboxCheckouts)
          .where(eq(schema.mailboxCheckouts.teamId, teamId)),
      ).toHaveLength(0);
    },
  );
  it("honors only an explicit original-US20 exception while preserving its signed contract", async () => {
    sending = { ...sending, baseAmountCents: 2000, regularMonthlyCents: 2000 };
    await db
      .update(schema.teams)
      .set({ sendBillingContract: sending })
      .where(eq(schema.teams.id, teamId));
    await expect(purchase()).rejects.toMatchObject({ code: "sending_plan_required" });
    const granted: MailboxLaunchCohort = {
      ...cohort,
      members: cohort.members.map((m) => ({ ...m, grandfatheredTwentyDollarPlan: true })),
    };
    expect(await purchase(granted)).toMatchObject({
      url: expect.stringContaining("checkout.stripe.com"),
    });
    expect(state.checkouts).toHaveLength(1);
    const [row] = await db
      .select({ contract: schema.teams.sendBillingContract })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    expect(row?.contract).toEqual(sending);
  });
  it("rechecks the customer binding after preparing the durable lease and before Checkout", async () => {
    const original = db.transaction.bind(db);
    const intervening = Object.create(db) as Db;
    let transactions = 0;
    intervening.transaction = (async (...args: Parameters<typeof db.transaction>) => {
      const result = await original(...args);
      if (++transactions === 2)
        await db
          .update(schema.teams)
          .set({ stripeCustomerId: "cus_changed_between_stages" })
          .where(eq(schema.teams.id, teamId));
      return result;
    }) as typeof db.transaction;
    await expect(purchase(cohort, intervening)).rejects.toMatchObject({
      code: "sending_plan_required",
    });
    expect(state.checkouts).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.mailboxCheckouts)
        .where(eq(schema.mailboxCheckouts.teamId, teamId)),
    ).toMatchObject([{ status: "creating" }]);
  });
});
