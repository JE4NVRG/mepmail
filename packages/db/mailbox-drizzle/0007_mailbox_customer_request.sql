-- First-Customer intent for Mail; independent of Send billing and migration 0043.
CREATE TABLE "mailbox_customer_requests" (
  "team_id" uuid PRIMARY KEY REFERENCES "teams"("id") ON DELETE CASCADE,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'creating' CHECK ("status" IN ('creating','ready')),
  "name" text NOT NULL,
  "email" text NOT NULL,
  "livemode" boolean NOT NULL,
  "idempotency_key" text NOT NULL,
  "stripe_customer_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mailbox_customer_requests_ready_check" CHECK ("status" <> 'ready' OR "stripe_customer_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_customer_requests_key_idx" ON "mailbox_customer_requests"("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_customer_requests_customer_idx" ON "mailbox_customer_requests"("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION mailbox_customer_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.team_id, NEW.name, NEW.email, NEW.livemode, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.team_id, OLD.name, OLD.email, OLD.livemode, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'Mailbox Customer request parameters are immutable';
  END IF;
  IF OLD.status = 'ready' AND (NEW.status <> OLD.status OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id) THEN
    RAISE EXCEPTION 'Mailbox Customer request cannot reopen or change Customer';
  END IF;
  IF OLD.stripe_customer_id IS NOT NULL AND NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id THEN
    RAISE EXCEPTION 'Mailbox Customer request Customer cannot change';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mailbox_customer_request_immutable BEFORE UPDATE ON "mailbox_customer_requests"
FOR EACH ROW EXECUTE FUNCTION mailbox_customer_request_immutable();
