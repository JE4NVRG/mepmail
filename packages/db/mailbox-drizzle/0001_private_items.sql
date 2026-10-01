-- Private MIME persistence; optional mailbox ledger only. No main/billing migrations.
CREATE TABLE "mailbox_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('inbox','draft')),
  "source_id" text,
  "revision" integer DEFAULT 1 NOT NULL CHECK ("revision" >= 1),
  "raw_bytes" integer NOT NULL CHECK ("raw_bytes" BETWEEN 1 AND 1048576),
  "ciphertext" bytea NOT NULL,
  "iv" bytea NOT NULL,
  "wrapped_dek" bytea NOT NULL,
  "key_version" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_items_box_team_fk" FOREIGN KEY ("mailbox_id","team_id") REFERENCES "mailboxes"("id","team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_items_source_check" CHECK (("kind" = 'inbox' AND "source_id" IS NOT NULL AND length("source_id") BETWEEN 1 AND 128) OR ("kind" = 'draft' AND "source_id" IS NULL)),
  CONSTRAINT "mailbox_items_envelope_check" CHECK ("key_version" >= 2000000 AND octet_length("iv") = 12 AND octet_length("ciphertext") BETWEEN 17 AND 1048592)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_items_source_idx" ON "mailbox_items"("mailbox_id","source_id") WHERE "source_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "mailbox_items_box_created_idx" ON "mailbox_items"("mailbox_id","created_at","id");
