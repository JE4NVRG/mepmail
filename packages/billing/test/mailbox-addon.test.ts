import { describe, expect, it } from "vitest";
import { hasPaidSendingPlan } from "../src/mailbox-addon.js";

const now = new Date("2026-10-05T12:00:00Z");
const paid = {
  plan: "starter",
  planStatus: "active",
  stripeCustomerId: "cus_sending_addon_fixture",
  stripeSubscriptionId: "sub_sending_addon_fixture",
  currentPeriodStart: new Date("2026-10-01T00:00:00Z"),
  currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
  cancelAt: null,
};

describe("Correio purchase prerequisite", () => {
  it.each(["starter", "pro", "scale"])("accepts the verified active %s period", (plan) => {
    expect(hasPaidSendingPlan({ ...paid, plan }, now)).toBe(true);
  });
  it.each(["free", "system"])("does not manufacture a paid subscription for %s", (plan) => {
    expect(hasPaidSendingPlan({ ...paid, plan }, now)).toBe(false);
  });
  it.each(["none", "trialing", "past_due", "unpaid", "canceled", "incomplete"])(
    "refuses %s even when the paid plan label remains",
    (planStatus) => expect(hasPaidSendingPlan({ ...paid, planStatus }, now)).toBe(false),
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
    expect(hasPaidSendingPlan({ ...paid, ...changes }, now)).toBe(false);
  });
  it("keeps scheduled cancellation eligible until the already paid period ends", () => {
    expect(hasPaidSendingPlan({ ...paid, cancelAt: paid.currentPeriodEnd }, now)).toBe(true);
  });
});
