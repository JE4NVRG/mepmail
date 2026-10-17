import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { getTeamSignupRisk } from "./signup-risk.js";
import { extractAddrSpec, normalizeAddress } from "./suppressions.js";

export type SignupSendingRestriction =
  | { kind: "none" }
  | { kind: "review" }
  | { kind: "sandbox"; principalEmail: string | null; principalVerified: boolean };

/** Payment is one signal. A provider-verified active contract AND a verified
 * sending domain may clear sandbox eligibility, never a review or an existing hold. */
async function activeContractAndDomain(db: Db, teamId: string): Promise<boolean> {
  const [team] = await db
    .select({
      plan: schema.teams.plan,
      status: schema.teams.planStatus,
      contract: schema.teams.sendBillingContract,
      subscription: schema.teams.stripeSubscriptionId,
      periodEnd: schema.teams.currentPeriodEnd,
      held: schema.teams.sendReviewAt,
      suspended: schema.teams.suspendedAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  if (
    !team ||
    team.plan === "free" ||
    team.plan === "system" ||
    team.status !== "active" ||
    !team.subscription ||
    !team.contract ||
    team.contract.subscriptionId !== team.subscription ||
    !Number.isFinite(Date.parse(team.contract.verifiedAt)) ||
    !team.periodEnd ||
    team.periodEnd.getTime() <= Date.now() ||
    team.held ||
    team.suspended
  )
    return false;
  const [domain] = await db
    .select({ id: schema.domains.id })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, teamId), eq(schema.domains.status, "verified")))
    .limit(1);
  return Boolean(domain);
}

/** This record is server-owned and bound to the team's original principal.
 * Membership changes, client tags, API key permission and payment alone cannot widen it. */
export async function getSignupSendingRestriction(
  db: Db,
  teamId: string,
  isCloud = true,
): Promise<SignupSendingRestriction> {
  if (!isCloud) return { kind: "none" };
  const risk = await getTeamSignupRisk(db, teamId);
  if (!risk || risk.clearedAt || risk.level === "good") return { kind: "none" };
  if (risk.level === "hold") return { kind: "review" };
  if (await activeContractAndDomain(db, teamId)) return { kind: "none" };
  return {
    kind: "sandbox",
    principalEmail: risk.principalEmail,
    principalVerified: risk.principalVerified,
  };
}

/** Exact verified mailbox only: no aliases, domain-wide allowance, membership
 * expansion or partial strip. One external Bcc refuses the entire operation. */
export function signupRecipientsAllowed(
  restriction: SignupSendingRestriction,
  recipients: readonly string[],
): boolean {
  if (restriction.kind === "none") return true;
  if (restriction.kind === "review") return false;
  if (!restriction.principalVerified || !restriction.principalEmail || recipients.length === 0)
    return false;
  const allowed = normalizeAddress(restriction.principalEmail);
  return recipients.every((recipient) => {
    const address = extractAddrSpec(recipient);
    return address !== null && normalizeAddress(address) === allowed;
  });
}

export async function checkSignupSend(
  db: Db,
  teamId: string,
  recipients: readonly string[],
  isCloud = true,
): Promise<
  { allowed: true } | { allowed: false; reason: "signup_sandbox" | "signup_review_required" }
> {
  const restriction = await getSignupSendingRestriction(db, teamId, isCloud);
  return signupRecipientsAllowed(restriction, recipients)
    ? { allowed: true }
    : {
        allowed: false,
        reason: restriction.kind === "review" ? "signup_review_required" : "signup_sandbox",
      };
}

export function signupSendMessage(reason: "signup_sandbox" | "signup_review_required"): string {
  return reason === "signup_sandbox"
    ? "External sending is awaiting review. You can send test messages only to your own verified signup address. Request a review through Support."
    : "Sending is held for review of this account. Your data is preserved. Request a review through Support.";
}

/** An explicit operator decision affects this team only. It never releases an
 * existing send-review hold, alters suspension, drains a queue or sends mail. */
export async function clearTeamSignupRisk(
  db: Db,
  input: { teamId: string; operatorId: string; reason: string; now?: Date },
): Promise<boolean> {
  const reason = input.reason.trim();
  if (reason.length < 15 || reason.length > 500) throw new Error("signup_review_reason_required");
  const principal = await getTeamSignupRisk(db, input.teamId);
  if (principal && (!principal.principalEmail || !principal.principalVerified)) {
    throw new Error("signup_review_verified_principal_required");
  }
  return db.transaction(async (tx) => {
    const [risk] = await tx
      .update(schema.teamSignupRisk)
      .set({
        clearedAt: input.now ?? new Date(),
        clearedBy: input.operatorId,
        clearedReason: reason,
      })
      .where(
        and(
          eq(schema.teamSignupRisk.teamId, input.teamId),
          isNull(schema.teamSignupRisk.clearedAt),
        ),
      )
      .returning({ teamId: schema.teamSignupRisk.teamId });
    if (!risk) return false;
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: `user:${input.operatorId}`,
      action: "team.signup_risk_cleared",
      target: `team:${input.teamId}`,
      data: { reason, existingHoldOrSuspensionUnchanged: true, noQueueAction: true },
    });
    return true;
  });
}
