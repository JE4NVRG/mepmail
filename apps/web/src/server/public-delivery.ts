import { getDb, schema } from "@millionsend/db";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import {
  computePublicDeliveryRates,
  type DeliveryCounts,
  metricsWindow,
  type PublicDeliveryRates,
} from "@/lib/public-metrics";

/**
 * The only read behind /delivery: one grouped aggregate over the rolling
 * window, with teams suspended for abuse left out. It selects counts, never a
 * message, a recipient or a team, and the page only ever renders the ratios
 * computePublicDeliveryRates derives from them.
 */
export async function readDeliveryCounts(since: Date, until: Date): Promise<DeliveryCounts> {
  const rows = await getDb()
    .select({ status: schema.emails.latestStatus, emails: sql<string>`count(*)` })
    .from(schema.emails)
    // A left join, so an email whose team row is gone still counts; the filter
    // below only drops rows whose team is currently suspended.
    .leftJoin(schema.teams, eq(schema.emails.teamId, schema.teams.id))
    .where(
      and(
        gte(schema.emails.createdAt, since),
        lt(schema.emails.createdAt, until),
        isNull(schema.teams.suspendedAt),
      ),
    )
    .groupBy(schema.emails.latestStatus);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    // count() is int8: the driver hands it back as a string.
    counts[row.status] = Number(row.emails);
  }
  return counts;
}

/** One database read per hour per process; the page cannot turn traffic into queries. */
export const PUBLIC_METRICS_TTL_MS = 3_600_000;

/** A failed read is retried no sooner than this, so an outage cannot become a query storm. */
const PUBLIC_METRICS_RETRY_MS = 60_000;

export interface PublicMetricsSnapshot {
  /** ISO start of the window. */
  since: string;
  /** ISO end of the window: when the read was taken. */
  until: string;
  /** ISO moment the numbers were computed. */
  computedAt: string;
  /** Null when the window holds too little attempted mail: the page says so. */
  rates: PublicDeliveryRates | null;
}

type CountsReader = (since: Date, until: Date) => Promise<DeliveryCounts>;

/**
 * Memoized reader. Viewing the page never starts a timer, concurrent requests
 * share one read, and a failure keeps serving the last good snapshot (or null,
 * which the page renders as "unavailable") instead of a stack trace.
 */
export function createPublicMetricsReader(
  read: CountsReader,
  now: () => number = Date.now,
): () => Promise<PublicMetricsSnapshot | null> {
  let snapshot: PublicMetricsSnapshot | undefined;
  let expiresAt = 0;
  let pending: Promise<PublicMetricsSnapshot | null> | undefined;
  return async (): Promise<PublicMetricsSnapshot | null> => {
    if (snapshot && now() < expiresAt) return snapshot;
    if (pending) return pending;
    pending = (async () => {
      // One reading of the clock: the window, the computed time and the expiry
      // must describe the same moment.
      const at = now();
      const { since, until } = metricsWindow(at);
      const computedAt = new Date(at).toISOString();
      try {
        const rates = computePublicDeliveryRates(await read(since, until));
        snapshot = { since: since.toISOString(), until: until.toISOString(), computedAt, rates };
        expiresAt = at + PUBLIC_METRICS_TTL_MS;
        return snapshot;
      } catch (error) {
        console.error("public metrics read failed", error);
        expiresAt = at + PUBLIC_METRICS_RETRY_MS;
        return snapshot ?? null;
      }
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

export const readPublicMetrics = createPublicMetricsReader((since, until) =>
  readDeliveryCounts(since, until),
);
