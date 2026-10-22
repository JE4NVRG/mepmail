import { deploymentRevision, env, isCloudDeployment } from "@millionsend/config";
import {
  committedDailyVolume,
  DAY_MS,
  latestProbes,
  PROBE_KEYS,
  PROBES,
  probeHistory,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { periodSchema, previousPeriod, resolvePeriod } from "../../console/periods";
import { servedRegionAccounts } from "../../console/ses-regions";
import { operatorProcedure, router } from "../../trpc";
import { instanceCounterSeries, sumPoints } from "./series";

export const consoleOverviewRouter = router({
  /** Everything above the charts: the stat tiles, the region count and the health rows. */
  summary: operatorProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const t = schema.teams;
    const d = schema.domains;
    const [teams, domains, probes, regions] = await Promise.all([
      ctx.db
        .select({
          total: sql<number>`count(*)::int`,
          free: sql<number>`count(*) filter (where ${t.plan}::text = 'free')::int`,
          // Compared as text so a plan value the enum does not carry yet reads as its name.
          paid: sql<number>`count(*) filter (where ${t.plan}::text not in ('free', 'system'))::int`,
          system: sql<number>`count(*) filter (where ${t.plan}::text = 'system')::int`,
          newThisWeek: sql<number>`count(*) filter (where ${t.createdAt} >= ${new Date(now.getTime() - 7 * DAY_MS)})::int`,
          suspended: sql<number>`count(*) filter (where ${t.suspendedAt} is not null)::int`,
        })
        .from(t)
        .then((rows) => rows[0]),
      ctx.db
        .select({
          verified: sql<number>`count(*) filter (where ${d.status} = 'verified')::int`,
          pending: sql<number>`count(*) filter (where ${d.status} in ('pending', 'temporary_failure'))::int`,
          failed: sql<number>`count(*) filter (where ${d.status} = 'failed')::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(d)
        .then((rows) => rows[0]),
      latestProbes(ctx.db),
      servedRegionAccounts(),
    ]);
    const probe = (key: (typeof PROBE_KEYS)[number]) => probes.get(key) ?? null;
    return {
      version: deploymentRevision(),
      host: env.APP_BASE_URL ? new URL(env.APP_BASE_URL).host : null,
      cloud: isCloudDeployment(),
      regions: {
        serving: regions.filter((r) => r.ok && r.overview.productionAccess).length,
        sandbox: regions.filter((r) => r.ok && !r.overview.productionAccess).length,
        unreachable: regions.filter((r) => !r.ok).length,
      },
      teams: teams ?? { total: 0, free: 0, paid: 0, system: 0, newThisWeek: 0, suspended: 0 },
      contacts: {
        total: probe("contacts_total")?.value ?? null,
        unsubscribed: probe("contacts_unsubscribed")?.value ?? null,
      },
      domains: domains ?? { verified: 0, pending: 0, failed: 0, total: 0 },
      queue: {
        waiting: probe("queue_waiting")?.value ?? null,
        quotaHeld: probe("queue_quota_held")?.value ?? null,
        oldestSeconds: probe("queue_oldest_s")?.value ?? null,
      },
      probes: PROBE_KEYS.map((key) => {
        const sample = probes.get(key);
        return {
          key,
          severity: PROBES[key],
          value: sample?.value ?? null,
          ok: sample?.ok ?? null,
          takenAt: sample?.takenAt ?? null,
        };
      }),
      workerHeartbeatAt: probe("worker_heartbeat")?.takenAt ?? null,
    };
  }),

  /**
   * "Needs you": what an operator should act on now, on teams that still send.
   * Suspended teams are excluded everywhere here: their open flags and broken
   * domains are already decided and only bury the live ones.
   */
  attention: operatorProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const t = schema.teams;
    const live = sql`${t.suspendedAt} is null`;
    const [counts] = await ctx.db
      .select({
        active: sql<number>`count(*) filter (where ${live})::int`,
        suspended: sql<number>`count(*) filter (where ${t.suspendedAt} is not null)::int`,
        newActive7d: sql<number>`count(*) filter (where ${live} and ${t.createdAt} >= ${new Date(now.getTime() - 7 * DAY_MS)})::int`,
        newSuspended7d: sql<number>`count(*) filter (where ${t.suspendedAt} is not null and ${t.createdAt} >= ${new Date(now.getTime() - 7 * DAY_MS)})::int`,
        held: sql<number>`count(*) filter (where ${live} and ${t.sendReviewAt} is not null)::int`,
        flags: sql<number>`count(*) filter (where ${live} and exists (select 1 from ${schema.teamFlags} f where f.team_id = ${t}."id" and f.status = 'open'))::int`,
        requests: sql<number>`count(*) filter (where ${live} and exists (select 1 from ${schema.signupRiskReviewRequests} r where r.team_id = ${t}."id" and r.resolved_at is null))::int`,
        sandboxed: sql<number>`count(*) filter (where ${live} and exists (select 1 from ${schema.teamSignupRisk} s where s.team_id = ${t}."id" and s.cleared_at is null and s.level in ('sandbox', 'hold')))::int`,
        guardrailPaused: sql<number>`count(*) filter (where ${live} and exists (select 1 from ${schema.teamStandings} g where g.team_id = ${t}."id" and g.guardrail = 'paused'))::int`,
        guardrailWarning: sql<number>`count(*) filter (where ${live} and exists (select 1 from ${schema.teamStandings} g where g.team_id = ${t}."id" and g.guardrail = 'warning'))::int`,
      })
      .from(t);
    const d = schema.domains;
    const failedDomains = await ctx.db
      .select({ id: d.id, name: d.name, teamId: t.id, team: t.name })
      .from(d)
      .innerJoin(t, eq(t.id, d.teamId))
      .where(and(eq(d.status, "failed"), isNull(t.suspendedAt)))
      .orderBy(desc(d.createdAt))
      .limit(6);
    const [failedTotal] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(d)
      .innerJoin(t, eq(t.id, d.teamId))
      .where(and(eq(d.status, "failed"), isNull(t.suspendedAt)));
    return {
      teams: {
        active: counts?.active ?? 0,
        suspended: counts?.suspended ?? 0,
        newActive7d: counts?.newActive7d ?? 0,
        newSuspended7d: counts?.newSuspended7d ?? 0,
      },
      held: counts?.held ?? 0,
      flags: counts?.flags ?? 0,
      requests: counts?.requests ?? 0,
      sandboxed: counts?.sandboxed ?? 0,
      guardrailPaused: counts?.guardrailPaused ?? 0,
      guardrailWarning: counts?.guardrailWarning ?? 0,
      failedDomains: { total: failedTotal?.n ?? 0, items: failedDomains },
    };
  }),

  /** The four KPI cards' series over a period, with the previous window's totals beside them. */
  kpis: operatorProcedure
    .input(z.object({ period: periodSchema }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const period = resolvePeriod(input.period, now);
      const [points, before] = await Promise.all([
        instanceCounterSeries(ctx.db, period),
        instanceCounterSeries(ctx.db, previousPeriod(period)),
      ]);
      return {
        grain: period.grain,
        points,
        totals: sumPoints(points),
        previous: sumPoints(before),
      };
    }),

  /** Sent per day (or per hour over a day) with the sold volume and each region's SES quota as reference lines. */
  sentPerDay: operatorProcedure
    .input(z.object({ period: periodSchema }))
    .query(async ({ ctx, input }) => {
      const period = resolvePeriod(input.period);
      const [points, regions, committed] = await Promise.all([
        instanceCounterSeries(ctx.db, period),
        servedRegionAccounts(),
        isCloudDeployment() ? committedDailyVolume(ctx.db) : Promise.resolve(null),
      ]);
      return {
        grain: period.grain,
        points: points.map((p) => ({ t: p.t, sent: p.sent })),
        committedPerDay: committed,
        quotas: regions.flatMap((r) =>
          r.ok ? [{ region: r.region, max24h: r.overview.quota.max24h }] : [],
        ),
      };
    }),

  /** One probe's history for the dialog a stat tile or health row opens. */
  history: operatorProcedure
    .input(z.object({ probe: z.enum(PROBE_KEYS), period: periodSchema }))
    .query(async ({ ctx, input }) => {
      const period = resolvePeriod(input.period);
      const points = await probeHistory(ctx.db, {
        probe: input.probe,
        from: period.from,
        to: period.to,
        bucketSeconds: period.bucketSeconds,
      });
      return { bucketSeconds: period.bucketSeconds, points };
    }),

  /** Teams created per day, for the Teams tile's history. */
  teamsHistory: operatorProcedure
    .input(z.object({ period: periodSchema }))
    .query(async ({ ctx, input }) => {
      const period = resolvePeriod(input.period);
      const t = schema.teams;
      const [before] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(sql`${t.createdAt} < ${period.from}`);
      const rows = await ctx.db
        .select({
          day: sql<string>`(${t.createdAt} at time zone 'UTC')::date::text`,
          n: sql<number>`count(*)::int`,
        })
        .from(t)
        .where(gte(t.createdAt, period.from))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      return { before: before?.n ?? 0, rows };
    }),
});
