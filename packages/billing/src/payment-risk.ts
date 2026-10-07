import { holdTeamForReview } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import type { BillingStripe } from "./stripe.js";

/** Charges read per screen: a checkout's failed attempts sit well inside it. */
const SCREENED_CHARGES = 20;

/**
 * Hold a customer's team for review when Stripe's fraud screening blocked
 * one of its payments, or rated one the highest risk: a card that fails
 * Radar and then a second card that passes is how a phishing run buys its
 * first month. Charges before an operator's last release are not read again,
 * so a released team is held only by a new block. A Stripe failure skips the
 * screen (the event still applies); the next event screens again.
 */
export async function screenPaymentRisk(
  db: Db,
  stripe: BillingStripe,
  customerId: string,
  log: (message: string) => void,
): Promise<boolean> {
  if (!stripe.charges) return false;
  const [team] = await db
    .select({
      id: schema.teams.id,
      plan: schema.teams.plan,
      sendReviewAt: schema.teams.sendReviewAt,
      sendReviewClearedAt: schema.teams.sendReviewClearedAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.stripeCustomerId, customerId));
  if (!team || team.plan === "system" || team.sendReviewAt) return false;
  let charges: Awaited<ReturnType<NonNullable<BillingStripe["charges"]>["list"]>>;
  try {
    charges = await stripe.charges.list({
      customer: customerId,
      limit: SCREENED_CHARGES,
      ...(team.sendReviewClearedAt
        ? { created: { gt: Math.floor(team.sendReviewClearedAt.getTime() / 1000) } }
        : {}),
    });
  } catch (error) {
    log(`payment risk screen skipped (${String(error)})`);
    return false;
  }
  const risky = charges.data.find(
    (c) => c.outcome?.type === "blocked" || c.outcome?.risk_level === "highest",
  );
  if (!risky) return false;
  const verdict = risky.outcome?.type === "blocked" ? "blocked" : "rated highest risk";
  return holdTeamForReview(db, {
    teamId: team.id,
    reason: "payment_risk",
    note: `Stripe fraud screening ${verdict} payment ${risky.id}`,
  });
}
