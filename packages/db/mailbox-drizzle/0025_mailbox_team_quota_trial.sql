-- Correio priced as a base that includes several mailboxes (US$12.90 with 3,
-- extra mailboxes at US$3.90): the storage and outbound allowance can belong to
-- the whole team instead of each mailbox (quota_scope 'team'), the base covers
-- included_mailboxes seats and every seat above them costs extra_unit_amount.
-- Existing rows keep the per-mailbox terms they were sold with.
ALTER TABLE "mailbox_subscriptions" ADD COLUMN "quota_scope" text DEFAULT 'mailbox' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_subscriptions" ADD COLUMN "included_mailboxes" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_subscriptions" ADD COLUMN "extra_unit_amount" integer;
--> statement-breakpoint
ALTER TABLE "mailbox_subscriptions" ADD CONSTRAINT "mailbox_subscriptions_quota_scope_check" CHECK ("quota_scope" IN ('mailbox','team') AND "included_mailboxes" BETWEEN 1 AND 10000 AND ("extra_unit_amount" IS NULL OR "extra_unit_amount" > 0));
--> statement-breakpoint
-- The purchase lease carries the same terms, plus the free trial it was opened with.
ALTER TABLE "mailbox_checkouts" ADD COLUMN "quota_scope" text DEFAULT 'mailbox' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_checkouts" ADD COLUMN "included_mailboxes" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_checkouts" ADD COLUMN "extra_unit_amount" integer;
--> statement-breakpoint
ALTER TABLE "mailbox_checkouts" ADD COLUMN "trial_days" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_checkouts" ADD CONSTRAINT "mailbox_checkouts_terms_check" CHECK ("quota_scope" IN ('mailbox','team') AND "included_mailboxes" BETWEEN 1 AND 10000 AND ("extra_unit_amount" IS NULL OR "extra_unit_amount" > 0) AND "trial_days" BETWEEN 0 AND 30 AND "seats" >= "included_mailboxes");
--> statement-breakpoint
-- One free trial per card: a SHA-256 of the card fingerprint, never the
-- fingerprint itself. Kept when the team is deleted, so a new team cannot reuse
-- the card for another trial.
CREATE TABLE "mailbox_trial_claims" (
  "fingerprint_hash" text PRIMARY KEY NOT NULL,
  "team_id" uuid NOT NULL,
  "stripe_customer_id" text NOT NULL,
  "stripe_subscription_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_trial_claims_hash_check" CHECK ("fingerprint_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "mailbox_trial_claims_team_idx" ON "mailbox_trial_claims" ("team_id");
--> statement-breakpoint
CREATE INDEX "mailbox_trial_claims_customer_idx" ON "mailbox_trial_claims" ("stripe_customer_id");
