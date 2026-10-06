import { describe, expect, it, vi } from "vitest";
import {
  type BillingSubscriptionPeriod,
  monthlyBillingUsagePeriod,
} from "../src/billing-usage-period.js";

function subscription(start: string, end: string): BillingSubscriptionPeriod {
  return { currentPeriodStart: new Date(start), currentPeriodEnd: new Date(end) };
}

function windowAt(period: BillingSubscriptionPeriod, at: string) {
  const result = monthlyBillingUsagePeriod(period, new Date(at));
  if (!result) throw new Error(`No active usage period at ${at}`);
  return { start: result.start.toISOString(), end: result.end.toISOString(), index: result.index };
}

describe("monthly billing usage periods within an annual subscription", () => {
  const clock = "T10:20:30.456Z";
  const ordinary = [
    "2023-01-31",
    "2023-02-28",
    "2023-03-31",
    "2023-04-30",
    "2023-05-31",
    "2023-06-30",
    "2023-07-31",
    "2023-08-31",
    "2023-09-30",
    "2023-10-31",
    "2023-11-30",
    "2023-12-31",
    "2024-01-31",
  ];
  const leap = [
    "2024-01-31",
    "2024-02-29",
    "2024-03-31",
    "2024-04-30",
    "2024-05-31",
    "2024-06-30",
    "2024-07-31",
    "2024-08-31",
    "2024-09-30",
    "2024-10-31",
    "2024-11-30",
    "2024-12-31",
    "2025-01-31",
  ];

  it.each([ordinary, leap])(
    "has twelve contiguous monthly windows without end-of-month drift",
    (...dates: string[]) => {
      const first = dates[0];
      const last = dates[12];
      if (!first || !last) throw new Error("Missing annual test fixture");
      const period = subscription(first + clock, last + clock);
      for (let index = 0; index < 12; index += 1) {
        const begin = dates[index];
        const finish = dates[index + 1];
        if (!begin || !finish) throw new Error("Missing monthly test fixture");
        const expected = { start: begin + clock, end: finish + clock, index };
        expect(windowAt(period, begin + clock)).toEqual(expected);
        const finalInstant = new Date(new Date(finish + clock).getTime() - 1);
        expect(windowAt(period, finalInstant.toISOString())).toEqual(expected);
        if (index > 0) {
          const priorInstant = new Date(new Date(begin + clock).getTime() - 1);
          expect(windowAt(period, priorInstant.toISOString()).index).toBe(index - 1);
        }
      }
      expect(monthlyBillingUsagePeriod(period, new Date(last + clock))).toBeNull();
    },
  );

  it.each([
    [
      "2026-01-30T00:00:00Z",
      "2027-01-30T00:00:00Z",
      "2026-03-01T00:00:00Z",
      "2026-02-28T00:00:00.000Z",
      "2026-03-30T00:00:00.000Z",
    ],
    [
      "2024-02-29T12:00:00Z",
      "2025-02-28T12:00:00Z",
      "2025-02-01T00:00:00Z",
      "2025-01-29T12:00:00.000Z",
      "2025-02-28T12:00:00.000Z",
    ],
    [
      "2026-02-28T00:00:00Z",
      "2027-02-28T00:00:00Z",
      "2026-03-29T00:00:00Z",
      "2026-03-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    ],
    [
      "2099-01-31T00:00:00Z",
      "2100-01-31T00:00:00Z",
      "2099-03-01T00:00:00Z",
      "2099-02-28T00:00:00.000Z",
      "2099-03-31T00:00:00.000Z",
    ],
    [
      "2100-01-31T00:00:00Z",
      "2101-01-31T00:00:00Z",
      "2100-03-01T00:00:00Z",
      "2100-02-28T00:00:00.000Z",
      "2100-03-31T00:00:00.000Z",
    ],
    [
      "2000-01-31T00:00:00Z",
      "2001-01-31T00:00:00Z",
      "2000-03-01T00:00:00Z",
      "2000-02-29T00:00:00.000Z",
      "2000-03-31T00:00:00.000Z",
    ],
    [
      "0099-12-31T00:00:00Z",
      "0100-12-31T00:00:00Z",
      "0100-02-01T00:00:00Z",
      "0100-01-31T00:00:00.000Z",
      "0100-02-28T00:00:00.000Z",
    ],
  ])(
    "uses the original day and real Gregorian month lengths (%s)",
    (begin, finish, at, expectedStart, expectedEnd) => {
      const result = windowAt(subscription(begin, finish), at);
      expect(result.start).toBe(expectedStart);
      expect(result.end).toBe(expectedEnd);
    },
  );

  it("uses UTC time even when input dates have an offset and local days differ", () => {
    const period = subscription("2026-01-31T01:30:00-03:00", "2027-01-31T01:30:00-03:00");
    expect(windowAt(period, "2026-02-28T04:29:59.999Z")).toEqual({
      start: "2026-01-31T04:30:00.000Z",
      end: "2026-02-28T04:30:00.000Z",
      index: 0,
    });
    expect(windowAt(period, "2026-02-28T04:30:00.000Z")).toEqual({
      start: "2026-02-28T04:30:00.000Z",
      end: "2026-03-31T04:30:00.000Z",
      index: 1,
    });
  });

  it("preserves the UTC clock across a daylight-saving transition", () => {
    const period = subscription("2026-02-28T23:30:00Z", "2027-02-28T23:30:00Z");
    expect(windowAt(period, "2026-03-29T00:00:00Z")).toEqual({
      start: "2026-03-28T23:30:00.000Z",
      end: "2026-04-28T23:30:00.000Z",
      index: 1,
    });
  });

  it("clips the final window at the confirmed end rather than adding paid time", () => {
    const period = subscription("2026-01-31T10:00:00Z", "2026-11-15T12:00:00Z");
    expect(windowAt(period, "2026-11-15T11:59:59.999Z")).toEqual({
      start: "2026-10-31T10:00:00.000Z",
      end: "2026-11-15T12:00:00.000Z",
      index: 9,
    });
    expect(monthlyBillingUsagePeriod(period, period.currentPeriodEnd)).toBeNull();
  });

  it("also clips a subscription shorter than one monthly window", () => {
    expect(
      windowAt(
        subscription("2026-01-31T00:00:00Z", "2026-02-15T00:00:00Z"),
        "2026-02-01T00:00:00Z",
      ),
    ).toEqual({
      start: "2026-01-31T00:00:00.000Z",
      end: "2026-02-15T00:00:00.000Z",
      index: 0,
    });
  });

  it("preserves a confirmed monthly Stripe period without creating a second usage window", () => {
    const period = subscription("2026-02-28T10:00:00Z", "2026-03-28T10:00:00Z");
    expect(windowAt(period, "2026-03-28T09:59:59.999Z")).toEqual({
      start: "2026-02-28T10:00:00.000Z",
      end: "2026-03-28T10:00:00.000Z",
      index: 0,
    });
    expect(monthlyBillingUsagePeriod(period, period.currentPeriodEnd)).toBeNull();
  });

  it("returns null before, at the end, or after the confirmed subscription", () => {
    const period = subscription("2026-01-31T00:00:00Z", "2027-01-31T00:00:00Z");
    for (const at of ["2026-01-30T23:59:59.999Z", "2027-01-31T00:00:00Z", "2028-01-01T00:00:00Z"]) {
      expect(monthlyBillingUsagePeriod(period, new Date(at))).toBeNull();
    }
  });

  it("reuses the original event's counter key on a retry after the next monthly boundary", () => {
    const period = subscription("2026-01-31T00:00:00Z", "2027-01-31T00:00:00Z");
    const eventAt = "2026-02-27T23:59:59.999Z";
    const reserved = windowAt(period, eventAt);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
      expect(windowAt(period, eventAt)).toEqual(reserved);
      expect(windowAt(period, new Date().toISOString()).index).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns detached dates so consumers cannot mutate the subscription anchor", () => {
    const period = subscription("2026-01-31T00:00:00Z", "2027-01-31T00:00:00Z");
    const at = new Date("2026-12-31T00:00:00Z");
    const result = monthlyBillingUsagePeriod(period, at);
    if (!result) throw new Error("Expected a usage period");
    expect(result.start).not.toBe(period.currentPeriodStart);
    expect(result.end).not.toBe(period.currentPeriodEnd);
    result.start.setUTCFullYear(2030);
    result.end.setUTCFullYear(2030);
    expect(period.currentPeriodStart.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(period.currentPeriodEnd.toISOString()).toBe("2027-01-31T00:00:00.000Z");
    expect(at.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it.each(["start", "end", "at"] as const)("rejects an invalid %s timestamp", (field) => {
    const period = subscription("2026-01-31T00:00:00Z", "2027-01-31T00:00:00Z");
    const at = field === "at" ? new Date(Number.NaN) : new Date("2026-02-01T00:00:00Z");
    if (field === "start") period.currentPeriodStart = new Date(Number.NaN);
    if (field === "end") period.currentPeriodEnd = new Date(Number.NaN);
    expect(() => monthlyBillingUsagePeriod(period, at)).toThrow(RangeError);
  });

  it.each(["2026-01-31T00:00:00Z", "2026-01-30T00:00:00Z"])(
    "rejects a nonpositive subscription period ending %s",
    (end) => {
      expect(() =>
        monthlyBillingUsagePeriod(
          subscription("2026-01-31T00:00:00Z", end),
          new Date("2026-01-31T00:00:00Z"),
        ),
      ).toThrow(RangeError);
    },
  );
});
