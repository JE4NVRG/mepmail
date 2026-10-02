-- Separate optional Mail entitlement. No changes to Send billing or the main ledger.
CREATE TABLE "mailbox_subscriptions" (
  "team_id" uuid PRIMARY KEY REFERENCES "teams"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'inactive' NOT NULL CHECK ("status" IN ('inactive','trialing','active','past_due','canceled')),
  "seats" integer DEFAULT 0 NOT NULL CHECK ("seats" BETWEEN 0 AND 10000),
  "storage_bytes_per_mailbox" bigint NOT NULL CHECK ("storage_bytes_per_mailbox" BETWEEN 1 AND 10995116277760),
  "included_outbound_per_mailbox" integer NOT NULL CHECK ("included_outbound_per_mailbox" BETWEEN 0 AND 1000000),
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "stripe_price_id" text,
  "stripe_subscription_item_id" text,
  "currency" text,
  "unit_amount" integer,
  "interval" text,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "cancel_at" timestamptz,
  "stripe_subscription_created" integer,
  "livemode" boolean,
  "last_event_created" integer,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_subscriptions_period_check" CHECK ("period_end" > "period_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_subscriptions_stripe_id_idx" ON "mailbox_subscriptions"("stripe_subscription_id") WHERE "stripe_subscription_id" IS NOT NULL;
