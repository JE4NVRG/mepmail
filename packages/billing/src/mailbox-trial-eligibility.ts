import { type Db, schema } from "@millionsend/db";
import { and, eq, isNotNull, or } from "drizzle-orm";
import type { MailboxPriceTerms } from "./mailbox.js";

/**
 * A first Correio purchase may carry the price's free trial: never when the team
 * or its Customer ever held a Correio subscription, or already claimed a trial.
 * The card check comes after Checkout (claimMailboxTrial). DB-only when
 * `priorSubscription` is not known yet (presentation).
 */
export async function mailboxTrialDays(
  db: Db,
  terms: Pick<MailboxPriceTerms, "trialDays">,
  teamId: string,
  customerId: string | null,
  priorSubscription = false,
): Promise<number> {
  if (!terms.trialDays || priorSubscription) return 0;
  const [held] = await db
    .select({ id: schema.mailboxSubscriptions.stripeSubscriptionId })
    .from(schema.mailboxSubscriptions)
    .where(
      and(
        eq(schema.mailboxSubscriptions.teamId, teamId),
        isNotNull(schema.mailboxSubscriptions.stripeSubscriptionId),
      ),
    );
  if (held) return 0;
  const [bought] = await db
    .select({ id: schema.mailboxCheckouts.id })
    .from(schema.mailboxCheckouts)
    .where(
      and(
        eq(schema.mailboxCheckouts.teamId, teamId),
        isNotNull(schema.mailboxCheckouts.stripeSubscriptionId),
      ),
    )
    .limit(1);
  if (bought) return 0;
  const [claimed] = await db
    .select({ hash: schema.mailboxTrialClaims.fingerprintHash })
    .from(schema.mailboxTrialClaims)
    .where(
      customerId
        ? or(
            eq(schema.mailboxTrialClaims.teamId, teamId),
            eq(schema.mailboxTrialClaims.stripeCustomerId, customerId),
          )
        : eq(schema.mailboxTrialClaims.teamId, teamId),
    )
    .limit(1);
  return claimed ? 0 : terms.trialDays;
}
