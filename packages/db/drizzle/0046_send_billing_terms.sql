ALTER TABLE "teams" ADD COLUMN "billing_terms" jsonb;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "stripe_subscription_created" integer;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "send_billing_contract" jsonb;
--> statement-breakpoint
ALTER TABLE "usage_periods" ADD COLUMN "billing_terms" jsonb;
