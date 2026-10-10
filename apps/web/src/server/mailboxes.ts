/** Optional registry; production hosting/transport is a separate capability. */
import { isCloudDeployment } from "@millionsend/config";
import { mailboxDomainLock, mailboxServiceEntitlement } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { hasPaidSendingPlanForMailbox } from "../../../../packages/billing/src/mailbox-addon";
import {
  mailboxLaunchCohortAllows,
  mailboxLaunchCohortOpen,
  parseMailboxLaunchCohort,
} from "../../../../packages/core/src/mailbox-launch-cohort";

export function mailboxEarlyAccessCohort() {
  const raw = process.env.MAILBOX_EARLY_ACCESS_COHORT;
  return raw === undefined ? undefined : parseMailboxLaunchCohort(raw);
}

/** Public Correio offer on the hosted service: presentation only, never an access grant. */
export function mailboxOfferOpen(): boolean {
  return (
    isCloudDeployment() &&
    mailboxRegistryEnabled() &&
    process.env.MAILBOX_EARLY_ACCESS_OPEN === "true"
  );
}

/**
 * Correio sold without Envio (MAILBOX_STANDALONE_OPEN=true): every team may
 * open the Correio area and buy the standalone offer. Purchases stay
 * server-gated; this only lifts the Envio and existing-Customer prerequisites.
 */
export function mailboxStandaloneOpen(): boolean {
  return (
    isCloudDeployment() &&
    mailboxRegistryEnabled() &&
    process.env.MAILBOX_STANDALONE_OPEN === "true"
  );
}

/** The standalone offer's price ids, from the operator catalog (validated again at checkout). */
export function standaloneMailboxPriceIds(): readonly string[] {
  try {
    const raw = JSON.parse(process.env.MAILBOX_BILLING_CATALOG ?? "null") as {
      standalonePriceIds?: unknown;
    } | null;
    const ids = raw?.standalonePriceIds;
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string" && /^price_[A-Za-z0-9_]+$/.test(id))
      : [];
  } catch {
    return [];
  }
}

export function mailboxRegistryEnabled(): boolean {
  return (
    process.env.MAILBOX_REGISTRY_ENABLED === "true" || process.env.MAILBOX_REGISTRY_ENABLED === "1"
  );
}

/** A private pilot requires both an allowed team and its allowed human owner.
 * Leaving both unset preserves the normal hosted/self-hosted capability.
 * Partial or malformed configuration must never open the pilot to everyone.
 */
export function mailboxAccessEnabled(actor: { teamId: string; userId: string }): boolean {
  if (!mailboxRegistryEnabled()) return false;
  const teams = process.env.MAILBOX_PILOT_TEAM_IDS;
  const users = process.env.MAILBOX_PILOT_USER_IDS;
  if (teams === undefined && users === undefined) return true;
  if (!teams || !users) return false;
  const teamIds = teams.split(",").map((id) => id.trim());
  const userIds = users.split(",").map((id) => id.trim());
  if (
    !teamIds.every((id) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),
    ) ||
    !userIds.every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    return false;
  return teamIds.includes(actor.teamId) && userIds.includes(actor.userId);
}

