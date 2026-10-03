CREATE TABLE "send_checkout_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "status" text NOT NULL,
  "rung" text NOT NULL,
  "livemode" boolean NOT NULL,
  "stripe_customer_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "parameters" jsonb NOT NULL,
  "stripe_session_id" text,
  "checkout_url" text,
  "first_requested_at" timestamptz,
  "lease_token" uuid,
  "lease_until" timestamptz,
  "resolved_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "send_checkout_attempts_status_check" CHECK (status IN ('prepared','unknown','created','resolved')),
  CONSTRAINT "send_checkout_attempts_created_check" CHECK (status <> 'created' OR (stripe_session_id IS NOT NULL AND checkout_url IS NOT NULL)),
  CONSTRAINT "send_checkout_attempts_unknown_check" CHECK (status <> 'unknown' OR first_requested_at IS NOT NULL),
  CONSTRAINT "send_checkout_attempts_resolved_check" CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT "send_checkout_attempts_lease_check" CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "send_checkout_attempts_key_idx" ON "send_checkout_attempts" ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "send_checkout_attempts_session_idx" ON "send_checkout_attempts" ("stripe_session_id") WHERE stripe_session_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "send_checkout_attempts_active_team_idx" ON "send_checkout_attempts" ("team_id") WHERE status <> 'resolved';
