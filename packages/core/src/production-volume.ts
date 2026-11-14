import { createHash } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { campaignDomainDnsReady } from "./campaign-consent.js";
import { fetchDeliverabilityHealth } from "./deliverability.js";
import { firstRow } from "./driver-result.js";
import { isInstanceOperator } from "./instance-operator.js";

export const VOLUME_ACTIONS = [
  "team.production_volume_approved",
  "team.production_volume_revoked",
] as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const target = (id: string) => `production-volume:${id}`;

async function latest(db: Db, teamId: string) {
  const [row] = await db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.target, target(teamId)),
        inArray(schema.auditLog.action, [...VOLUME_ACTIONS]),
      ),
    )
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    .limit(1);
  return row;
}

/** Append-only operator-private proof: no schema default, backfill, payment or legacy grant. */
export async function observeProductionVolume(db: Db, teamId: string, now = new Date()) {
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  if (!team) throw new Error("volume_team_missing");
  const [principal] = await db
    .select({
      id: schema.teamSignupRisk.principalUserId,
      level: schema.teamSignupRisk.level,
      cleared: schema.teamSignupRisk.clearedAt,
      verified: schema.user.emailVerified,
    })
    .from(schema.teamSignupRisk)
    .leftJoin(schema.user, eq(schema.user.id, schema.teamSignupRisk.principalUserId))
    .where(eq(schema.teamSignupRisk.teamId, teamId));
  const flags = await db
    .select({
      id: schema.teamFlags.id,
      status: schema.teamFlags.status,
      cleared: schema.teamFlags.clearedAt,
    })
    .from(schema.teamFlags)
    .where(eq(schema.teamFlags.teamId, teamId))
    .orderBy(schema.teamFlags.id);
  const [monitor] = await db
    .select({
      paused: schema.teamMonitor.broadcastsPausedAt,
      resumed: schema.teamMonitor.broadcastsResumedAt,
    })
    .from(schema.teamMonitor)
    .where(eq(schema.teamMonitor.teamId, teamId));
  const domains = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId));
  const dnsReady = domains.some(
    (d) =>
      campaignDomainDnsReady(d) &&
      !!d.lastCheckedAt &&
      !!d.dmarcCheckedAt &&
      [d.lastCheckedAt, d.dmarcCheckedAt].every(
        (at) => at <= now && now.getTime() - at.getTime() <= 86400000,
      ),
  );
  const health = await fetchDeliverabilityHealth(db, teamId, { now });
  const evidence = firstRow<{ count: string; digest: string }>(
    await db.execute(sql`
    select count(*)::text as count, md5(coalesce(string_agg(v.id::text, ',' order by v.id), '')) as digest
    from ${schema.emailEvents} v inner join ${schema.emails} e on e.id = v.email_id
    where e.team_id = ${teamId} and v.type in ('bounced','complained')
  `),
  );
  const unknown = firstRow<{ digest: string }>(
    await db.execute(sql`
    select md5(coalesce(string_agg(e.id::text || e.latest_status::text, ',' order by e.id), '')) as digest
    from ${schema.emails} e where e.team_id = ${teamId} and e.latest_status in ('bounced','complained')
      and not exists (select 1 from ${schema.emailEvents} v where v.email_id = e.id and v.type in ('bounced','complained'))
  `),
  );
  const state = hash({
    principal,
    held: team.sendReviewAt,
    cleared: team.sendReviewClearedAt,
    suspended: team.suspendedAt,
    pause: team.broadcastsPausedByOperatorAt,
    flags,
    monitor,
  });
  const record = await latest(db, teamId);
  const epoch = hash({
    state,
    ceiling: team.dailySendCeiling,
    evidence,
    unknown,
    record: record?.id ?? null,
  });
  const safe =
    !!principal?.id &&
    principal.verified === true &&
    (principal.level === "good" || !!principal.cleared) &&
    !team.suspendedAt &&
    !(
      team.sendReviewAt &&
      (!team.sendReviewClearedAt || team.sendReviewAt > team.sendReviewClearedAt)
    ) &&
    !team.broadcastsPausedByOperatorAt &&
    !monitor?.paused &&
    !flags.some((f) => f.status === "open") &&
    dnsReady &&
    health.status !== "paused";
  return { epoch, state, team, principal, dnsReady, health, evidence, unknown, record, safe };
}

