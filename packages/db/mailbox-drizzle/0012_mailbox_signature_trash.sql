ALTER TABLE "mailboxes" ADD COLUMN "signature_text" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_signature_text_check" CHECK (char_length("signature_text") <= 4000);
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "trashed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "mailbox_items_trash_created_idx" ON "mailbox_items" ("mailbox_id", "trashed_at", "id") WHERE "trashed_at" IS NOT NULL;
