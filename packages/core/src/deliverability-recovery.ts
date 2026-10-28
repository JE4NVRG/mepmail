import type { DeliverabilityHealth, DeliverabilityStatus, WindowCounts } from "./deliverability.js";

/** Legacy reporting input only. UTC-day totals cannot project rolling 24h expiry. */
export interface DailyDeliverabilityCounts extends WindowCounts {
  day: string;
}
export interface DeliverabilityRecovery {
  evaluatedAt: Date;
  reevaluationEarliestAt: Date | null;
  basis: "daily_counters" | "window_totals" | "unavailable";
  condition: "no_new_sends_or_events";
  projectedStatus: DeliverabilityStatus | null;
}

/** A midnight boundary is not a rolling-window recovery time. Without exact
 * per-message/event expiry timestamps, never invent an unlock projection.
 * This is advisory only; a persistent review hold still needs explicit release.
 */
export function evaluateDeliverabilityRecovery(input: {
  health: DeliverabilityHealth;
  now: Date;
  dailyCounts?: readonly DailyDeliverabilityCounts[];
}): DeliverabilityRecovery {
  if (!Number.isFinite(input.now.getTime())) throw new RangeError("Invalid evaluation time");
  return {
    evaluatedAt: new Date(input.now),
    reevaluationEarliestAt: null,
    basis: input.health.status === "ok" ? "window_totals" : "unavailable",
    condition: "no_new_sends_or_events",
    projectedStatus: input.health.status === "ok" ? "ok" : null,
  };
}
