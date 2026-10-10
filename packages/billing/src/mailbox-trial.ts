import { createHash } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { BillingStripe } from "./stripe.js";
import { idOf } from "./subscription.js";

// The trial's sending limits live with the enforcement, in core.
export {
  MAILBOX_TRIAL_DAILY_RECIPIENTS,
  MAILBOX_TRIAL_TOTAL_RECIPIENTS,
} from "../../core/src/mailbox-service.js";

export function mailboxTrialFingerprintHash(fingerprint: string) {
  return createHash("sha256").update(`mepmail-correio-trial:${fingerprint}`).digest("hex");
}

export type MailboxTrialClaim = "claimed" | "duplicate_card" | "no_card" | "not_trialing";

/**
 * One trial per card. Called for a verified Correio subscription event, with the
 * subscription re-fetched and its default_payment_method expanded. A trial whose
 * card already started another team's trial, or that has no card, ends now: the
 * first invoice is charged at once and the subscription goes on as a paid one.
 */
export async function claimMailboxTrial(
  db: Db,
  stripe: Pick<BillingStripe, "subscriptions">,
  sub: Stripe.Subscription,
  teamId: string,
): Promise<MailboxTrialClaim> {
  if (sub.status !== "trialing") return "not_trialing";
  const customerId = idOf(sub.customer);
  const method = sub.default_payment_method;
  const fingerprint =
    method && typeof method === "object" && method.type === "card"
      ? (method.card?.fingerprint ?? null)
      : null;
  const endTrial = () =>
    stripe.subscriptions.update(sub.id, { trial_end: "now", proration_behavior: "none" });
  if (!fingerprint || !customerId) {
    await endTrial();
    return "no_card";
  }
  const fingerprintHash = mailboxTrialFingerprintHash(fingerprint);
  const inserted = await db
    .insert(schema.mailboxTrialClaims)
    .values({ fingerprintHash, teamId, stripeCustomerId: customerId, stripeSubscriptionId: sub.id })
    .onConflictDoNothing()
    .returning({ hash: schema.mailboxTrialClaims.fingerprintHash });
  if (inserted.length) return "claimed";
  const [claim] = await db
    .select({ subscriptionId: schema.mailboxTrialClaims.stripeSubscriptionId })
    .from(schema.mailboxTrialClaims)
    .where(eq(schema.mailboxTrialClaims.fingerprintHash, fingerprintHash));
  if (claim?.subscriptionId === sub.id) return "claimed";
  await endTrial();
  return "duplicate_card";
}
