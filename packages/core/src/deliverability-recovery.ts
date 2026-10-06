import {
  type DeliverabilityHealth,
  type DeliverabilityStatus,
  evaluateDeliverability,
  GUARDRAIL_WINDOW_DAYS,
  PAUSE_WINDOW_DAYS,
  type WindowCounts,
} from "./deliverability.js";
import { DAY_MS, nextUtcDayStart, utcDay } from "./utc-day.js";

export interface DailyDeliverabilityCounts extends WindowCounts {
  /** The UTC day key used by usage_counters. */
  day: string;
}

export interface DeliverabilityRecovery {
  evaluatedAt: Date;
  /** A chance to re-evaluate this guardrail, never a promise that all sending gates will allow mail. */
  reevaluationEarliestAt: Date | null;
  basis: "daily_counters" | "window_totals" | "unavailable";
  condition: "no_new_sends_or_events";
  /** Known only when complete daily counts reconcile with the current health. */
  projectedStatus: DeliverabilityStatus | null;
}

const emptyCounts = (): WindowCounts => ({ sent: 0, hardBounced: 0, complained: 0 });

function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const instant = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(instant) && utcDay(instant) === day;
}

function validCounts(row: WindowCounts): boolean {
  return [row.sent, row.hardBounced, row.complained].every(
    (count) => Number.isSafeInteger(count) && count >= 0,
  );
}

function countsSince(
  rows: readonly DailyDeliverabilityCounts[],
  today: string,
  days: number,
): WindowCounts {
  const since = utcDay(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS);
  return rows.reduce((counts, row) => {
    if (row.day >= since && row.day <= today) {
      counts.sent += row.sent;
      counts.hardBounced += row.hardBounced;
      counts.complained += row.complained;
    }
    return counts;
  }, emptyCounts());
}

/**
 * Pure, conditional recovery guidance. Without daily counts the next UTC
 * midnight is only the earliest calendar opportunity to re-evaluate: the
 * totals cannot tell which events happened today versus yesterday. Complete
 * daily counts are checked against live health before projecting the first
 * boundary where a paused guardrail becomes warning/ok, or warning becomes
 * ok. New sends, late provider events and other holds can change that result.
 * No counters, flags or send permissions are changed by this calculation.
 */
export function evaluateDeliverabilityRecovery(input: {
  health: DeliverabilityHealth;
  now: Date;
  dailyCounts?: readonly DailyDeliverabilityCounts[];
}): DeliverabilityRecovery {
  if (!Number.isFinite(input.now.getTime())) throw new RangeError("Invalid evaluation time");
  const { health, dailyCounts } = input;
  const evaluatedAt = new Date(input.now);
  const result: DeliverabilityRecovery = {
    evaluatedAt,
    reevaluationEarliestAt: null,
    basis: "window_totals",
    condition: "no_new_sends_or_events",
    projectedStatus: health.status === "ok" ? "ok" : null,
  };
  if (health.status === "ok") return result;
  if (dailyCounts === undefined) {
    return { ...result, reevaluationEarliestAt: nextUtcDayStart(evaluatedAt) };
  }

  const today = utcDay(evaluatedAt);
  const since = utcDay(evaluatedAt.getTime() - (GUARDRAIL_WINDOW_DAYS - 1) * DAY_MS);
  const relevant: DailyDeliverabilityCounts[] = [];
  for (const row of dailyCounts) {
    if (!validDay(row.day)) return { ...result, basis: "unavailable" };
    if (row.day < since) continue;
    if (!validCounts(row)) return { ...result, basis: "unavailable" };
    if (row.day > today) {
      if (row.sent || row.hardBounced || row.complained) {
        return { ...result, basis: "unavailable" };
      }
      continue;
    }
    relevant.push(row);
  }

  const warn = countsSince(relevant, today, GUARDRAIL_WINDOW_DAYS);
  const pause = countsSince(relevant, today, PAUSE_WINDOW_DAYS);
  const current = evaluateDeliverability({ warn, pause });
  if (
    health.windowDays !== GUARDRAIL_WINDOW_DAYS ||
    health.pause.windowDays !== PAUSE_WINDOW_DAYS ||
    warn.sent !== health.sent ||
    pause.sent !== health.pause.sent ||
    pause.hardBounced !== health.pause.hardBounced ||
    pause.complained !== health.pause.complained ||
    current.bounceRate !== health.bounceRate ||
    current.complaintRate !== health.complaintRate ||
    current.status !== health.status
  ) {
    return { ...result, basis: "unavailable" };
  }

  const midnight = Date.parse(`${today}T00:00:00Z`);
  for (let offset = 1; offset <= GUARDRAIL_WINDOW_DAYS; offset++) {
    const boundary = new Date(midnight + offset * DAY_MS);
    const day = utcDay(boundary);
    const projected = evaluateDeliverability({
      warn: countsSince(relevant, day, GUARDRAIL_WINDOW_DAYS),
      pause: countsSince(relevant, day, PAUSE_WINDOW_DAYS),
    });
    const improved =
      health.status === "paused" ? projected.status !== "paused" : projected.status === "ok";
    if (improved) {
      return {
        ...result,
        basis: "daily_counters",
        reevaluationEarliestAt: boundary,
        projectedStatus: projected.status,
      };
    }
  }
  return { ...result, basis: "unavailable" };
}
