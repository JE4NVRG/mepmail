-- Preserve private MIME and admit Sent only after provider acceptance.
ALTER TABLE "mailbox_items" DROP CONSTRAINT "mailbox_items_kind_check";
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_kind_check" CHECK ("kind" IN ('inbox','draft','sent'));
--> statement-breakpoint
ALTER TABLE "mailbox_items" DROP CONSTRAINT "mailbox_items_source_check";
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_source_check" CHECK (("kind" IN ('inbox','sent') AND "source_id" IS NOT NULL AND length("source_id") BETWEEN 1 AND 128) OR ("kind" = 'draft' AND "source_id" IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_items_id_box_team_idx" ON "mailbox_items"("id","mailbox_id","team_id");
--> statement-breakpoint
CREATE TABLE "mailbox_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "draft_id" uuid NOT NULL,
  "draft_revision" integer NOT NULL CHECK ("draft_revision" >= 1),
  "approved_by" text NOT NULL,
  "approved_membership_id" uuid NOT NULL,
  "recipient_count" integer NOT NULL CHECK ("recipient_count" BETWEEN 1 AND 20),
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL CHECK ("period_end" > "period_start"),
  "raw_bytes" integer NOT NULL CHECK ("raw_bytes" BETWEEN 1 AND 1048576),
  "raw_sha256" text NOT NULL CHECK ("raw_sha256" ~ '^[a-f0-9]{64}$'),
  "ciphertext" bytea,
  "iv" bytea,
  "wrapped_dek" bytea,
  "key_version" integer,
  "status" text DEFAULT 'queued' NOT NULL CHECK ("status" IN ('queued','sending','accepted','unknown','failed')),
  "attempt_id" uuid,
  "attempted_at" timestamptz,
  "accepted_at" timestamptz,
  "provider_message_id" text,
  "error_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_outbox_box_team_fk" FOREIGN KEY ("mailbox_id","team_id") REFERENCES "mailboxes"("id","team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_outbox_draft_box_team_fk" FOREIGN KEY ("draft_id","mailbox_id","team_id") REFERENCES "mailbox_items"("id","mailbox_id","team_id") ON DELETE RESTRICT,
  CONSTRAINT "mailbox_outbox_attempt_check" CHECK (("status" = 'queued' AND "attempt_id" IS NULL AND "attempted_at" IS NULL) OR "status" = 'failed' OR ("attempt_id" IS NOT NULL AND "attempted_at" IS NOT NULL)),
  CONSTRAINT "mailbox_outbox_payload_check" CHECK (("status" = 'accepted' AND "ciphertext" IS NULL AND "iv" IS NULL AND "wrapped_dek" IS NULL AND "key_version" IS NULL AND "provider_message_id" IS NOT NULL AND "accepted_at" IS NOT NULL) OR ("status" <> 'accepted' AND "ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND "wrapped_dek" IS NOT NULL AND "key_version" >= 2000000 AND octet_length("iv") = 12 AND octet_length("ciphertext") BETWEEN 17 AND 1048592))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_outbox_draft_revision_idx" ON "mailbox_outbox"("mailbox_id","draft_id","draft_revision");
--> statement-breakpoint
CREATE INDEX "mailbox_outbox_pending_idx" ON "mailbox_outbox"("status","created_at","id");
--> statement-breakpoint
CREATE INDEX "mailbox_outbox_period_idx" ON "mailbox_outbox"("mailbox_id","period_start");
