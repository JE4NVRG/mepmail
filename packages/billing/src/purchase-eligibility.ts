import {
  fetchDeliverabilityHealth,
  getSignupSendingRestriction,
  SEND_REVIEW_NEW_TEAM_DAYS,
  type SendReviewReason,
  screenNewSender,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, asc, eq } from "drizzle-orm";
import { abuseProneTld } from "../../core/src/send-review.js";

export type PurchaseEligibilityCode =
  | "ready"
  | "domain_required"
  | "domain_review"
  | "send_review"
  | "signup_review"
  | "signup_sandbox"
  | "suspended"
  | "guardrail_paused"
  | "forbidden"
  | "not_found";

/** Safe for an authenticated team's billing UI: never includes internal risk signals or notes. */
export interface PurchaseEligibility {
  eligible: boolean;
  code: PurchaseEligibilityCode;
  domains: string[];
  reviewReason: SendReviewReason | null;
}

export class PurchaseEligibilityError extends Error {
  readonly code: PurchaseEligibilityCode;

  constructor(public readonly eligibility: PurchaseEligibility) {
    super(eligibility.code);
    this.name = "PurchaseEligibilityError";
    this.code = eligibility.code;
  }
}

/** Read-only preflight; a risky verified domain is visible before the first send or payment. */
export async function getPurchaseEligibility(db: Db, teamId: string): Promise<PurchaseEligibility> {
  const [team] = await db
    .select({
      plan: schema.teams.plan,
      createdAt: schema.teams.createdAt,
      suspendedAt: schema.teams.suspendedAt,
      sendReviewAt: schema.teams.sendReviewAt,
      sendReviewReason: schema.teams.sendReviewReason,
      sendReviewNote: schema.teams.sendReviewNote,
      sendReviewClearedAt: schema.teams.sendReviewClearedAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  const status = (
    code: PurchaseEligibilityCode,
    domains: string[] = [],
    reviewReason: SendReviewReason | null = null,
  ): PurchaseEligibility => ({ eligible: code === "ready", code, domains, reviewReason });
  if (!team || team.plan === "system") return status("not_found");
  if (team.suspendedAt) return status("suspended");
  const verified = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, teamId), eq(schema.domains.status, "verified")))
    .orderBy(asc(schema.domains.name));
  const domains = verified.map((domain) => domain.name);
  const risky = domains.filter((domain) => abuseProneTld(`review@${domain}`));
  if (team.sendReviewAt) {
    const domainHold =
      team.sendReviewReason === "new_sender" &&
      /^Sending domain of [^\s]+ is under \.[a-z]{2,63},/.test(team.sendReviewNote ?? "");
    return status(
      domainHold ? "domain_review" : "send_review",
      domainHold ? risky : [],
      team.sendReviewReason,
    );
  }
  const signup = await getSignupSendingRestriction(db, teamId);
  if (signup.kind === "review") return status("signup_review");
  if (signup.kind === "sandbox") return status("signup_sandbox");
  const [standing] = await db
    .select({ guardrail: schema.teamStandings.guardrail })
    .from(schema.teamStandings)
    .where(eq(schema.teamStandings.teamId, teamId));
  if (standing?.guardrail === "paused") return status("guardrail_paused");
  if ((await fetchDeliverabilityHealth(db, teamId)).status === "paused")
    return status("guardrail_paused");
  if (!domains.length) return status("domain_required");
  if (
    !team.sendReviewClearedAt &&
    Date.now() - team.createdAt.getTime() <= SEND_REVIEW_NEW_TEAM_DAYS * 86_400_000 &&
    risky.length
  )
    return status("domain_review", risky, "new_sender");
  return status("ready", domains);
}

/** Recheck under the caller's existing team lock, with no mutation that a rejection could roll back. */
export async function assertPurchaseEligibility(db: Db, teamId: string): Promise<void> {
  const eligibility = await getPurchaseEligibility(db, teamId);
  if (!eligibility.eligible) throw new PurchaseEligibilityError(eligibility);
}

/**
 * Persists the existing pre-send review before a checkout starts. The hold commits in its own
 * transaction even when the checkout is rejected; no Customer, payment or entitlement is created.
 * A read-only status query never implicitly places a team on hold.
 */
export async function preparePurchaseEligibility(
  db: Db,
  input: { teamId: string; userId: string },
): Promise<PurchaseEligibility> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [team] = await tx
      .select({
        id: schema.teams.id,
        plan: schema.teams.plan,
        suspendedAt: schema.teams.suspendedAt,
      })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("update");
    const [member] = await tx
      .select({ role: schema.teamMembers.role })
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, input.teamId),
          eq(schema.teamMembers.userId, input.userId),
        ),
      )
      .for("share");
    if (!team || !member || !["owner", "admin"].includes(member.role) || team.plan === "system") {
      throw new PurchaseEligibilityError({
        eligible: false,
        code: "forbidden",
        domains: [],
        reviewReason: null,
      });
    }
    const eligibility = await getPurchaseEligibility(tx, input.teamId);
    if (eligibility.code === "domain_review" && !team.suspendedAt) {
      // Only the already identified TLD screen is safe to evaluate with a synthetic sender.
      // The real sender/recipient screens still run on each send; preflight must not invent
      // a fifth sender address and turn a legitimate four-sender history into a rotation hold.
      for (const domain of eligibility.domains) {
        if (await screenNewSender(tx, { teamId: team.id, from: `review@${domain}`, recipients: 0 }))
          break;
      }
      return getPurchaseEligibility(tx, input.teamId);
    }
    return eligibility;
  });
}

/** Must run outside the transaction that will create a Customer or a Checkout. */
export async function requirePurchaseEligibility(
  db: Db,
  input: { teamId: string; userId: string },
): Promise<void> {
  const eligibility = await preparePurchaseEligibility(db, input);
  if (!eligibility.eligible) throw new PurchaseEligibilityError(eligibility);
}
