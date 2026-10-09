CREATE TABLE IF NOT EXISTS "google_checkout_contexts" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"consent_receipt_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "google_checkout_contexts_attempt_id_send_checkout_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."send_checkout_attempts"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "google_checkout_contexts_consent_receipt_id_advertising_consent_receipts_id_fk" FOREIGN KEY ("consent_receipt_id") REFERENCES "public"."advertising_consent_receipts"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "google_checkout_identity_check" CHECK ("client_id" ~ '^[0-9]{1,20}\.[0-9]{1,20}$' and ("session_id" is null or "session_id" ~ '^[0-9]{1,20}$'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_conversion_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"consent_receipt_id" uuid NOT NULL,
	"transaction_id" text NOT NULL,
	"rung" text NOT NULL,
	"value_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"last_failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_conversion_outbox_attempt_id_send_checkout_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."send_checkout_attempts"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "google_conversion_outbox_consent_receipt_id_advertising_consent_receipts_id_fk" FOREIGN KEY ("consent_receipt_id") REFERENCES "public"."advertising_consent_receipts"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "google_conversion_status_check" CHECK ("status" in ('pending','leased','sent','cancelled','dead')),
	CONSTRAINT "google_conversion_value_check" CHECK ("value_minor" > 0 and "attempts" >= 0),
	CONSTRAINT "google_conversion_lease_check" CHECK (("status" = 'leased') = ("lease_until" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_conversion_transaction_idx" ON "google_conversion_outbox" USING btree ("transaction_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_conversion_due_idx" ON "google_conversion_outbox" USING btree ("next_attempt_at") WHERE "google_conversion_outbox"."status" in ('pending','leased');