export async function approveProductionVolume(
  db: Db,
  input: {
    teamId: string;
    operatorId: string;
    expectedEpoch: string;
    dailyCeiling: number;
    reason: string;
    evidenceReference: string;
  },
) {
  if (
    !Number.isSafeInteger(input.dailyCeiling) ||
    input.dailyCeiling < 1 ||
    input.dailyCeiling > 100000000
  )
    throw new Error("volume_finite_ceiling_required");
  if (
    input.reason.trim().length < 15 ||
    input.reason.length > 500 ||
    input.evidenceReference.trim().length < 5 ||
    input.evidenceReference.length > 200
  )
    throw new Error("volume_review_evidence_required");
  return db.transaction(async (tx) => {
    const d = tx as unknown as Db;
    await d
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("update");
    if (!(await isInstanceOperator(d, input.operatorId)))
      throw new Error("volume_operator_required");
    const observed = await observeProductionVolume(d, input.teamId);
    if (!observed.principal?.id || !observed.principal.verified)
      throw new Error("volume_verified_principal_required");
    if (observed.principal.id === input.operatorId)
      throw new Error("volume_independent_operator_required");
    if (observed.epoch !== input.expectedEpoch) throw new Error("volume_stale_epoch");
    if (
      !observed.safe ||
      !observed.team.dailySendCeiling ||
      input.dailyCeiling > observed.team.dailySendCeiling
    )
      throw new Error("volume_current_safety_or_cap_required");
    // Both ingestion and approval hold the team row. Capture reviewed equal-ms
    // identities before writing the grant: a timestamp alone is not a witness.
    const clock = firstRow<{ at: string }>(
      await d.execute(sql`
      select date_trunc('milliseconds', clock_timestamp())::text as at
    `),
    );
    if (!clock) throw new Error("volume_arrival_boundary_missing");
    const boundaryAt = new Date(clock.at);
    const reviewedBoundary = await d
      .select({ id: schema.emailEvents.id })
      .from(schema.emailEvents)
      .innerJoin(schema.emails, eq(schema.emails.id, schema.emailEvents.emailId))
      .where(
        and(
          eq(schema.emails.teamId, input.teamId),
          gte(schema.emailEvents.createdAt, boundaryAt),
          inArray(schema.emailEvents.type, ["bounced", "complained"]),
        ),
      );
    const [proof] = await d
      .insert(schema.auditLog)
      .values({
        teamId: null,
        actorId: `user:${input.operatorId}`,
        target: target(input.teamId),
        action: "team.production_volume_approved",
        createdAt: sql`clock_timestamp()`,
        data: {
          version: 2,
          arrivalBoundary: { at: boundaryAt.toISOString(), ids: reviewedBoundary.map((v) => v.id) },
          teamId: input.teamId,
          principalId: observed.principal.id,
          ceiling: input.dailyCeiling,
          cap: observed.team.dailySendCeiling,
          state: observed.state,
          evidence: observed.evidence,
          unknown: observed.unknown,
          epoch: observed.epoch,
          reason: input.reason.trim(),
          evidenceReference: input.evidenceReference.trim(),
        },
      })
      .returning({ id: schema.auditLog.id });
    return { id: proof?.id };
  });
}

/** Must run under the same team-row lock as the state mutation. Never a release. */
export async function revokeProductionVolume(db: Db, teamId: string, reason: string) {
  const proof = await latest(db, teamId);
  if (proof?.action !== "team.production_volume_approved") return;
  await db.insert(schema.auditLog).values({
    teamId: null,
    actorId: "system",
    target: target(teamId),
    action: "team.production_volume_revoked",
    data: { reason, approvalId: proof.id },
    createdAt: sql`clock_timestamp()`,
  });
}

