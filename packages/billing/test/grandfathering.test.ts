import { rungByKey, teamQuota } from "@millionsend/core/plans";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { effectiveOverageRate, rungFromPrice, rungFromSubscription } from "../src/prices.js";
import { resolveSendBillingContract } from "../src/send-contract.js";
import { subscription } from "./helpers.js";

function legacySubscription() {
  const sub = subscription("sub_old", "cus_old", "active", "millionsend_pro_100k_monthly", {
    overageKey: "millionsend_pro_100k_overage",
  });
  const base = sub.items.data[0];
  const overage = sub.items.data[1];
  if (!base || !overage) throw new Error("Missing fixture items");
  base.price = {
    ...base.price,
    active: false,
    lookup_key: null,
    unit_amount: 2000,
    metadata: {
      millionsend_rung: "pro_100k",
      included_emails: "110000",
      period: "month",
      overage_cents_per_1k: "90",
    },
  };
  overage.price = {
    ...overage.price,
    active: false,
    lookup_key: null,
    unit_amount: 130,
    metadata: { millionsend_rung: "pro_100k", overage_cents_per_1k: "30" },
  };
  return { sub, base, overage };
}

describe("real subscription resolution, synthetic Stripe fixtures", () => {
  it("keeps archived price terms after lookup rotation instead of the new catalog", () => {
    const { sub, base, overage } = legacySubscription();
    expect(rungFromPrice(base.price)).toMatchObject({ priceCents: 2000, overageCentsPer1k: 90 });
    const resolved = rungFromSubscription(sub);
    expect(resolved).toMatchObject({ priceCents: 2000, overageCentsPer1k: 130 });
    const quota = teamQuota(
      {
        id: "team_old",
        stripeCustomerId: "cus_old",
        stripeSubscriptionId: sub.id,
        stripeOverageItemId: overage.id,
        sendBillingContract: resolveSendBillingContract(sub, {
          teamId: "team_old",
          customerId: "cus_old",
        }),
        billingTerms: {
          version: 1,
          teamId: "team_old",
          customerId: "cus_old",
          subscriptionId: sub.id,
          baseItemId: base.id,
          basePriceId: base.price.id,
          overageItemId: overage.id,
          overagePriceId: overage.price.id,
          currency: "usd",
          centsPerBlock: 130,
          blockSize: 1000,
          rounding: "up",
          included: 110_000,
          periodStart: new Date(base.current_period_start * 1000).toISOString(),
          periodEnd: new Date(base.current_period_end * 1000).toISOString(),
          verifiedAt: new Date().toISOString(),
        },
        plan: "pro",
        planQuota: 110000,
        currentPeriodStart: new Date(base.current_period_start * 1000),
        currentPeriodEnd: new Date(base.current_period_end * 1000),
        overageEnabled: true,
        overageCentsPer1k: resolved?.overageCentsPer1k ?? null,
      },
      true,
    );
    if (quota.kind !== "month" || quota.overageCentsPer1k === null)
      throw new Error("Missing effective rate");
    expect(Math.ceil(1001 / 1000) * quota.overageCentsPer1k).toBe(260);
  });
  it("reads the archived base amount for downgrade timing", () => {
    const { base } = legacySubscription();
    base.price.unit_amount = 25000;
    base.price.metadata.millionsend_rung = "pro_200k";
    expect(rungFromPrice(base.price)?.priceCents).toBe(25000);
    expect(rungFromPrice(base.price)?.priceCents).not.toBe(rungByKey("pro_200k").priceCents);
  });
  it("does not claim a catalog rate for a row without financial terms", () => {
    const quota = teamQuota(
      {
        plan: "pro",
        planQuota: 110000,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        overageEnabled: true,
      },
      true,
    );
    expect(quota).toMatchObject({ kind: "month", overageCentsPer1k: null });
    const { sub } = legacySubscription();
    sub.items.data.splice(1);
    expect(rungFromSubscription(sub)?.overageCentsPer1k).toBeNull();
  });
  it.each([
    { transform_quantity: { divide_by: 1000, round: "down" } },
    { transform_quantity: { divide_by: 100, round: "up" } },
    { unit_amount: null },
    { currency: "eur" },
  ])("rejects incompatible effective overage terms: %j", (delta) => {
    const { overage } = legacySubscription();
    expect(effectiveOverageRate({ ...overage.price, ...delta } as Stripe.Price)).toBeNull();
  });
});
