import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gte, inArray } from "drizzle-orm";
import { campaignDomainDnsReady } from "./campaign-consent.js";
import type { TeamQuota } from "./plans.js";

/** Operator-controlled ramp using the EXISTING dailySendCeiling and atomic
 * quota ledger, never a second counter. Passing time does not raise a limit:
 * each step needs an operator-set ceiling and a clean retained history. */
export function probationCeiling(input: {
  reviewed: boolean;
  dnsReady: boolean;
  clean: boolean;
  ageDays: number;
  operatorCeiling: number | null;
}): number {
  const permitted =
    !input.reviewed || !input.dnsReady || !input.clean
      ? 25
      : input.ageDays < 7
        ? 100
        : input.ageDays < 30
          ? 200
          : (input.operatorCeiling ?? 25);
  return Math.min(input.operatorCeiling ?? 25, permitted);
}

/** Apply before reserveQuota at acceptance AND worker/drain reservations.
 * Never replaces suspension, signup-principal or consent/content gates.
 * All accounting remains in reserveQuota's existing transaction/UTC day. */
export async function applySenderProbationQuota(
  db: Db,
  teamId: string,
  quota: TeamQuota,
  isCloud: boolean,
  now = new Date(),
): Promise<TeamQuota> {
  if (!isCloud) return quota;
  const [team] = await db
    .select({
      plan: schema.teams.plan,
      createdAt: schema.teams.createdAt,
      reviewedAt: schema.teams.sendReviewClearedAt,
      heldAt: schema.teams.sendReviewAt,
      ceiling: schema.teams.dailySendCeiling,
      suspendedAt: schema.teams.suspendedAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  if (!team) throw new Error("sender_probation_team_missing");
  if (team.plan === "system") return quota;
  const domains = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId));
  const incidents = await db
    .select({ id: schema.emails.id })
    .from(schema.emails)
    .where(
      and(
        eq(schema.emails.teamId, teamId),
        gte(schema.emails.createdAt, new Date(now.getTime() - 30 * 86400000)),
        inArray(schema.emails.latestStatus, ["bounced", "complained"]),
      ),
    )
    .limit(1);
  const ceiling = team.suspendedAt
    ? 0
    : probationCeiling({
        reviewed: Boolean(team.reviewedAt && (!team.heldAt || team.reviewedAt >= team.heldAt)),
        // A persisted actual verification pass, not a paid/domain-status flag.
        // Ramp eligibility expires after 24h; send paths never resolve DNS.
        dnsReady: domains.some(
          (domain) =>
            campaignDomainDnsReady(domain) &&
            !!domain.lastCheckedAt &&
            !!domain.dmarcCheckedAt &&
            [domain.lastCheckedAt, domain.dmarcCheckedAt].every(
              (at) => at.getTime() <= now.getTime() && now.getTime() - at.getTime() <= 86400000,
            ),
        ),
        clean:
          incidents.length === 0 &&
          (
            await db
              .select({ id: schema.emailEvents.id })
              .from(schema.emailEvents)
              .innerJoin(schema.emails, eq(schema.emails.id, schema.emailEvents.emailId))
              .where(
                and(
                  eq(schema.emails.teamId, teamId),
                  gte(schema.emailEvents.occurredAt, new Date(now.getTime() - 30 * 86400000)),
                  inArray(schema.emailEvents.type, ["bounced", "complained"]),
                ),
              )
              .limit(1)
          ).length === 0,
        ageDays: Math.max(0, (now.getTime() - team.createdAt.getTime()) / 86400000),
        operatorCeiling: team.ceiling,
      });
  if (quota.kind === "day")
    return { ...quota, dailyCeiling: Math.min(quota.dailyCeiling ?? ceiling, ceiling) };
  if (quota.kind === "month")
    return { ...quota, dailyCeiling: Math.min(quota.dailyCeiling ?? ceiling, ceiling) };
  return { kind: "day", plan: "free", limit: ceiling, dailyCeiling: ceiling };
}
