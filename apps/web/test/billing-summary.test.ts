import { describe, expect, it } from "vitest";
import { compatibleBillingTotal, dailyQuotaReference } from "../src/lib/billing-summary";

describe("billing amount compatibility", () => {
  it("adds a same-currency, same-period catalog scenario", () => {
    expect(
      compatibleBillingTotal(
        { amountCents: 0, currency: "BRL", interval: "month" },
        { amountCents: 1490, currency: "brl", interval: "month" },
      ),
    ).toEqual({ amountCents: 1490, currency: "brl", interval: "month" });
  });
  it("does not add different currencies, annual to monthly, missing or invalid amounts", () => {
    const monthly = { amountCents: 14900, currency: "brl", interval: "month" as const };
    expect(compatibleBillingTotal(monthly, { ...monthly, currency: "usd" })).toBeNull();
    expect(compatibleBillingTotal(monthly, { ...monthly, interval: "year" })).toBeNull();
    expect(compatibleBillingTotal(monthly, null)).toBeNull();
    expect(compatibleBillingTotal(monthly, { ...monthly, amountCents: NaN })).toBeNull();
    expect(compatibleBillingTotal(monthly, { ...monthly, amountCents: -1 })).toBeNull();
    expect(
      compatibleBillingTotal(monthly, { ...monthly, amountCents: Number.MAX_SAFE_INTEGER }),
    ).toBeNull();
  });
  it("labels the daily arithmetic with an explicit 30-day reference", () => {
    expect(dailyQuotaReference(100)).toEqual({ days: 30, volume: 3000 });
    expect(dailyQuotaReference(1500)).toEqual({ days: 30, volume: 45000 });
  });
});