async function accessMember(db: Db, actor: { teamId: string; userId: string }) {
  const [member] = await db
    .select({
      id: schema.teams.id,
      plan: schema.teams.plan,
      planStatus: schema.teams.planStatus,
      suspendedAt: schema.teams.suspendedAt,
      stripeCustomerId: schema.teams.stripeCustomerId,
      stripeSubscriptionId: schema.teams.stripeSubscriptionId,
      sendBillingContract: schema.teams.sendBillingContract,
      currentPeriodStart: schema.teams.currentPeriodStart,
      currentPeriodEnd: schema.teams.currentPeriodEnd,
      cancelAt: schema.teams.cancelAt,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    );
  return member;
}

/** Hosted opening is distinct from a commercial entitlement. Current membership
 * is rechecked; existing private content/contracts remain accessible after Envio
 * expiry. An invalid present cohort closes customer access without revoking data.
 */
export async function mailboxActorAccessEnabled(
  db: Db,
  actor: { teamId: string; userId: string },
  now = new Date(),
): Promise<boolean> {
  if (!mailboxRegistryEnabled()) return false;
  const cohort = mailboxEarlyAccessCohort();
  if (cohort === undefined) return mailboxAccessEnabled(actor);
  const member = await accessMember(db, actor);
  if (!member || member.suspendedAt) return false;
  if (member.plan === "system")
    return (await mailboxServiceEntitlement(db, actor.teamId)).unlimitedSeats;
  if (!cohort) return false;
  if (
    mailboxLaunchCohortAllows(
      cohort,
      { teamId: member.id, customerId: member.stripeCustomerId },
      now,
    )
  )
    return true;
  // The standalone offer is bought from inside Correio, before any Customer exists.
  if (mailboxStandaloneOpen() && mailboxLaunchCohortOpen(cohort, now)) return true;
  const [existing] = await db
    .select({ teamId: schema.mailboxSubscriptions.teamId })
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, actor.teamId))
    .limit(1);
  if (existing) return true;
  const [content] = await db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.teamId, actor.teamId))
    .limit(1);
  return !!content;
}

/** Called inside the existing registry-admin transaction. Cohort enrollment
 * never substitutes for a currently active, verified >US$20 Envio contract.
 * System retains its existing unlimited-seat / 50GiB policy in Core.
 */
export async function mailboxCreateAccessEnabled(
  db: Db,
  actor: { teamId: string; userId: string },
  now = new Date(),
): Promise<boolean> {
  if (!mailboxRegistryEnabled()) return false;
  const cohort = mailboxEarlyAccessCohort();
  if (cohort === undefined) return true;
  const member = await accessMember(db, actor);
  if (!member || member.suspendedAt) return false;
  if (member.plan === "system")
    return (await mailboxServiceEntitlement(db, actor.teamId)).unlimitedSeats;
  if (
    !mailboxLaunchCohortAllows(
      cohort,
      { teamId: member.id, customerId: member.stripeCustomerId },
      now,
    )
  )
    return false;
  if (hasPaidSendingPlanForMailbox(member, cohort, now)) return true;
  // A standalone Correio contract needs no Envio: its own active seats are the grant.
  const standalone = standaloneMailboxPriceIds();
  if (standalone.length === 0) return false;
  const entitlement = await mailboxServiceEntitlement(db, actor.teamId, false, now);
  return (
    entitlement.active &&
    !!entitlement.plan?.stripePriceId &&
    standalone.includes(entitlement.plan.stripePriceId)
  );
}

/** Protect reserved boxes before domain removal touches SES, even with registry UI off. */
export async function withMailboxDomainDeletion<T>(
  db: Db,
  teamId: string,
  domainId: string,
  remove: (db: Db) => Promise<T>,
): Promise<T> {
  const [extension] = await db
    .select({ installed: sql<boolean>`to_regclass('public.mailboxes') is not null` })
    .from(sql`(select 1) as mailbox_extension`);
  if (!extension?.installed) return remove(db);
  return db.transaction(async (tx) => {
    const transaction = tx as unknown as Db;
    await mailboxDomainLock(transaction, domainId);
    const [domain] = await transaction
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(and(eq(schema.domains.id, domainId), eq(schema.domains.teamId, teamId)));
    if (!domain) throw new TRPCError({ code: "NOT_FOUND" });
    const [registered] = await transaction
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(and(eq(schema.mailboxes.domainId, domainId), eq(schema.mailboxes.teamId, teamId)))
      .limit(1);
    if (registered)
      throw new TRPCError({ code: "CONFLICT", message: "Domain has registered mailboxes" });
    return remove(transaction);
  });
}
