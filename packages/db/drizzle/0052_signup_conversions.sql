CREATE TABLE IF NOT EXISTS "signup_conversion_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"vendor" text NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"consent_receipt_id" uuid NOT NULL,
	"source_url" text,
	"fbp" text,
	"fbc" text,
	"client_id" text,
	"session_id" text,
	"event_time" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"last_failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_conversion_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "signup_conversion_outbox_consent_receipt_id_advertising_consent_receipts_id_fk" FOREIGN KEY ("consent_receipt_id") REFERENCES "public"."advertising_consent_receipts"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "signup_conversion_vendor_check" CHECK ("vendor" in ('meta','google')),
	CONSTRAINT "signup_conversion_status_check" CHECK ("status" in ('pending','leased','sent','cancelled','dead') and "attempts" >= 0),
	CONSTRAINT "signup_conversion_lease_check" CHECK (("status" = 'leased') = ("lease_until" is not null)),
	CONSTRAINT "signup_conversion_identity_check" CHECK ("status" not in ('pending','leased') or (
        ("vendor" = 'meta' and "source_url" is not null and ("fbp" is not null or "fbc" is not null) and "client_id" is null and "session_id" is null)
        or ("vendor" = 'google' and "client_id" ~ '^[0-9]{1,20}\.[0-9]{1,20}$' and ("session_id" is null or "session_id" ~ '^[0-9]{1,20}$') and "fbp" is null and "fbc" is null)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signup_conversion_user_vendor_idx" ON "signup_conversion_outbox" USING btree ("user_id","vendor");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_conversion_due_idx" ON "signup_conversion_outbox" USING btree ("next_attempt_at") WHERE "signup_conversion_outbox"."status" in ('pending','leased');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_conversion_receipt_idx" ON "signup_conversion_outbox" USING btree ("consent_receipt_id");
