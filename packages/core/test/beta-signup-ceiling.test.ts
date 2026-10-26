import { describe, expect, it } from "vitest";
import { type QuotaTeamRow, raisesQuota, teamQuota } from "../src/plans.js";

const now = new Date("2026-10-26T15:00:00Z");
function row(overrides: Partial<QuotaTeamRow> = {}): QuotaTeamRow {
  return {
    plan: "free",
    planQuota: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    overageEnabled: false,
    dailySendCeiling: null,
    betaDailySendCeiling: 50,
    ...overrides,
  };
}

describe("signup allowance is not a paid-plan operator override", () => {
  it("an explicit operator allowance supersedes the beta allowance on Free", () => {
    expect(teamQuota(row({ dailySendCeiling: 75 }), true, now)).toMatchObject({
      kind: "day",
      limit: 75,
      dailyCeiling: 75,
    });
  });
  it("enforces the automatic allowance on Free", () => {
    expect(teamQuota(row(), true, now)).toEqual({
      kind: "day",
      plan: "free",
      limit: 50,
      dailyCeiling: 50,
    });
  });
  it.each([
    ["starter", null, "day", 1500],
    ["pro", 110000, "month", 110000],
    ["scale", 550000, "month", 550000],
  ] as const)("does not inherit the beta cap on %s", (plan, planQuota, kind, volume) => {
    const quota = teamQuota(row({ plan, planQuota }), true, now);
    expect(quota.kind).toBe(kind);
    expect(quota).not.toHaveProperty("dailyCeiling");
    expect(quota).toMatchObject(kind === "day" ? { limit: volume } : { included: volume });
  });
  it.each([100, 25, 10000])(
    "preserves an intentional manual cap of %i on paid plans",
    (dailySendCeiling) => {
      expect(
        teamQuota(row({ plan: "pro", planQuota: 110000, dailySendCeiling }), true, now),
      ).toMatchObject({ kind: "month", included: 110000, dailyCeiling: dailySendCeiling });
    },
  );
  it("does not reclassify legacy limits by their numeric value", () => {
    expect(
      teamQuota(
        row({
          plan: "pro",
          planQuota: 110000,
          dailySendCeiling: 100,
          betaDailySendCeiling: undefined,
        }),
        true,
        now,
      ),
    ).toMatchObject({ dailyCeiling: 100 });
  });
  it("applies the signup allowance again after the paid entitlement expires", () => {
    expect(
      teamQuota(row({ plan: "pro", currentPeriodEnd: new Date("2026-01-01") }), true, now),
    ).toMatchObject({ kind: "day", plan: "free", limit: 50 });
  });
  it("leaves System and classic self-host alone", () => {
    expect(teamQuota(row({ plan: "system" }), true, now)).toEqual({ kind: "none" });
    expect(teamQuota(row(), false, now)).toEqual({ kind: "none" });
  });
  it("restores the contracted quota on upgrade without changing the manual column", () => {
    const free = row({ betaDailySendCeiling: 100 });
    const paid = { ...free, plan: "pro" as const, planQuota: 110000 };
    expect(raisesQuota(teamQuota(free, true, now), teamQuota(paid, true, now))).toBe(true);
    expect(teamQuota(paid, true, now)).toMatchObject({ included: 110000 });
    expect(teamQuota(paid, true, now)).not.toHaveProperty("dailyCeiling");
    expect(paid.dailySendCeiling).toBeNull();
  });
  it("a later manual decision wins even when it repeats the beta number", () => {
    const paid = row({ plan: "pro", planQuota: 110000, betaDailySendCeiling: 100 });
    expect(teamQuota({ ...paid, dailySendCeiling: 100 }, true, now)).toMatchObject({
      dailyCeiling: 100,
    });
  });
});
