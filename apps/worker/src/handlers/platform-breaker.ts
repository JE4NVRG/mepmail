import {
  applyRegionBreakers,
  evaluateRegionBreakers,
  fetchTeamStanding,
  findInstanceOperator,
  holdTeamForReview,
  pauseTenantBroadcastsForRegionTrip,
  planTenantFirstRegionBreakers,
  type RegionDecision,
  type TenantRegionPause,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  notifyRegionBreaker,
  regionDeferredText,
  regionHoldText,
  tenantPauseText,
} from "../../../../packages/core/src/region-breaker-notice.js";
import {
  type MailContent,
  regionPausedMail,
  regionResumedMail,
} from "../notifications/templates.js";
import type { SystemMailer } from "../system-mail.js";

export interface PlatformBreakerDeps {
  mailer: SystemMailer;
  appBaseUrl?: string | undefined;
  now?: Date;
}

/** Has this team already tripped a reputation line in the last 24 hours? */
async function repeatedWithinDay(db: Db, teamId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.teamFlags.id })
    .from(schema.teamFlags)
    .where(
      and(
        eq(schema.teamFlags.teamId, teamId),
        inArray(schema.teamFlags.reason, ["complaints", "guardrail", "review"]),
        gte(schema.teamFlags.openedAt, new Date(now.getTime() - 24 * 3_600_000)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export type TenantPauseKind = "broadcast_only" | "broadcast_only_urgent" | "full_review" | "none";

/**
 * A1 + A155: who loses what when a region trips.
 *
 * - first party: broadcasts paused, transactional untouched. A second complaint
 *   inside 24h keeps the same scope and only escalates the alert to urgent:
 *   password resets never stop because of a first-party recurrence.
 * - third party: full review hold, every surface stopped.
 */
async function pauseTenantForTrip(
  db: Db,
  pause: TenantRegionPause,
  now: Date,
): Promise<TenantPauseKind> {
  const repeated = await repeatedWithinDay(db, pause.teamId, now);
  try {
    if (pause.firstParty) {
      const paused = await pauseTenantBroadcastsForRegionTrip(db, {
        teamId: pause.teamId,
        region: pause.region,
        metric: pause.metric,
        events: pause.events,
        sent: pause.sent,
        windowHours: pause.windowHours,
        now,
      });
      if (!paused) return "none";
      return repeated ? "broadcast_only_urgent" : "broadcast_only";
    }
    const held = await holdTeamForReview(db, {
      teamId: pause.teamId,
      reason: "reputation",
      note: `Regiao ${pause.region} acima da linha por ${pause.metric === "complaint" ? "reclamacao" : "bounce duro"} (${pause.events}/${pause.sent} envios em ${pause.windowHours}h). Time de terceiro.`,
      now,
    });
    return held ? "full_review" : "none";
  } catch (err) {
    console.error(`platform.breaker: tenant pause for ${pause.teamId} failed`, err);
    return "none";
  }
}

/**
 * Evaluate the per-region breakers, pause the teams behind the events first, and
 * hold the region only when the traffic that would remain is still over the
 * line. Every tenant pause and every flip reaches the operator on Telegram.
 */
export async function runPlatformBreaker(
  db: Db,
  deps: PlatformBreakerDeps,
): Promise<{ tripped: string[]; resumed: string[]; tenantsPaused: string[] }> {
  const now = deps.now ?? new Date();
  const decisions = await evaluateRegionBreakers(db, { now });
  const plan = await planTenantFirstRegionBreakers(db, decisions, { now });

  const failed = new Set<string>();
  const tenantsPaused: { pause: TenantRegionPause; kind: Exclude<TenantPauseKind, "none"> }[] = [];
  for (const pause of plan.tenantPauses) {
    const kind = await pauseTenantForTrip(db, pause, now);
    if (kind === "none") failed.add(pause.teamId);
    else tenantsPaused.push({ pause, kind });
  }

  // "Nothing changed" is not "not paused": a team already paused by the previous
  // run is just as stopped as one this run paused. Only a team that ends the run
  // with broadcasts flowing keeps its region paused.
  for (const pause of plan.tenantPauses) {
    if (!failed.has(pause.teamId)) continue;
    const standing = await fetchTeamStanding(db, pause.teamId);
    if (standing?.broadcastsPausedByOperatorAt) failed.delete(pause.teamId);
  }

  // A region only loses its hold when the tenant pause it relied on actually
  // landed; otherwise the original decision stands and the region stays held.
  const toApply: RegionDecision[] = plan.decisions.map((d) => {
    if (d.trip || !plan.regionHoldsDeferred.includes(d.region)) return d;
    const unlanded = plan.tenantPauses.some((p) => p.region === d.region && failed.has(p.teamId));
    if (!unlanded) return d;
    return decisions.find((o) => o.region === d.region) ?? d;
  });

  const changed = await applyRegionBreakers(db, toApply, now);
  for (const { pause, kind } of tenantsPaused) {
    console.warn(
      `platform.breaker: tenant ${pause.teamId} ${kind} — ${pause.metric} ${pause.events}/${pause.sent} in ${pause.region} over ${pause.windowHours}h`,
    );
    notifyRegionBreaker(tenantPauseText({ ...pause, kind }));
  }
  for (const region of plan.regionHoldsDeferred) {
    if (changed.tripped.includes(region)) continue;
    const teams = tenantsPaused.filter((t) => t.pause.region === region).length;
    notifyRegionBreaker(regionDeferredText({ region, teams }));
  }

  const operator = await findInstanceOperator(db);
  const url = deps.appBaseUrl ?? "";
  // The flip is already persisted (the banner shows it); a failing mail is
  // logged, never allowed to abort the handler or the other regions' mails.
  const mail = async (
    region: string,
    kind: "region.paused" | "region.resumed",
    content: MailContent,
  ) => {
    if (!operator) return;
    try {
      await deps.mailer.send(operator.email, { ...content, kind });
    } catch (err) {
      console.error(`platform.breaker: operator mail for ${region} failed`, err);
    }
  };
  const byRegion = new Map(toApply.map((d) => [d.region, d]));
  for (const region of changed.tripped) {
    const d = byRegion.get(region) as RegionDecision & {
      reason: NonNullable<RegionDecision["reason"]>;
    };
    const top = d.contributors
      .map((c) => `${c.teamName} (${c.hardBounced} hard bounces, ${c.complained} complaints)`)
      .join(", ");
    console.warn(
      `platform.breaker: broadcasts paused in ${region} — ${d.reason.metric} rate ${(d.reason.rate * 100).toFixed(2)}% over ${d.reason.windowHours}h (${d.reason.events}/${d.reason.sent}); top contributors: ${top || "none"}`,
    );
    notifyRegionBreaker(regionHoldText({ region, ...d.reason }));
    await mail(
      region,
      "region.paused",
      regionPausedMail({
        region,
        ...d.reason,
        contributors: d.contributors.map((c) => ({
          team: c.teamName,
          hardBounced: c.hardBounced,
          complained: c.complained,
        })),
        url,
      }),
    );
  }
  for (const region of changed.resumed) {
    console.log(`platform.breaker: broadcasts resumed in ${region}`);
    await mail(region, "region.resumed", regionResumedMail({ region, url }));
  }
  return { ...changed, tenantsPaused: tenantsPaused.map((t) => t.pause.teamId) };
}
