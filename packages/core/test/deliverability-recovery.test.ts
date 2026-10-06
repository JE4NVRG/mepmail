import { describe, expect, it } from "vitest";
import {
  type DeliverabilityHealth,
  evaluateDeliverability,
  type WindowCounts,
} from "../src/deliverability.js";
import {
  type DailyDeliverabilityCounts,
  evaluateDeliverabilityRecovery,
} from "../src/deliverability-recovery.js";

const counts = (sent: number, hardBounced = 0, complained = 0): WindowCounts => ({
  sent,
  hardBounced,
  complained,
});
const health = (warn: WindowCounts, pause = warn): DeliverabilityHealth => ({
  ...evaluateDeliverability({ warn, pause }),
  sent: warn.sent,
  windowDays: 7,
  pause: { ...pause, windowDays: 2 },
});
const now = new Date("2026-10-05T23:59:00Z");

describe("evaluateDeliverabilityRecovery", () => {
  it("gives only the next UTC re-evaluation opportunity when daily distribution is unknown", () => {
    const result = evaluateDeliverabilityRecovery({ health: health(counts(130, 10)), now });
    expect(result).toEqual({
      evaluatedAt: now,
      reevaluationEarliestAt: new Date("2026-10-06T00:00:00Z"),
      basis: "window_totals",
      condition: "no_new_sends_or_events",
      projectedStatus: null,
    });
  });

  it("projects today's 130 sends and 10 hard bounces becoming warning only after the second UTC boundary", () => {
    const current = health(counts(130, 10));
    const dailyCounts = [{ day: "2026-10-05", ...counts(130, 10) }];
    const snapshot = structuredClone({ current, dailyCounts, now });
    const result = evaluateDeliverabilityRecovery({ health: current, now, dailyCounts });
    expect(result.reevaluationEarliestAt).toEqual(new Date("2026-10-07T00:00:00Z"));
    expect(result.projectedStatus).toBe("warning");
    expect(result.basis).toBe("daily_counters");
    expect(result.condition).toBe("no_new_sends_or_events");
    expect({ current, dailyCounts, now }).toEqual(snapshot);
  });

  it("lets yesterday's counts leave the pause window at the next UTC boundary", () => {
    const result = evaluateDeliverabilityRecovery({
      health: health(counts(130, 10)),
      now: new Date("2026-10-05T20:59:00-03:00"),
      dailyCounts: [{ day: "2026-10-04", ...counts(130, 10) }],
    });
    expect(result.reevaluationEarliestAt).toEqual(new Date("2026-10-06T00:00:00Z"));
    expect(result.projectedStatus).toBe("warning");
  });

  it("does not predict a pause improvement while the other metric still satisfies its own criteria", () => {
    const result = evaluateDeliverabilityRecovery({
      health: health(counts(230, 10, 3)),
      now,
      dailyCounts: [
        { day: "2026-10-04", ...counts(130, 10) },
        { day: "2026-10-05", ...counts(100, 0, 3) },
      ],
    });
    expect(result.reevaluationEarliestAt).toEqual(new Date("2026-10-07T00:00:00Z"));
    expect(result.projectedStatus).toBe("warning");
  });

  it("projects a warning on today's counts aging out of the seven-day window", () => {
    const result = evaluateDeliverabilityRecovery({
      health: health(counts(100, 4)),
      now,
      dailyCounts: [{ day: "2026-10-05", ...counts(100, 4) }],
    });
    expect(result.reevaluationEarliestAt).toEqual(new Date("2026-10-12T00:00:00Z"));
    expect(result.projectedStatus).toBe("ok");
  });

  it("rejects incomplete or stale daily counts instead of inventing an unlock time", () => {
    const result = evaluateDeliverabilityRecovery({
      health: health(counts(130, 10)),
      now,
      dailyCounts: [{ day: "2026-10-05", ...counts(129, 9) }],
    });
    expect(result.reevaluationEarliestAt).toBeNull();
    expect(result.projectedStatus).toBeNull();
    expect(result.basis).toBe("unavailable");
  });

  it.each([
    { dailyCounts: [{ day: "2026-10-06", ...counts(130, 10) }] },
    { dailyCounts: [{ day: "2026-10-05", ...counts(-130, 10) }] },
    { dailyCounts: [{ day: "2026-02-30", ...counts(130, 10) }] },
    { dailyCounts: [] },
  ] satisfies { dailyCounts: DailyDeliverabilityCounts[] }[])(
    "refuses invalid daily evidence: %j",
    ({ dailyCounts }) => {
      const result = evaluateDeliverabilityRecovery({
        health: health(counts(130, 10)),
        now,
        dailyCounts,
      });
      expect(result.basis).toBe("unavailable");
      expect(result.reevaluationEarliestAt).toBeNull();
    },
  );

  it("provides no recovery date when this guardrail is already ok", () => {
    const result = evaluateDeliverabilityRecovery({ health: health(counts(99, 10)), now });
    expect(result.reevaluationEarliestAt).toBeNull();
    expect(result.projectedStatus).toBe("ok");
  });
});
