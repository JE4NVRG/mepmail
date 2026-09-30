ALTER TABLE "teams" ADD COLUMN "billing_terms" jsonb;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "stripe_subscription_created" integer;
