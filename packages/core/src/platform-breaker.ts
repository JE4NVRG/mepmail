import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { RegionBreakerReason } from "@millionsend/db/schema";
import { and, asc, desc, eq, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { MIN_PAUSE_COMPLAINTS, MIN_PAUSE_HARD_BOUNCES } from "./deliverability.js";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * SES enforces bounce/complaint rates on the whole account per region: one
 * team's bad week pauses every customer in that region. The breaker watches
 * the aggregate and holds broadcasts (never transactional mail) at a fraction
 * of SES's own review lines, so the platform stops itself before AWS does.
 */
// 80% of SES's review lines (5% / 0.1%), written as literals: 0.8 * 0.05 is
// 0.04000000000000001 in floating point, and 40 bounces in 1000 must trip.
export const BREAKER_BOUNCE_RATE = 0.02;
/** Any confirmed complaint trips: one complaint now risks the whole account. */
export const BREAKER_COMPLAINT_RATE = 0;
/** Bounce needs a real denominator; low-volume regions still get judged. */
export const BREAKER_MIN_SENT = 100;
/** A complaint has no volume floor: one is enough at any sample size. */
export const BREAKER_COMPLAINT_MIN_SENT = 1;
/** Sends a region needs in a window before its aggregate rate means anything. */
export const BREAKER_WINDOWS_HOURS = [24, 24 * 7] as const;

export interface RegionWindowCounts {
  sent: number;
  hardBounced: number;
  complained: number;
}

export interface RegionContributor {
  teamId: string;
  teamName: string;
  hardBounced: number;
  complained: number;
}

export interface RegionDecision {
  region: string;
  trip: boolean;
  reason?: RegionBreakerReason;
  contributors: RegionContributor[];
}

const HOUR_MS = 60 * 60 * 1000;
// Bounce class lives in the stored SES payload (process-ses-event writes the
// raw bounce object under data.bounce), so hard bounces are read back from it.
// The column is authoritative; the json path covers rows written before it
// existed (until retention strips their payload).
const hardBounceFilter = sql`${schema.emailEvents.type} = 'bounced' and coalesce(${schema.emailEvents.bounceType}, ${schema.emailEvents.data}->'bounce'->>'bounceType') = 'Permanent'`;
const complaintFilter = sql`${schema.emailEvents.type} = 'complained'`;

/**
 * Sends and SES-reported hard bounces/complaints per region over the trailing
 * window, from the rows themselves; `teamIds` narrows the scan to those teams.
 */
export async function regionWindowCounts(
  db: Db,
  opts: { now: Date; hours: number; teamIds?: string[]; since?: Date },
): Promise<Map<string, RegionWindowCounts>> {
  const since = opts.since ?? new Date(opts.now.getTime() - opts.hours * HOUR_MS);
  const teamFilter = opts.teamIds ? inArray(schema.emails.teamId, opts.teamIds) : undefined;
  const out = new Map<string, RegionWindowCounts>();
  const sent = await db
    .select({ region: schema.domains.region, n: sql<number>`count(*)::int` })
    .from(schema.emails)
    .innerJoin(schema.domains, eq(schema.domains.id, schema.emails.domainId))
    .where(and(gte(schema.emails.sentAt, since), teamFilter))
    .groupBy(schema.domains.region);
  for (const row of sent) out.set(row.region, { sent: row.n, hardBounced: 0, complained: 0 });
  const events = await db
    .select({
      region: schema.domains.region,
      hardBounced: sql<number>`count(*) filter (where ${hardBounceFilter})::int`,
      complained: sql<number>`count(*) filter (where ${complaintFilter})::int`,
    })
    .from(schema.emailEvents)
    .innerJoin(schema.emails, eq(schema.emails.id, schema.emailEvents.emailId))
    .innerJoin(schema.domains, eq(schema.domains.id, schema.emails.domainId))
    .where(
      and(
        gte(schema.emailEvents.createdAt, since),
        isNotNull(schema.emailEvents.snsMessageId),
        teamFilter,
      ),
    )
    .groupBy(schema.domains.region);
  for (const row of events) {
    const counts = out.get(row.region) ?? { sent: 0, hardBounced: 0, complained: 0 };
    out.set(row.region, { ...counts, hardBounced: row.hardBounced, complained: row.complained });
  }
  return out;
}

/**
 * The same totals over the trailing `days` UTC days (today included) from
 * usage_counters, which the send and SES-event paths bump alongside the
 * rows the raw scan reads: `sent` per accepted send, `hard_bounced` per
 * Permanent bounce, `complained` per complaint. Counters carry no domain,
 * so a team's traffic goes to the region of its most recently verified
 * domain. A team whose verified domains span more than one region cannot
 * be attributed that way: it is left out of the counters and its window is
 * read from the rows over the same span (bounded: only those teams' rows).
 */
export async function regionCounterTotals(
  db: Db,
  opts: { now: Date; days: number },
): Promise<Map<string, RegionWindowCounts>> {
  const since = utcDay(opts.now.getTime() - (opts.days - 1) * DAY_MS);
  const c = schema.usageCounters;
  const d = schema.domains;
  const multiRegion = (
    await db
      .select({ teamId: d.teamId })
      .from(d)
      .where(eq(d.status, "verified"))
      .groupBy(d.teamId)
      .having(sql`count(distinct ${d.region}) > 1`)
  ).map((r) => r.teamId);
  const teamRegion = db
    .selectDistinctOn([d.teamId], { teamId: d.teamId, region: d.region })
    .from(d)
    .orderBy(asc(d.teamId), sql`${d.verifiedAt} desc nulls last`, desc(d.createdAt))
    .as("team_region");
  // ::bigint — a region's weekly sum can overflow int4; the driver returns
  // bigint as a string, exact through Number() up to 2^53.
  const total = (col: AnyPgColumn) => sql<string>`coalesce(sum(${col}), 0)::bigint`;
  const rows = await db
    .select({
      region: teamRegion.region,
      sent: total(c.sent),
      hardBounced: total(c.hardBounced),
      complained: total(c.complained),
    })
    .from(c)
    .innerJoin(teamRegion, eq(teamRegion.teamId, c.teamId))
    .where(
      and(
        gte(c.day, since),
        multiRegion.length > 0 ? notInArray(c.teamId, multiRegion) : undefined,
      ),
    )
    .groupBy(teamRegion.region);
  const out = new Map<string, RegionWindowCounts>();
  for (const row of rows) {
    const counts = {
      sent: Number(row.sent),
      hardBounced: Number(row.hardBounced),
      complained: Number(row.complained),
    };
    if (counts.sent > 0 || counts.hardBounced > 0 || counts.complained > 0) {
      out.set(row.region, counts);
    }
  }
  if (multiRegion.length > 0) {
    const raw = await regionWindowCounts(db, {
      now: opts.now,
      hours: opts.days * 24,
      // Same span as the counters: whole UTC days, not a trailing window.
      since: new Date(`${since}T00:00:00Z`),
      teamIds: multiRegion,
    });
    for (const [region, counts] of raw) {
      const base = out.get(region) ?? { sent: 0, hardBounced: 0, complained: 0 };
      out.set(region, {
        sent: base.sent + counts.sent,
        hardBounced: base.hardBounced + counts.hardBounced,
        complained: base.complained + counts.complained,
      });
    }
  }
  return out;
}

/** Teams behind a region's events over the tripping window, worst first. */
async function contributors(
  db: Db,
  region: string,
  now: Date,
  hours: number,
): Promise<RegionContributor[]> {
  const since = new Date(now.getTime() - hours * HOUR_MS);
  const hardBounced = sql<number>`count(*) filter (where ${hardBounceFilter})::int`;
  const complained = sql<number>`count(*) filter (where ${complaintFilter})::int`;
  return db
    .select({
      teamId: schema.teams.id,
      teamName: schema.teams.name,
      hardBounced,
      complained,
    })
    .from(schema.emailEvents)
    .innerJoin(schema.emails, eq(schema.emails.id, schema.emailEvents.emailId))
    .innerJoin(schema.domains, eq(schema.domains.id, schema.emails.domainId))
    .innerJoin(schema.teams, eq(schema.teams.id, schema.emails.teamId))
    .where(
      and(
        eq(schema.domains.region, region),
        gte(schema.emailEvents.createdAt, since),
        isNotNull(schema.emailEvents.snsMessageId),
      ),
    )
    .groupBy(schema.teams.id, schema.teams.name)
    .orderBy(desc(sql`${hardBounced} + ${complained}`))
    .limit(5);
}

export function tripReason(counts: RegionWindowCounts, windowHours: number): RegionBreakerReason | null {
  const checks = [
    {
      metric: "bounce" as const,
      events: counts.hardBounced,
      limit: BREAKER_BOUNCE_RATE,
      min: MIN_PAUSE_HARD_BOUNCES,
      minSent: BREAKER_MIN_SENT,
    },
    {
      metric: "complaint" as const,
      events: counts.complained,
      limit: BREAKER_COMPLAINT_RATE,
      min: MIN_PAUSE_COMPLAINTS,
      minSent: BREAKER_COMPLAINT_MIN_SENT,
    },
  ];
  for (const c of checks) {
    if (counts.sent < c.minSent) continue;
    const rate = c.events / counts.sent;
    if (rate >= c.limit && c.events >= c.min) {
      return {
        metric: c.metric,
        rate,
        limit: c.limit,
        windowHours,
        sent: counts.sent,
        events: c.events,
      };
    }
  }
  return null;
}

/**
 * One decision per region with traffic: trip when either window is over a
 * breaker line with enough sends and events behind it;
 * clear only when both windows are under. Contributors are listed for
 * tripped regions so the operator knows who to talk to.
 */
export async function evaluateRegionBreakers(
  db: Db,
  opts: { now?: Date } = {},
): Promise<RegionDecision[]> {
  const now = opts.now ?? new Date();
  // The day window reads raw rows to the minute; the week window reads the
  // daily counters (seven UTC days including today, the guardrail's own
  // convention; reported as 168 hours) so a week of email_events is never
  // re-scanned per run, except for the few multi-region teams the counters
  // cannot place, whose rows are read over the trailing 168 hours.
  const [dayHours, weekHours] = BREAKER_WINDOWS_HOURS;
  const windows = [
    { hours: dayHours, counts: await regionWindowCounts(db, { now, hours: dayHours }) },
    { hours: weekHours, counts: await regionCounterTotals(db, { now, days: weekHours / 24 }) },
  ];
  // Paused regions stay in the set even with no traffic in either window:
  // a decision with nothing tripping is what lets them resume.
  const paused = await db
    .select({ region: schema.regionBreakers.region })
    .from(schema.regionBreakers)
    .where(eq(schema.regionBreakers.paused, true));
  const regions = new Set([
    ...windows.flatMap((w) => [...w.counts.keys()]),
    ...paused.map((r) => r.region),
  ]);
  const decisions: RegionDecision[] = [];
  for (const region of regions) {
    let reason: RegionBreakerReason | null = null;
    for (const w of windows) {
      const counts = w.counts.get(region);
      reason = counts ? tripReason(counts, w.hours) : null;
      if (reason) break;
    }
    decisions.push({
      region,
      trip: reason !== null,
      ...(reason ? { reason } : {}),
      contributors: reason ? await contributors(db, region, now, reason.windowHours) : [],
    });
  }
  return decisions;
}

/** Persist decisions; reports only the regions whose state actually flipped. */
export async function applyRegionBreakers(
  db: Db,
  decisions: RegionDecision[],
  now = new Date(),
): Promise<{ tripped: string[]; resumed: string[] }> {
  const current = new Map(
    (await db.select().from(schema.regionBreakers)).map((r) => [r.region, r]),
  );
  const tripped: string[] = [];
  const resumed: string[] = [];
  for (const d of decisions) {
    const row = current.get(d.region);
    // An operator's hold outlives the rates: only the operator releases it.
    if (row?.manualReason) continue;
    const paused = row?.paused ?? false;
    if (d.trip === paused) continue;
    await db
      .insert(schema.regionBreakers)
      .values({
        region: d.region,
        paused: d.trip,
        reason: d.reason ?? null,
        pausedAt: d.trip ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.regionBreakers.region,
        set: {
          paused: d.trip,
          reason: d.reason ?? null,
          pausedAt: d.trip ? now : null,
          updatedAt: now,
        },
      });
    (d.trip ? tripped : resumed).push(d.region);
  }
  return { tripped, resumed };
}

export interface PausedRegion {
  region: string;
  reason: RegionBreakerReason | null;
  /** Set when an operator holds the region by hand rather than the rates. */
  manualReason: string | null;
  pausedAt: Date | null;
}

const PAUSED_COLUMNS = {
  region: schema.regionBreakers.region,
  reason: schema.regionBreakers.reason,
  manualReason: schema.regionBreakers.manualReason,
  pausedAt: schema.regionBreakers.pausedAt,
};

export async function pausedRegions(db: Db): Promise<PausedRegion[]> {
  return db
    .select(PAUSED_COLUMNS)
    .from(schema.regionBreakers)
    .where(eq(schema.regionBreakers.paused, true));
}

/** The pause behind a region, or null when broadcasts flow there. */
export async function regionPause(db: Db, region: string): Promise<PausedRegion | null> {
  const [row] = await db
    .select(PAUSED_COLUMNS)
    .from(schema.regionBreakers)
    .where(and(eq(schema.regionBreakers.region, region), eq(schema.regionBreakers.paused, true)));
  return row ?? null;
}

/** Hold a region's broadcasts by hand; the breaker cron leaves it alone until released. */
export async function holdRegion(
  db: Db,
  region: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  const values = {
    paused: true,
    reason: null,
    manualReason: reason,
    pausedAt: now,
    updatedAt: now,
  };
  await db
    .insert(schema.regionBreakers)
    .values({ region, ...values })
    .onConflictDoUpdate({ target: schema.regionBreakers.region, set: values });
}

/** Release an operator's hold; the next breaker run judges the region on its rates again. */
export async function releaseRegion(db: Db, region: string, now = new Date()): Promise<void> {
  await db
    .update(schema.regionBreakers)
    .set({ paused: false, reason: null, manualReason: null, pausedAt: null, updatedAt: now })
    .where(eq(schema.regionBreakers.region, region));
}

/** The transactional path shares SES with broadcasts but is not under a region
 * hold. This is the account-level brake: the whole platform stops sending
 * before AWS decides for us, because losing SES costs every customer at once. */
export const SEND_GATE_MIN_SENT = 200;
/** One complaint at low volume is a misclick or a grudge, not a reputation
 * trend. Two of them, or the rate alone above the line at real volume, is a
 * trend. AWS warns at 0.1% and suspends well above it; this line sits under
 * both so the brake lands first. */
export const SEND_GATE_MIN_COMPLAINTS = 2;
export const SEND_GATE_MAX_COMPLAINT_RATE = 0.0008;
export const SEND_GATE_MAX_BOUNCE_RATE = 0.04;
/** A rate alone hides the case the owner worries about: many new accounts,
 * each below its own floor, adding bounces to one SES account. The absolute
 * daily count is the ceiling that catches that sum. */
export const SEND_GATE_MAX_HARD_BOUNCES_DAY = 25;

export type SendGateReason = "manual_halt" | "complaint_ceiling" | "bounce_ceiling";

export interface SendGateDecision {
  halt: boolean;
  reason: SendGateReason | null;
  sent: number;
  complained: number;
  hardBounced: number;
  complaintRate: number;
  bounceRate: number;
}

/** No sample, no verdict. The owner's own brake works at any volume. */
export function sendGateDecision(
  totals: { sent: number; hardBounced: number; complained: number },
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): SendGateDecision {
  const sent = Math.max(0, Math.trunc(totals.sent));
  const complained = Math.max(0, Math.trunc(totals.complained));
  const hardBounced = Math.max(0, Math.trunc(totals.hardBounced));
  const complaintRate = sent > 0 ? complained / sent : 0;
  const bounceRate = sent > 0 ? hardBounced / sent : 0;
  const base = { sent, complained, hardBounced, complaintRate, bounceRate };

  const manual = (env.PLATFORM_SENDING_HALT ?? "").trim().toLowerCase();
  if (manual === "1" || manual === "true" || manual === "on")
    return { ...base, halt: true, reason: "manual_halt" };
  if (sent < SEND_GATE_MIN_SENT) return { ...base, halt: false, reason: null };
  if (complained >= SEND_GATE_MIN_COMPLAINTS && complaintRate >= SEND_GATE_MAX_COMPLAINT_RATE)
    return { ...base, halt: true, reason: "complaint_ceiling" };
  if (hardBounced >= SEND_GATE_MAX_HARD_BOUNCES_DAY || bounceRate >= SEND_GATE_MAX_BOUNCE_RATE)
    return { ...base, halt: true, reason: "bounce_ceiling" };
  return { ...base, halt: false, reason: null };
}

const gateMemo = new WeakMap<Db, { at: number; decision: SendGateDecision }>();
const GATE_MEMO_MS = 60_000;

/** Account-wide totals over the trailing 24 hours, one memoized scan per minute
 * per process: the send path calls this, so it must never run per recipient. */
export async function platformSendGate(
  db: Db,
  opts: { now: Date; env?: Record<string, string | undefined> },
): Promise<SendGateDecision> {
  const fresh = opts.env ? undefined : gateMemo.get(db);
  if (fresh && opts.now.getTime() - fresh.at < GATE_MEMO_MS) return fresh.decision;
  const counts = await regionWindowCounts(db, { now: opts.now, hours: 24 });
  let sent = 0;
  let hardBounced = 0;
  let complained = 0;
  for (const c of counts.values()) {
    sent += c.sent;
    hardBounced += c.hardBounced;
    complained += c.complained;
  }
  const decision = sendGateDecision({ sent, hardBounced, complained }, opts.env);
  if (!opts.env) gateMemo.set(db, { at: opts.now.getTime(), decision });
  return decision;
}
