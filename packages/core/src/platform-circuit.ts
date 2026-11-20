import type { Db } from "@millionsend/db";
// Schema via the clean subpath: the barrel pulls the postgres driver into any
// client bundle that imports these constants.
import * as schema from "@millionsend/db/schema";
import { sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";

/**
 * AWS protects the account, not the tenant. A single tenant pausing itself does
 * nothing when several tenants misbehave at once, and losing SES costs every
 * customer at the same time. These ceilings sit below the provider's own
 * warning line, so the platform stops before AWS does.
 *
 * Complaints are the metric that actually ends an SES account; hard bounces
 * matter too, but a permanent bounce is a dead address, not a recipient saying
 * "this is spam". The complaint ceiling therefore leads.
 */
export const PLATFORM_MIN_SENT = 200;
export const PLATFORM_COMPLAINT_CEILING = 0.001;
export const PLATFORM_BOUNCE_CEILING = 0.05;
/** Rolling window for the account-level reading. */
export const PLATFORM_WINDOW_DAYS = 7;

export type PlatformCircuitReason = "manual_halt" | "complaint_ceiling" | "bounce_ceiling";

export interface PlatformAggregate {
  sent: number;
  complained: number;
  hardBounced: number;
}

export interface PlatformCircuit {
  halt: boolean;
  reason: PlatformCircuitReason | null;
  sent: number;
  complaintRate: number;
  bounceRate: number;
}

/** No sample, no verdict: a handful of sends can look like any rate. */
export function platformCircuitDecision(
  aggregate: PlatformAggregate,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): PlatformCircuit {
  const sent = Math.max(0, aggregate.sent);
  const complained = Math.max(0, aggregate.complained);
  const hardBounced = Math.max(0, aggregate.hardBounced);
  const complaintRate = sent > 0 ? complained / sent : 0;
  const bounceRate = sent > 0 ? hardBounced / sent : 0;
  const base = { sent, complaintRate, bounceRate };

  // The owner's own brake: set it and the platform stops sending without a deploy.
  const manual = (env.PLATFORM_SENDING_HALT ?? "").trim().toLowerCase();
  if (manual === "1" || manual === "true" || manual === "on")
    return { ...base, halt: true, reason: "manual_halt" };
  if (sent < PLATFORM_MIN_SENT) return { ...base, halt: false, reason: null };
  if (complaintRate >= PLATFORM_COMPLAINT_CEILING)
    return { ...base, halt: true, reason: "complaint_ceiling" };
  if (bounceRate >= PLATFORM_BOUNCE_CEILING)
    return { ...base, halt: true, reason: "bounce_ceiling" };
  return { ...base, halt: false, reason: null };
}

/**
 * One aggregate over every tenant. Cheap enough to run once a minute per
 * process, and it never reads message content.
 */
export async function readPlatformAggregate(db: Db, now = new Date()): Promise<PlatformAggregate> {
  const events = schema.emailEvents;
  const since = new Date(now.getTime() - PLATFORM_WINDOW_DAYS * 86_400_000);
  const result = await db.execute(sql`
    select
      count(*) filter (where ${events.type} = 'sent')::int as sent,
      count(distinct ${events.emailId}) filter (where ${events.type} = 'complained')::int as complained,
      count(distinct ${events.emailId}) filter (
        where ${events.type} = 'bounced' and ${events.bounceType} = 'Permanent'
      )::int as hard_bounced
    from ${events}
    where ${events.createdAt} >= ${since}
  `);
  const row = firstRow(result) as { sent?: number | string; complained?: number | string; hard_bounced?: number | string } | undefined;
  return {
    sent: Number(row?.sent ?? 0),
    complained: Number(row?.complained ?? 0),
    hardBounced: Number(row?.hard_bounced ?? 0),
  };
}

