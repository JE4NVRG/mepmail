import { describe, expect, it } from "vitest";
import { evaluateDeliverability } from "../src/deliverability.js";
import { evaluateDeliverabilityRecovery } from "../src/deliverability-recovery.js";

const counts = { sent: 200, hardBounced: 5, complained: 0 };
const health = {
  ...evaluateDeliverability({ warn: counts, pause: counts }),
  sent: 200,
  windowDays: 1,
  pause: { ...counts, windowDays: 1 },
};
describe("rolling recovery advice", () => {
  it.each(["2026-10-28T23:59:00Z", "2026-10-29T00:01:00Z"])(
    "never invents a midnight unlock at %s",
    (instant) => {
      const now = new Date(instant);
      const result = evaluateDeliverabilityRecovery({
        health,
        now,
        dailyCounts: [{ day: "2026-10-28", ...counts }],
      });
      expect(result).toEqual({
        evaluatedAt: now,
        reevaluationEarliestAt: null,
        basis: "unavailable",
        condition: "no_new_sends_or_events",
        projectedStatus: null,
      });
    },
  );
  it("keeps clean health advisory only", () => {
    expect(
      evaluateDeliverabilityRecovery({ health: { ...health, status: "ok" }, now: new Date() }),
    ).toMatchObject({ projectedStatus: "ok", reevaluationEarliestAt: null });
  });
  it("rejects invalid time", () => {
    expect(() => evaluateDeliverabilityRecovery({ health, now: new Date("invalid") })).toThrow(
      RangeError,
    );
  });
});
