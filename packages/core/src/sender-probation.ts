import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gte, inArray } from "drizzle-orm";
import { campaignDomainDnsReady } from "./campaign-consent.js";
import type { TeamQuota } from "./plans.js";
import { productionVolumeStatus } from "./production-volume.js";

/** Ramp for a cloud sender, driven by the EXISTING dailySendCeiling and the
 * atomic quota ledger, never by a second counter.
 *
 * An unproven team (no review, unusable DNS or a bounce/complaint in the last
 * 30 days) stays at 25/day whatever its age or an operator ceiling asks for.
 * A proven team graduates on its own by account age: 100/day before a week,
 * 200/day before a month, 1000/day after. Until it is a month old the ladder
 * also caps an operator ceiling, so a young team cannot be lifted by typing a
 * big number. From a month of proven history an operator ceiling is used as
 * typed, which is how a paid contract carries the volume it pays for. */
export function probationCeiling(input: {
  reviewed: boolean;
  dnsReady: boolean;
  clean: boolean;
  ageDays: number;
  operatorCeiling: number | null;
}): number {
  const proven = input.reviewed && input.dnsReady && input.clean;
  const ladder = !proven ? 25 : input.ageDays < 7 ? 100 : input.ageDays < 30 ? 200 : 1000;
  const requested = input.operatorCeiling ?? ladder;
  const operatorMayRaise = proven && input.ageDays >= 30;
  return operatorMayRaise ? requested : Math.min(requested, ladder);
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
  const volume = await productionVolumeStatus(db, teamId, now);
  const ceiling = team.suspendedAt
    ? 0
    : (volume.ceiling ??
      probationCeiling({
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
      }));
  if (quota.kind === "day")
    return { ...quota, dailyCeiling: Math.min(quota.dailyCeiling ?? ceiling, ceiling) };
  if (quota.kind === "month")
    return { ...quota, dailyCeiling: Math.min(quota.dailyCeiling ?? ceiling, ceiling) };
  return { kind: "day", plan: "free", limit: ceiling, dailyCeiling: ceiling };
}
