import { describe, expect, it } from "vitest";
import { hasPaidSendingPlan } from "../src/mailbox-addon.js";

const now = new Date("2026-10-05T12:00:00Z");
const paid = {
  id: "11111111-1111-4111-8111-111111111111",
  plan: "pro",
  planStatus: "active",
  stripeCustomerId: "cus_sending_addon_fixture",
  stripeSubscriptionId: "sub_sending_addon_fixture",
  currentPeriodStart: new Date("2026-10-01T00:00:00Z"),
  currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
  cancelAt: null,
};
const contract = {
  version: 1 as const,
  teamId: paid.id,
  customerId: paid.stripeCustomerId,
  subscriptionId: paid.stripeSubscriptionId,
  baseItemId: "si_sending_addon_fixture",
  basePriceId: "price_sending_addon_fixture",
  currency: "usd" as const,
  baseAmountCents: 2900,
  billingInterval: "month" as const,
  intervalCount: 1 as const,
  included: 110000,
  usageInterval: "month" as const,
  regularMonthlyCents: 2900,
  financialPeriodStart: paid.currentPeriodStart.toISOString(),
  financialPeriodEnd: paid.currentPeriodEnd.toISOString(),
  usageAnchor: paid.currentPeriodStart.toISOString(),
  verifiedAt: now.toISOString(),
};
const eligible = { ...paid, sendBillingContract: contract };

describe("Correio purchase prerequisite", () => {
  it.each(["starter", "pro", "scale"])("accepts the verified active %s period", (plan) => {
    expect(hasPaidSendingPlan({ ...eligible, plan }, now)).toBe(true);
  });
  it.each(["free", "system"])("does not manufacture a paid subscription for %s", (plan) => {
    expect(hasPaidSendingPlan({ ...eligible, plan }, now)).toBe(false);
  });
  it.each(["none", "trialing", "past_due", "unpaid", "canceled", "incomplete"])(
    "refuses %s even when the paid plan label remains",
    (planStatus) => expect(hasPaidSendingPlan({ ...eligible, planStatus }, now)).toBe(false),
  );
  it.each([
    { stripeCustomerId: null },
    { stripeSubscriptionId: null },
    { stripeSubscriptionId: "invalid" },
    { currentPeriodStart: null },
    { currentPeriodStart: new Date("2026-10-06T00:00:00Z") },
    { currentPeriodEnd: null },
    { currentPeriodEnd: now },
    { currentPeriodEnd: new Date(Number.NaN) },
    { cancelAt: now },
  ])("fails closed for missing or invalid evidence %j", (changes) => {
    expect(hasPaidSendingPlan({ ...eligible, ...changes }, now)).toBe(false);
  });
  it("keeps scheduled cancellation eligible until the already paid period ends", () => {
    expect(hasPaidSendingPlan({ ...eligible, cancelAt: paid.currentPeriodEnd }, now)).toBe(true);
  });
  it.each([900, 1999, 2000, 2001, 2900])(
    "requires a contracted regular monthly amount strictly above 2000: %i",
    (amount) => {
      expect(
        hasPaidSendingPlan(
          {
            ...eligible,
            sendBillingContract: {
              ...contract,
              baseAmountCents: amount,
              regularMonthlyCents: amount,
            },
          },
          now,
        ),
      ).toBe(amount > 2000);
    },
  );
  it("uses the regular base29 contract without reading the promotional invoice20", () => {
    const discountedInvoice = { ...eligible, firstInvoiceCents: 2000 };
    expect(hasPaidSendingPlan(discountedInvoice, now)).toBe(true);
  });
  it("qualifies the verified annual29/290 contract using its regular monthly terms", () => {
    const end = new Date("2027-10-01T00:00:00Z");
    expect(
      hasPaidSendingPlan(
        {
          ...eligible,
          currentPeriodEnd: end,
          sendBillingContract: {
            ...contract,
            baseAmountCents: 29000,
            billingInterval: "year",
            financialPeriodEnd: end.toISOString(),
          },
        },
        now,
      ),
    ).toBe(true);
  });
  it.each([
    null,
    undefined,
    { ...contract, teamId: "another_team" },
    { ...contract, customerId: "cus_another" },
    { ...contract, subscriptionId: "sub_another" },
    { ...contract, currency: "eur" },
    { ...contract, baseAmountCents: 2000 },
    { ...contract, financialPeriodStart: "2026-09-01T00:00:00Z" },
    { ...contract, financialPeriodEnd: "2026-12-01T00:00:00Z" },
  ])("refuses missing, mismatched or inconsistent financial evidence %j", (sendBillingContract) => {
    expect(hasPaidSendingPlan({ ...eligible, sendBillingContract }, now)).toBe(false);
  });
});
