import { describe, expect, it } from "vitest";
import {
  clampMailboxPlanSeats,
  isMailboxBundle,
  mailboxPlanMaximumSeats,
  mailboxPlanMinimumSeats,
  mailboxPlanTotal,
  validMailboxPlanSeats,
} from "./mailbox-plan-terms";

const bundle = {
  unitAmount: 1290,
  currency: "usd",
  interval: "month" as const,
  quotaScope: "team" as const,
  includedMailboxes: 3,
  extraUnitAmount: 390,
  localCurrency: { currency: "brl", unitAmount: 6490, extraUnitAmount: 1990 },
  trialDays: 7,
};
const legacy = {
  unitAmount: 1290,
  currency: "usd",
  interval: "month" as const,
  quotaScope: "mailbox" as const,
  includedMailboxes: 1,
  extraUnitAmount: null,
  localCurrency: null,
};

describe("mailbox plan terms", () => {
  it("prices a bundle as its base plus each mailbox above it, in dollars and reais", () => {
    expect(isMailboxBundle(bundle)).toBe(true);
    expect(mailboxPlanMinimumSeats(bundle)).toBe(3);
    expect(mailboxPlanTotal(bundle, 3)).toEqual({ amount: 1290, currency: "usd" });
    expect(mailboxPlanTotal(bundle, 5)).toEqual({ amount: 2070, currency: "usd" });
    expect(mailboxPlanTotal(bundle, 5, true)).toEqual({ amount: 10470, currency: "brl" });
    // Below the bundle is not a valid purchase.
    expect(mailboxPlanTotal(bundle, 2)).toBeNull();
    expect(validMailboxPlanSeats(bundle, 2)).toBe(false);
  });

  it("keeps the per-mailbox prices of the older offers", () => {
    expect(isMailboxBundle(legacy)).toBe(false);
    expect(mailboxPlanMinimumSeats(legacy)).toBe(1);
    expect(mailboxPlanTotal(legacy, 4)).toEqual({ amount: 5160, currency: "usd" });
    expect(mailboxPlanTotal(legacy, 4, true)).toBeNull();
    expect(mailboxPlanMaximumSeats(legacy)).toBe(10_000);
  });

  it("stops a bundle without an extra price at its size and clamps starting quantities", () => {
    const closed = { ...bundle, extraUnitAmount: null };
    expect(mailboxPlanMaximumSeats(closed)).toBe(3);
    expect(mailboxPlanTotal(closed, 4)).toBeNull();
    expect(clampMailboxPlanSeats(bundle, 1)).toBe(3);
    expect(clampMailboxPlanSeats(bundle, 7)).toBe(7);
    expect(clampMailboxPlanSeats(closed, 7)).toBe(3);
    expect(clampMailboxPlanSeats(bundle, Number.NaN)).toBe(3);
  });
});
