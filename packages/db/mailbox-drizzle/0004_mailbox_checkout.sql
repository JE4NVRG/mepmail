-- Durable Mail purchase intent; no mutation of Send billing or its migration ledger.
CREATE TABLE "mailbox_checkouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'prepared' CHECK ("status" IN ('prepared','creating','ready','completed','expired')),
  "stripe_customer_id" text NOT NULL,
  "stripe_price_id" text NOT NULL,
  "seats" integer NOT NULL CHECK ("seats" BETWEEN 1 AND 10000),
  "livemode" boolean NOT NULL,
  "idempotency_key" text NOT NULL,
  "currency" text NOT NULL CHECK ("currency" ~ '^[a-z]{3}$'),
  "unit_amount" integer NOT NULL CHECK ("unit_amount" > 0),
  "interval" text NOT NULL CHECK ("interval" IN ('month','year')),
  "storage_bytes_per_mailbox" bigint NOT NULL CHECK ("storage_bytes_per_mailbox" BETWEEN 1 AND 10995116277760),
  "included_outbound_per_mailbox" integer NOT NULL CHECK ("included_outbound_per_mailbox" BETWEEN 0 AND 1000000),
  "success_url" text NOT NULL,
  "cancel_url" text NOT NULL,
  "automatic_tax" boolean NOT NULL DEFAULT false,
  "stripe_session_id" text,
  "stripe_subscription_id" text,
  "checkout_url" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mailbox_checkouts_ready_check" CHECK ("status" <> 'ready' OR ("stripe_session_id" IS NOT NULL AND "checkout_url" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_checkouts_idempotency_idx" ON "mailbox_checkouts"("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_checkouts_session_idx" ON "mailbox_checkouts"("stripe_session_id") WHERE "stripe_session_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_checkouts_open_team_idx" ON "mailbox_checkouts"("team_id") WHERE "status" IN ('prepared','creating','ready');
--> statement-breakpoint
CREATE FUNCTION mailbox_checkout_immutable_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.team_id, NEW.stripe_customer_id, NEW.stripe_price_id, NEW.seats, NEW.livemode,
         NEW.idempotency_key, NEW.currency, NEW.unit_amount, NEW.interval, NEW.storage_bytes_per_mailbox,
         NEW.included_outbound_per_mailbox, NEW.success_url, NEW.cancel_url, NEW.automatic_tax, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.team_id, OLD.stripe_customer_id, OLD.stripe_price_id, OLD.seats, OLD.livemode,
         OLD.idempotency_key, OLD.currency, OLD.unit_amount, OLD.interval, OLD.storage_bytes_per_mailbox,
         OLD.included_outbound_per_mailbox, OLD.success_url, OLD.cancel_url, OLD.automatic_tax, OLD.created_at) THEN
    RAISE EXCEPTION 'Mailbox checkout purchase terms are immutable';
  END IF;
  IF OLD.status IN ('completed','expired') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Mailbox checkout terminal state cannot reopen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'prepared' AND NEW.status = 'creating') OR
    (OLD.status = 'creating' AND NEW.status IN ('ready','completed','expired')) OR
    (OLD.status = 'ready' AND NEW.status IN ('completed','expired'))
  ) THEN
    RAISE EXCEPTION 'Mailbox checkout state cannot regress';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mailbox_checkout_immutable_terms BEFORE UPDATE ON "mailbox_checkouts"
FOR EACH ROW EXECUTE FUNCTION mailbox_checkout_immutable_terms();
