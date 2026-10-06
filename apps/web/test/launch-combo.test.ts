import { describe, expect, it } from "vitest";
import {
  clearLaunchComboIntent,
  LAUNCH_COMBO_MAX_AGE_MS,
  LAUNCH_COMBO_STORAGE_KEY,
  launchComboQuote,
  matchLaunchComboOffer,
  parseLaunchComboIntent,
  readLaunchComboIntent,
  saveLaunchComboIntent,
} from "@/lib/launch-combo";
import { mailboxCheckoutFailure, safeMailboxCheckoutUrl } from "@/lib/mailbox-checkout";

const NOW = Date.UTC(2026, 9, 6, 23, 0, 0);
const TEAM = "team_combo";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const intent = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    teamId: TEAM,
    tier: "gib1",
    seats: 3,
    interval: "month",
    savedAt: NOW - 1000,
    ...overrides,
  });

// Production Mail catalog terms (provider price IDs are never exposed to the client).
const OFFERS = [
  { id: "a", amt: 590, int: "month", gib: 1 },
  { id: "b", amt: 5900, int: "year", gib: 1 },
  { id: "c", amt: 990, int: "month", gib: 10 },
  { id: "d", amt: 9900, int: "year", gib: 10 },
].map((o) => ({
  offerId: `mbo_${o.id.repeat(43)}`,
  currency: "usd",
  unitAmount: o.amt,
  interval: o.int,
  storageBytesPerMailbox: o.gib * 1024 ** 3,
}));

describe("Send + Mail combo intent", () => {
  it("round-trips a valid choice for the same team", () => {
    const storage = memoryStorage();
    expect(
      saveLaunchComboIntent(
        { teamId: TEAM, tier: "gib10", seats: 5, interval: "year" },
        storage,
        NOW,
      ),
    ).toBe(true);
    expect(readLaunchComboIntent(TEAM, storage, NOW + 1)).toEqual({
      v: 1,
      teamId: TEAM,
      tier: "gib10",
      seats: 5,
      interval: "year",
      savedAt: NOW,
    });
    clearLaunchComboIntent(storage);
    expect(storage.values.has(LAUNCH_COMBO_STORAGE_KEY)).toBe(false);
  });

  it("never carries a choice to another team or past the Checkout lifetime", () => {
    expect(parseLaunchComboIntent(intent(), "other_team", NOW)).toBeNull();
    expect(
      parseLaunchComboIntent(intent({ savedAt: NOW - LAUNCH_COMBO_MAX_AGE_MS - 1 }), TEAM, NOW),
    ).toBeNull();
    expect(parseLaunchComboIntent(intent({ savedAt: NOW + 60_000 }), TEAM, NOW)).toBeNull();
  });

  it("rejects tampered or malformed values", () => {
    for (const bad of [
      intent({ seats: 0 }),
      intent({ seats: 51 }),
      intent({ seats: 2.5 }),
      intent({ seats: "3" }),
      intent({ tier: "gib50" }),
      intent({ interval: "week" }),
      intent({ v: 2 }),
      "not json",
      "null",
      "[]",
    ])
      expect(parseLaunchComboIntent(bad, TEAM, NOW)).toBeNull();
    expect(parseLaunchComboIntent(intent(), TEAM, NOW)?.seats).toBe(3);
  });

  it("degrades quietly when browser storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readLaunchComboIntent(TEAM, blocked, NOW)).toBeNull();
    expect(
      saveLaunchComboIntent({ teamId: TEAM, tier: "gib1", seats: 1, interval: "month" }, blocked),
    ).toBe(false);
    expect(() => clearLaunchComboIntent(blocked)).not.toThrow();
    expect(readLaunchComboIntent(TEAM, null, NOW)).toBeNull();
  });
});

describe("Send + Mail combo offer and quote", () => {
  it("preselects only the server offer with exactly the quoted terms", () => {
    expect(matchLaunchComboOffer(OFFERS, "gib1", "month")).toBe(OFFERS[0]?.offerId);
    expect(matchLaunchComboOffer(OFFERS, "gib1", "year")).toBe(OFFERS[1]?.offerId);
    expect(matchLaunchComboOffer(OFFERS, "gib10", "month")).toBe(OFFERS[2]?.offerId);
    expect(matchLaunchComboOffer(OFFERS, "gib10", "year")).toBe(OFFERS[3]?.offerId);
    const repriced = OFFERS.map((offer) => ({ ...offer, unitAmount: offer.unitAmount + 1 }));
    expect(matchLaunchComboOffer(repriced, "gib1", "month")).toBeNull();
    const otherCurrency = OFFERS.map((offer) => ({ ...offer, currency: "eur" }));
    expect(matchLaunchComboOffer(otherCurrency, "gib10", "year")).toBeNull();
    expect(matchLaunchComboOffer([], "gib1", "month")).toBeNull();
  });

  it("discounts only the Send line, and only on the monthly first bill", () => {
    expect(launchComboQuote({ interval: "month", tier: "gib1", seats: 3 })).toEqual({
      sendFirstCents: 2000,
      sendPeriodCents: 2900,
      mailUnitPeriodCents: 590,
      mailPeriodCents: 1770,
      recurringPeriodCents: 4670,
    });
    expect(launchComboQuote({ interval: "year", tier: "gib10", seats: 2 })).toEqual({
      sendFirstCents: 29000,
      sendPeriodCents: 29000,
      mailUnitPeriodCents: 9900,
      mailPeriodCents: 19800,
      recurringPeriodCents: 48800,
    });
  });
});

describe("shared Mail Checkout helpers", () => {
  it("only follows hosted Stripe Checkout URLs", () => {
    expect(safeMailboxCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_1")).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_1",
    );
    for (const bad of [
      "http://checkout.stripe.com/c/pay/x",
      "https://checkout.stripe.com.evil.example/x",
      "https://user@checkout.stripe.com/x",
      "https://checkout.stripe.com:8443/x",
      "javascript:alert(1)",
    ])
      expect(safeMailboxCheckoutUrl(bad)).toBeNull();
  });

  it("maps server refusals to the step's notices", () => {
    expect(mailboxCheckoutFailure({ message: "subscription_exists" })).toBe("existing");
    expect(mailboxCheckoutFailure({ message: "sending_plan_required" })).toBe(
      "sending_plan_required",
    );
    expect(mailboxCheckoutFailure({ data: { code: "FORBIDDEN" } })).toBe("unavailable");
    expect(mailboxCheckoutFailure(new Error("network"))).toBe("pending");
  });
});
