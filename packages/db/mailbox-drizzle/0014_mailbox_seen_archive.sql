ALTER TABLE "mailbox_items" ADD COLUMN "seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "archived_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "mailbox_items" SET "seen_at" = "created_at" WHERE "seen_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "mailbox_items_unseen_inbox_idx" ON "mailbox_items" ("mailbox_id") WHERE "kind" = 'inbox' AND "seen_at" IS NULL AND "trashed_at" IS NULL AND "archived_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "mailbox_items_archived_created_idx" ON "mailbox_items" ("mailbox_id", "created_at", "id") WHERE "archived_at" IS NOT NULL AND "trashed_at" IS NULL;
