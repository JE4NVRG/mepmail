import { describe, expect, it } from "vitest";
import { monthlySendDailyRate, rungByKey } from "../src/plans.js";
import { DAY_MS } from "../src/utc-day.js";

const start = new Date("2026-02-01T10:30:00.000Z");
const included = rungByKey("pro_100k").included;
const window = (days: number) => ({ start, end: new Date(start.getTime() + days * DAY_MS) });

describe("monthly Send nominal flow", () => {
  it.each([
    [28, 3_929],
    [29, 3_794],
    [30, 3_667],
    [31, 3_667],
  ])("fits the allowance into a %i-day cycle without lowering longer cycles", (days, daily) => {
    expect(monthlySendDailyRate(included, window(days))).toBe(daily);
    expect(daily * days).toBeGreaterThanOrEqual(included);
  });

  it("does not increase the rate above a regular shortest month for prorated stubs", () => {
    expect(monthlySendDailyRate(included, window(4))).toBe(3_929);
    expect(monthlySendDailyRate(included)).toBe(3_929);
  });

  it("rejects invalid signed windows", () => {
    expect(() => monthlySendDailyRate(included, { start, end: start })).toThrow(RangeError);
    expect(() => monthlySendDailyRate(included, { start, end: new Date(NaN) })).toThrow(RangeError);
  });
});
