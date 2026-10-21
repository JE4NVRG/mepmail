/**
 * Public delivery rates for /delivery.
 *
 * The page publishes what the platform can measure about itself — delivery,
 * bounce and complaint rates over a rolling window — and nothing that would
 * let a reader infer how much mail any single customer sends. Counts stay in
 * this module and in the server reader; only ratios reach the page.
 *
 * A rate below the floor is not a number worth publishing: fifty emails is
 * noise, and an empty window would render as a perfect score.
 */

export const PUBLIC_METRICS_WINDOW_DAYS = 30;

/** Below this many resolved emails the page says "not enough data" instead of a rate. */
export const PUBLIC_METRICS_MIN_RESOLVED = 500;

/**
 * The statuses of an email that was actually attempted. `canceled` (a
 * scheduled email withdrawn before its send) and `queued_quota` (parked at
 * acceptance) never left the building, so they are not a delivery outcome.
 */
export const RESOLVED_STATUSES = [
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
] as const;

export type ResolvedStatus = (typeof RESOLVED_STATUSES)[number];

/** Counts by status for the window; a status absent from the group-by row is zero. */
export type DeliveryCounts = Partial<Record<ResolvedStatus, number>>;

export interface PublicDeliveryRates {
  /** The denominator, kept for the page's own threshold check — never rendered. */
  resolved: number;
  /** Delivered + opened + clicked, over resolved. */
  deliveryRate: number;
  /** Bounced, over resolved. */
  bounceRate: number;
  /** Complained, over resolved. */
  complaintRate: number;
}

export interface MetricsWindow {
  /** Inclusive start of the rolling window. */
  since: Date;
  /** Exclusive end: the moment the read was taken. */
  until: Date;
}

/** The rolling window ending at `now`, in whole days. */
export function metricsWindow(now: number, days = PUBLIC_METRICS_WINDOW_DAYS): MetricsWindow {
  return { since: new Date(now - days * 24 * 60 * 60 * 1000), until: new Date(now) };
}

/**
 * Rates from the counts, or null when the window holds too little attempted
 * mail for a rate to mean anything. Callers must treat null as "no number".
 */
export function computePublicDeliveryRates(
  counts: DeliveryCounts,
  minimumResolved = PUBLIC_METRICS_MIN_RESOLVED,
): PublicDeliveryRates | null {
  const share = (status: ResolvedStatus) => counts[status] ?? 0;
  const resolved = RESOLVED_STATUSES.reduce((total, status) => total + share(status), 0);
  if (resolved < minimumResolved) return null;
  return {
    resolved,
    deliveryRate: (share("delivered") + share("opened") + share("clicked")) / resolved,
    bounceRate: share("bounced") / resolved,
    complaintRate: share("complained") / resolved,
  };
}
