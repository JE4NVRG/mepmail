import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * One free Correio trial per card: a SHA-256 of the Stripe card fingerprint,
 * never the fingerprint. No foreign key on team_id: the claim outlives the team,
 * so deleting a team and creating another does not reopen the trial.
 */
export const mailboxTrialClaims = pgTable(
  "mailbox_trial_claims",
  {
    fingerprintHash: text("fingerprint_hash").primaryKey(),
    teamId: uuid("team_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mailbox_trial_claims_team_idx").on(t.teamId),
    index("mailbox_trial_claims_customer_idx").on(t.stripeCustomerId),
  ],
);
