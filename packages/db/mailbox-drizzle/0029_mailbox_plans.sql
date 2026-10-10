-- Correio plans (Solo, Duo, Equipe; Jean 2026-10-10). A plan grants a fixed number of
-- mailboxes and team-wide allowances per billing period: the shared storage and outbound
-- recipients already carried by quota_scope 'team', plus outbound MIME bytes and inbound
-- deliveries and bytes. NULL means no such allowance: subscriptions sold before the plans
-- keep exactly the terms they were sold with.
ALTER TABLE "mailbox_subscriptions" ADD COLUMN "plan_code" text;
--> statement-breakpoint
ALTER TABLE "mailbox_subscriptions" ADD COLUMN "inbound_deliveries_per_period" integer;
--> statement-breakpoint
ALTER TABLE "mailbox_subscriptions" ADD COLUMN "inbound_bytes_per_period" bigint;
--> statement-breakpoint
ALTER TABLE "mailbox_subscriptions" ADD COLUMN "outbound_bytes_per_period" bigint;
--> statement-breakpoint
ALTER TABLE "mailbox_subscriptions" ADD CONSTRAINT "mailbox_subscriptions_plan_check" CHECK (("plan_code" IS NULL OR "plan_code" IN ('solo','duo','equipe')) AND ("inbound_deliveries_per_period" IS NULL OR "inbound_deliveries_per_period" BETWEEN 0 AND 10000000) AND ("inbound_bytes_per_period" IS NULL OR "inbound_bytes_per_period" BETWEEN 0 AND 10995116277760) AND ("outbound_bytes_per_period" IS NULL OR "outbound_bytes_per_period" BETWEEN 0 AND 10995116277760));
--> statement-breakpoint
-- The purchase lease carries the same terms.
ALTER TABLE "mailbox_checkouts" ADD COLUMN "plan_code" text;
--> statement-breakpoint
ALTER TABLE "mailbox_checkouts" ADD COLUMN "inbound_deliveries_per_period" integer;
--> statement-breakpoint
ALTER TABLE "mailbox_checkouts" ADD COLUMN "inbound_bytes_per_period" bigint;
--> statement-breakpoint
ALTER TABLE "mailbox_checkouts" ADD COLUMN "outbound_bytes_per_period" bigint;
--> statement-breakpoint
ALTER TABLE "mailbox_checkouts" ADD CONSTRAINT "mailbox_checkouts_plan_check" CHECK (("plan_code" IS NULL OR "plan_code" IN ('solo','duo','equipe')) AND ("inbound_deliveries_per_period" IS NULL OR "inbound_deliveries_per_period" BETWEEN 0 AND 10000000) AND ("inbound_bytes_per_period" IS NULL OR "inbound_bytes_per_period" BETWEEN 0 AND 10995116277760) AND ("outbound_bytes_per_period" IS NULL OR "outbound_bytes_per_period" BETWEEN 0 AND 10995116277760));
--> statement-breakpoint
-- What a team received in one billing period, counted in the same transaction as the
-- message: one inbound delivery per provider receipt (however many of the team's
-- mailboxes or aliases it reached) and its raw MIME bytes. A redelivered receipt is a
-- duplicate and counts once; deleting mail never gives the allowance back. Outbound
-- recipients and bytes are read from mailbox_outbox, which already records both.
CREATE TABLE "mailbox_usage_periods" (
  "team_id" uuid NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "inbound_deliveries" integer DEFAULT 0 NOT NULL,
  "inbound_bytes" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_usage_periods_pk" PRIMARY KEY ("team_id", "period_start"),
  CONSTRAINT "mailbox_usage_periods_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_usage_periods_check" CHECK ("period_end" > "period_start" AND "inbound_deliveries" >= 0 AND "inbound_bytes" >= 0)
);
--> statement-breakpoint
-- Receiving paused for a team whose inbound allowance or storage ran out: its addresses
-- leave the SES receipt rules, so SES refuses new mail before accepting (and billing) it.
-- 'pausing'/'resuming' are wanted states not yet confirmed in SES; 'paused' is confirmed.
-- recipients are the addresses taken out (and any activated meanwhile), put back on resume.
-- The row goes away once SES routes the team's addresses again.
CREATE TABLE "mailbox_receiving_holds" (
  "team_id" uuid PRIMARY KEY NOT NULL,
  "reason" text NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "state" text DEFAULT 'pausing' NOT NULL,
  "recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_receiving_holds_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_receiving_holds_reason_check" CHECK ("reason" IN ('inbound_deliveries','inbound_bytes','storage')),
  CONSTRAINT "mailbox_receiving_holds_state_check" CHECK ("state" IN ('pausing','paused','resuming')),
  CONSTRAINT "mailbox_receiving_holds_recipients_check" CHECK (jsonb_typeof("recipients") = 'array' AND jsonb_array_length("recipients") <= 2000)
);
