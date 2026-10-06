export interface BillingUsagePeriod {
  /** Inclusive, and suitable for the existing usagePeriods.periodStart key. */
  start: Date;
  /** Exclusive; never later than the confirmed subscription period end. */
  end: Date;
  /** Zero-based month offset from the confirmed period's original UTC anchor. */
  index: number;
}

export interface BillingSubscriptionPeriod {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

function timestamp(date: Date, name: string): number {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new RangeError(`${name} must be a valid Date`);
  }
  return date.getTime();
}

/** Clamp the original anchor's day, without carrying a previous month's clamp forward. */
function anchoredUtcMonth(anchor: Date, index: number): Date {
  const boundary = new Date(anchor.getTime());
  boundary.setUTCDate(1);
  boundary.setUTCMonth(anchor.getUTCMonth() + index);
  const lastDay = new Date(boundary.getTime());
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  boundary.setUTCDate(Math.min(anchor.getUTCDate(), lastDay.getUTCDate()));
  timestamp(boundary, "Calculated month boundary");
  return boundary;
}

/**
 * A monthly usage window within a confirmed subscription period, including an
 * annual period. Boundaries preserve the original UTC day/time, clamping only
 * months without that day: Jan 31 -> Feb 28/29 -> Mar 31, never Mar 28/29.
 *
 * Supply the original event/reservation timestamp as `at` on every retry or
 * compensating release. There is deliberately no wall-clock default. Windows
 * are [start, end), so an event exactly at a monthly boundary uses the new key.
 *
 * Outside the confirmed period this returns null. It does not invent a paid
 * renewal, grace interval, plan, quota or System limit. Consumers retain those
 * policies and must opt in only for contracts with monthly usage cycles.
 */
export function monthlyBillingUsagePeriod(
  subscription: BillingSubscriptionPeriod,
  at: Date,
): BillingUsagePeriod | null {
  const startMs = timestamp(subscription.currentPeriodStart, "currentPeriodStart");
  const endMs = timestamp(subscription.currentPeriodEnd, "currentPeriodEnd");
  const atMs = timestamp(at, "at");
  if (endMs <= startMs) {
    throw new RangeError("Subscription period end must be after its start");
  }
  if (atMs < startMs || atMs >= endMs) return null;

  const anchor = subscription.currentPeriodStart;
  let index =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + at.getUTCMonth() - anchor.getUTCMonth();
  let start = anchoredUtcMonth(anchor, index);
  if (start.getTime() > atMs) {
    index -= 1;
    start = anchoredUtcMonth(anchor, index);
  }
  const next = anchoredUtcMonth(anchor, index + 1);
  return { start, end: new Date(Math.min(next.getTime(), endMs)), index };
}
