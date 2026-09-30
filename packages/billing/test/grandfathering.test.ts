import { rungByKey, teamQuota } from "@millionsend/core/plans";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { effectiveOverageRate, rungFromPrice, rungFromSubscription } from "../src/prices.js";
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
      overage_cents_per_1k: "90",
    },
  };
  overage.price = {
    ...overage.price,
    active: false,
    lookup_key: null,
    unit_amount: 90,
    metadata: { millionsend_rung: "pro_100k", overage_cents_per_1k: "30" },
  };
  return { sub, base, overage };
}

describe("real subscription resolution, synthetic Stripe fixtures", () => {
  it("keeps archived price terms after lookup rotation instead of the new catalog", () => {
    const { sub, base } = legacySubscription();
    expect(rungByKey("pro_100k").overageCentsPer1k).toBe(30);
    expect(rungFromPrice(base.price)).toMatchObject({ priceCents: 2000, overageCentsPer1k: 90 });
    const resolved = rungFromSubscription(sub);
    expect(resolved).toMatchObject({ priceCents: 2000, overageCentsPer1k: 90 });
    const quota = teamQuota(
      {
        plan: "pro",
        planQuota: 110000,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        overageEnabled: true,
        overageCentsPer1k: resolved?.overageCentsPer1k ?? null,
      },
      true,
    );
    if (quota.kind !== "month" || quota.overageCentsPer1k === null)
      throw new Error("Missing effective rate");
    expect(Math.ceil(1001 / 1000) * quota.overageCentsPer1k).toBe(180);
  });
  it("reads the archived base amount for downgrade timing", () => {
    const { base } = legacySubscription();
    base.price.unit_amount = 10000;
    base.price.metadata.millionsend_rung = "pro_200k";
    expect(rungFromPrice(base.price)?.priceCents).toBe(10000);
    expect(rungByKey("pro_200k").priceCents).toBe(3900);
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
