-- Durable Mail management; no Send columns, message deletion, prices or provider writes.
CREATE TABLE "mailbox_management_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "action" text NOT NULL CHECK ("action" IN ('cancel','resume','increase','decrease')),
  "status" text NOT NULL CHECK ("status" IN ('prepared','creating','pending','scheduled','confirmed','expired')),
  "step" text NOT NULL CHECK ("step" IN ('update','create_schedule','configure_schedule','release_schedule')),
  "seats_before" integer NOT NULL CHECK ("seats_before" BETWEEN 1 AND 10000),
  "seats" integer NOT NULL CHECK ("seats" BETWEEN 1 AND 10000),
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL CHECK ("period_end" > "period_start"),
  "stripe_customer_id" text NOT NULL,
  "stripe_subscription_id" text NOT NULL,
  "stripe_subscription_item_id" text NOT NULL,
  "stripe_price_id" text NOT NULL,
  "livemode" boolean NOT NULL,
  "idempotency_key" text NOT NULL,
  "previous_invoice_id" text,
  "stripe_invoice_id" text,
  "stripe_schedule_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_management_idempotency_idx" ON "mailbox_management_requests"("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_management_open_team_idx" ON "mailbox_management_requests"("team_id") WHERE "status" IN ('prepared','creating','pending');
--> statement-breakpoint
CREATE FUNCTION mailbox_management_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.team_id,NEW.action,NEW.seats_before,NEW.seats,NEW.period_start,NEW.period_end,
         NEW.stripe_customer_id,NEW.stripe_subscription_id,NEW.stripe_subscription_item_id,NEW.stripe_price_id,
         NEW.livemode,NEW.idempotency_key,NEW.previous_invoice_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.team_id,OLD.action,OLD.seats_before,OLD.seats,OLD.period_start,OLD.period_end,
         OLD.stripe_customer_id,OLD.stripe_subscription_id,OLD.stripe_subscription_item_id,OLD.stripe_price_id,
         OLD.livemode,OLD.idempotency_key,OLD.previous_invoice_id,OLD.created_at)
  THEN RAISE EXCEPTION 'immutable Mail management request'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mailbox_management_request_immutable BEFORE UPDATE ON mailbox_management_requests FOR EACH ROW EXECUTE FUNCTION mailbox_management_request_immutable();
