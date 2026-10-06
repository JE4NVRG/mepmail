import { describe, expect, it } from "vitest";
import { resolveSendBillingContract } from "../src/send-contract.js";
import { PERIOD_START, subscription } from "./helpers.js";

const context = {
  teamId: "team_own",
  customerId: "cus_own",
  verifiedAt: new Date("2026-10-06T12:00:00Z"),
};
const launchMetadata = {
  mepmail_send_offer: "launch_20261006",
  millionsend_rung: "pro_100k",
  regular_monthly_cents: "2900",
  included_emails: "110000",
  period: "month",
};

function launchSubscription(interval: "month" | "year" = "month") {
  const sub = subscription("sub_launch", "cus_own", "active");
  const base = sub.items.data[0];
  if (!base) throw new Error("Missing licensed fixture");
  if (!base.price.recurring) throw new Error("Missing recurring fixture");
  base.price = {
    ...base.price,
    unit_amount: interval === "year" ? 29_000 : 2_900,
    metadata: { ...launchMetadata },
    recurring: { ...base.price.recurring, interval, interval_count: 1, usage_type: "licensed" },
  };
  if (interval === "year") base.current_period_end = PERIOD_START + 365 * 86_400;
  return { sub, base };
}

describe("Stripe-derived Send contract", () => {
  it("preserves archived monthly price and quota instead of today's rung", () => {
    const { sub, base } = launchSubscription();
    base.price = {
      ...base.price,
      active: false,
      lookup_key: null,
      unit_amount: 2_000,
      metadata: { millionsend_rung: "pro_100k", included_emails: "100001", period: "month" },
    };
    expect(resolveSendBillingContract(sub, context)).toMatchObject({
      basePriceId: base.price.id,
      baseAmountCents: 2_000,
      regularMonthlyCents: 2_000,
      included: 100_001,
      billingInterval: "month",
    });
  });

  it("keeps the US$29 recurring base even when the invoice has an introductory discount", () => {
    const { sub } = launchSubscription();
    sub.discounts = ["di_first_month"];
    expect(resolveSendBillingContract(sub, context)).toMatchObject({
      baseAmountCents: 2_900,
      regularMonthlyCents: 2_900,
    });
  });

  it("records an annual financial period with 110K monthly usage, never a 12-fold allowance", () => {
    const { sub, base } = launchSubscription("year");
    expect(resolveSendBillingContract(sub, context)).toMatchObject({
      baseAmountCents: 29_000,
      regularMonthlyCents: 2_900,
      billingInterval: "year",
      usageInterval: "month",
      included: 110_000,
      financialPeriodEnd: new Date(base.current_period_end * 1000).toISOString(),
      usageAnchor: new Date(base.current_period_start * 1000).toISOString(),
    });
  });

  it.each([
    { unit_amount: 2_000 },
    { currency: "eur" },
    { metadata: { ...launchMetadata, regular_monthly_cents: "2000" } },
    { metadata: { ...launchMetadata, included_emails: "1320000" } },
    { metadata: { ...launchMetadata, mepmail_send_offer: "unapproved" } },
  ])("rejects a new-offer price that disagrees with approved signed terms: %j", (delta) => {
    const { sub, base } = launchSubscription();
    base.price = { ...base.price, ...delta };
    expect(resolveSendBillingContract(sub, context)).toBeNull();
  });

  it("does not synthesize a legacy quota or infer an arbitrary annual offer from the catalog", () => {
    const { sub, base } = launchSubscription();
    base.price.metadata = { millionsend_rung: "pro_100k" };
    expect(resolveSendBillingContract(sub, context)).toBeNull();
    const annual = launchSubscription("year");
    delete annual.base.price.metadata.mepmail_send_offer;
    expect(resolveSendBillingContract(annual.sub, context)).toBeNull();
  });

  it("rejects duplicate quantities, extra licensed items and mixed annual/metered subscriptions", () => {
    const monthly = launchSubscription();
    monthly.base.quantity = 2;
    expect(resolveSendBillingContract(monthly.sub, context)).toBeNull();
    monthly.base.quantity = 1;
    monthly.sub.items.data.push({ ...monthly.base, id: "si_extra" });
    expect(resolveSendBillingContract(monthly.sub, context)).toBeNull();
    const annual = launchSubscription("year");
    const metered = subscription("sub_meter", "cus_own", "active", undefined, {
      overageKey: "millionsend_pro_100k_overage",
    }).items.data[1];
    if (!metered) throw new Error("Missing metered fixture");
    annual.sub.items.data.push(metered);
    expect(resolveSendBillingContract(annual.sub, context)).toBeNull();
  });

  it("requires matching customer, billable status and valid confirmed period", () => {
    const { sub, base } = launchSubscription();
    expect(resolveSendBillingContract(sub, { ...context, customerId: "cus_other" })).toBeNull();
    sub.status = "canceled";
    expect(resolveSendBillingContract(sub, context)).toBeNull();
    sub.status = "active";
    base.current_period_end = base.current_period_start;
    expect(resolveSendBillingContract(sub, context)).toBeNull();
  });
});
