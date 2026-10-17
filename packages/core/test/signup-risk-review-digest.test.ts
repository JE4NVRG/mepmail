import { verifiedMonthlyBilling } from "@millionsend/test-utils";
import { expect, it } from "vitest";
import {
  hasActiveSignupReviewCommercialTerms,
  isSignupReviewPaidTeam,
  type SignupReviewBillingMailbox,
  type SignupReviewBillingTeam,
  signupReviewDomain,
} from "../src/signup-risk-review-digest.js";

const now = new Date("2026-10-17T11:00:00.000Z");
const start = new Date("2026-10-01T00:00:00.000Z");
const end = new Date("2026-11-01T00:00:00.000Z");
const id = "d27b716d-ee7c-4c12-bc95-1d10931ba5f5";
const team: SignupReviewBillingTeam = {
  id,
  planStatus: "active",
  currentPeriodStart: start,
  currentPeriodEnd: end,
  ...verifiedMonthlyBilling({ teamId: id, periodStart: start, periodEnd: end, included: 100_000 }),
};
const mailbox: SignupReviewBillingMailbox = {
  status: "active",
  seats: 1,
  stripeCustomerId: "cus_synthetic",
  stripeSubscriptionId: "sub_synthetic",
  stripePriceId: "price_synthetic",
  stripeSubscriptionItemId: "si_synthetic",
  unitAmount: 1900,
  currency: "brl",
  interval: "month",
  livemode: true,
  periodStart: start,
  periodEnd: end,
};

it("commercial terms need a current bound Send contract; trial and labels alone grant none", () => {
  expect(hasActiveSignupReviewCommercialTerms(team, null, now)).toBe(true);
  expect(hasActiveSignupReviewCommercialTerms({ ...team, planStatus: "past_due" }, null, now)).toBe(
    true,
  );
  expect(hasActiveSignupReviewCommercialTerms({ ...team, planStatus: "trialing" }, null, now)).toBe(
    false,
  );
  expect(
    hasActiveSignupReviewCommercialTerms({ ...team, sendBillingContract: null }, null, now),
  ).toBe(false);
  expect(
    hasActiveSignupReviewCommercialTerms({ ...team, stripeSubscriptionId: "sub_other" }, null, now),
  ).toBe(false);
  expect(
    hasActiveSignupReviewCommercialTerms({ ...team, currentPeriodEnd: start }, null, now),
  ).toBe(false);
  expect(hasActiveSignupReviewCommercialTerms(team, null, end)).toBe(false);
});

it("Correio paid priority needs live commercial identity, positive value and an active period", () => {
  const free = { ...team, planStatus: "none" as const, sendBillingContract: null };
  expect(hasActiveSignupReviewCommercialTerms(free, mailbox, now)).toBe(true);
  for (const invalid of [
    { status: "trialing" as const },
    { livemode: false },
    { unitAmount: 0 },
    { seats: 0 },
    { stripeSubscriptionId: null },
    { stripePriceId: null },
    { periodEnd: now },
    { periodStart: end },
  ])
    expect(hasActiveSignupReviewCommercialTerms(free, { ...mailbox, ...invalid }, now)).toBe(false);
});

it("only confirmed positive provider evidence qualifies as paid", () => {
  expect(isSignupReviewPaidTeam("confirmed")).toBe(true);
  expect(isSignupReviewPaidTeam("not_observed")).toBe(false);
  expect(isSignupReviewPaidTeam("unknown")).toBe(false);
});

it("only DNS names survive the digest domain projection", () => {
  expect(signupReviewDomain("MAIL.Example.Test.")).toBe("mail.example.test");
  expect(signupReviewDomain("xn--exmple-cua.test")).toBe("xn--exmple-cua.test");
  for (const value of [
    "Owner",
    "owner@example.test",
    "<img src=x>",
    "192.0.2.4",
    "2001:db8::1",
    "https://example.test/private",
    "foo.test\nprivate",
    null,
    { domain: "example.test" },
  ])
    expect(signupReviewDomain(value)).toBeNull();
});