export async function productionVolumeStatus(db: Db, teamId: string, now = new Date()) {
  const p = await latest(db, teamId);
  if (!p || p.action !== "team.production_volume_approved")
    return { ceiling: null, reason: "not_approved" } as const;
  const o = await observeProductionVolume(db, teamId, now);
  const g = p.data;
  if (
    o.record?.id !== p.id ||
    !g ||
    (g.version !== 1 && g.version !== 2) ||
    g.teamId !== teamId ||
    g.principalId !== o.principal?.id ||
    g.state !== o.state ||
    typeof g.ceiling !== "number" ||
    !Number.isSafeInteger(g.ceiling) ||
    g.ceiling < 1 ||
    typeof g.cap !== "number" ||
    !o.team.dailySendCeiling ||
    o.team.dailySendCeiling > g.cap ||
    !p.actorId?.startsWith("user:") ||
    p.actorId === `user:${o.principal?.id}` ||
    p.createdAt > now ||
    !o.safe
  )
    return { ceiling: null, reason: "safety_or_state_changed" } as const;
  // Version 1 keeps its conservative behavior; never infer a missing witness.
  const boundary = g.arrivalBoundary as { at?: unknown; ids?: unknown } | undefined;
  if (
    g.version === 2 &&
    (!boundary ||
      typeof boundary.at !== "string" ||
      !Number.isFinite(new Date(boundary.at).getTime()) ||
      new Date(boundary.at) > p.createdAt ||
      !Array.isArray(boundary.ids) ||
      !boundary.ids.every((id) => typeof id === "string"))
  )
    return { ceiling: null, reason: "new_adverse_evidence" } as const;
  const reviewedIds = new Set<string>(g.version === 2 ? (boundary!.ids as string[]) : []);
  // Arrival time, never an occurrence-only cutoff. Unknown/backdated writes fail closed.
  const arrivals = await db
    .select({
      id: schema.emailEvents.id,
      type: schema.emailEvents.type,
      bounce: schema.emailEvents.bounceType,
      at: schema.emailEvents.occurredAt,
      arrived: schema.emailEvents.createdAt,
    })
    .from(schema.emailEvents)
    .innerJoin(schema.emails, eq(schema.emails.id, schema.emailEvents.emailId))
    .where(
      and(
        eq(schema.emails.teamId, teamId),
        g.version === 2
          ? gte(schema.emailEvents.createdAt, new Date(boundary!.at as string))
          : gt(schema.emailEvents.createdAt, p.createdAt),
        inArray(schema.emailEvents.type, ["bounced", "complained"]),
      ),
    );
  const fresh = arrivals.filter((v) => !reviewedIds.has(v.id));
  const reviewedCount = (g.evidence as { count?: string } | undefined)?.count;
  const changed = hash(g.evidence) !== hash(o.evidence);
  if (
    hash(g.unknown) !== hash(o.unknown) ||
    (changed &&
      (Number(o.evidence?.count) - Number(reviewedCount) !== fresh.length ||
        fresh.some(
          (v) =>
            v.type === "complained" ||
            !["Permanent", "Transient"].includes(v.bounce ?? "") ||
            v.at > v.arrived ||
            v.arrived.getTime() - v.at.getTime() > 86400000,
        )))
  )
    return { ceiling: null, reason: "new_adverse_evidence" } as const;
  return { ceiling: Math.min(g.ceiling, o.team.dailySendCeiling), reason: "approved" } as const;
}

/** Producer-side revocation is durable even after a material incident ages out.
 * Must share the provider ingestion transaction and team-row lock. */
export async function revalidateProductionVolumeOutcome(
  db: Db,
  input: {
    teamId: string;
    type: string;
    occurredAt: string;
    bounceType?: string | undefined;
  },
) {
  if ((await latest(db, input.teamId))?.action !== "team.production_volume_approved") return;
  const now = new Date(),
    at = new Date(input.occurredAt);
  const health = await fetchDeliverabilityHealth(db, input.teamId, { now });
  if (
    input.type === "complained" ||
    !Number.isFinite(at.getTime()) ||
    at > now ||
    now.getTime() - at.getTime() > 86400000 ||
    !["Permanent", "Transient"].includes(input.bounceType ?? "") ||
    health.status === "paused"
  )
    await revokeProductionVolume(db, input.teamId, "provider_adverse_evidence");
}
