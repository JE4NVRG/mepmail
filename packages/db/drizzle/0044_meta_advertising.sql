CREATE TABLE "advertising_consent_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proof_nonce" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"state" text NOT NULL,
	"user_id" text,
	"source_url" text,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advertising_consent_state_check" CHECK ("advertising_consent_receipts"."state" in ('accepted','denied')),
	CONSTRAINT "advertising_consent_accepted_check" CHECK ("advertising_consent_receipts"."state" <> 'accepted' or ("advertising_consent_receipts"."accepted_at" is not null and "advertising_consent_receipts"."revoked_at" is null))
);

--> statement-breakpoint
CREATE TABLE "meta_checkout_contexts" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"consent_receipt_id" uuid,
	"eligible" boolean NOT NULL,
	"source_url" text,
	"fbp" text,
	"fbc" text,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "meta_checkout_eligible_check" CHECK (not "meta_checkout_contexts"."eligible" or ("meta_checkout_contexts"."consent_receipt_id" is not null and "meta_checkout_contexts"."source_url" is not null and ("meta_checkout_contexts"."fbp" is not null or "meta_checkout_contexts"."fbc" is not null)))
);

--> statement-breakpoint
CREATE TABLE "meta_conversion_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_name" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"consent_receipt_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_session_id" text,
	"stripe_invoice_id" text,
	"stripe_subscription_id" text,
	"event_time" timestamp with time zone NOT NULL,
	"amount_paid_minor" integer,
	"currency" text,
	"confirmation" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"last_failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_conversion_name_check" CHECK ("meta_conversion_outbox"."event_name" in ('InitiateCheckout','Purchase')),
	CONSTRAINT "meta_conversion_status_check" CHECK ("meta_conversion_outbox"."status" in ('waiting','pending','leased','sent','cancelled','dead')),
	CONSTRAINT "meta_conversion_purchase_check" CHECK ("meta_conversion_outbox"."event_name" <> 'Purchase' or ("meta_conversion_outbox"."stripe_invoice_id" is not null and "meta_conversion_outbox"."stripe_subscription_id" is not null and "meta_conversion_outbox"."amount_paid_minor" is not null and "meta_conversion_outbox"."amount_paid_minor" > 0 and "meta_conversion_outbox"."currency" is not null)),
	CONSTRAINT "meta_conversion_checkout_check" CHECK ("meta_conversion_outbox"."event_name" <> 'InitiateCheckout' or "meta_conversion_outbox"."stripe_session_id" is not null),
	CONSTRAINT "meta_conversion_lease_check" CHECK (("meta_conversion_outbox"."status" = 'leased') = ("meta_conversion_outbox"."lease_token" is not null and "meta_conversion_outbox"."lease_until" is not null)),
	CONSTRAINT "meta_conversion_lease_pair_check" CHECK (("meta_conversion_outbox"."lease_token" is null) = ("meta_conversion_outbox"."lease_until" is null)),
	CONSTRAINT "meta_conversion_waiting_check" CHECK ("meta_conversion_outbox"."status" <> 'waiting' or ("meta_conversion_outbox"."event_name" = 'Purchase' and "meta_conversion_outbox"."confirmation" is not null)),
	CONSTRAINT "meta_conversion_attempts_check" CHECK ("meta_conversion_outbox"."attempts" >= 0)
);

--> statement-breakpoint
ALTER TABLE "advertising_consent_receipts" ADD CONSTRAINT "advertising_consent_receipts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "meta_checkout_contexts" ADD CONSTRAINT "meta_checkout_contexts_attempt_id_send_checkout_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."send_checkout_attempts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "meta_checkout_contexts" ADD CONSTRAINT "meta_checkout_contexts_consent_receipt_id_advertising_consent_receipts_id_fk" FOREIGN KEY ("consent_receipt_id") REFERENCES "public"."advertising_consent_receipts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "meta_conversion_outbox" ADD CONSTRAINT "meta_conversion_outbox_attempt_id_meta_checkout_contexts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."meta_checkout_contexts"("attempt_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "meta_conversion_outbox" ADD CONSTRAINT "meta_conversion_outbox_consent_receipt_id_advertising_consent_receipts_id_fk" FOREIGN KEY ("consent_receipt_id") REFERENCES "public"."advertising_consent_receipts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "meta_conversion_event_id_idx" ON "meta_conversion_outbox" USING btree ("event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "meta_conversion_session_idx" ON "meta_conversion_outbox" USING btree ("livemode","stripe_session_id") WHERE "meta_conversion_outbox"."event_name" = 'InitiateCheckout';
--> statement-breakpoint
CREATE UNIQUE INDEX "meta_conversion_invoice_idx" ON "meta_conversion_outbox" USING btree ("livemode","stripe_invoice_id") WHERE "meta_conversion_outbox"."event_name" = 'Purchase';
--> statement-breakpoint
CREATE UNIQUE INDEX "meta_conversion_acquisition_idx" ON "meta_conversion_outbox" USING btree ("livemode","stripe_subscription_id") WHERE "meta_conversion_outbox"."event_name" = 'Purchase';
--> statement-breakpoint
CREATE INDEX "meta_conversion_due_idx" ON "meta_conversion_outbox" USING btree ("next_attempt_at") WHERE "meta_conversion_outbox"."status" in ('waiting','pending','leased');
