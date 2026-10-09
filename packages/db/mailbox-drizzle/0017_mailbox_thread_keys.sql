-- Conversation keys: digests of Message-ID values (never the values), filled
-- on every new item and outbox row and backfilled once for older ones.
ALTER TABLE "mailbox_items" ADD COLUMN "message_key" text;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "thread_key" text;
--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD COLUMN "message_key" text;
--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD COLUMN "thread_key" text;
--> statement-breakpoint
CREATE INDEX "mailbox_items_thread_idx" ON "mailbox_items" ("mailbox_id", "thread_key") WHERE "thread_key" IS NOT NULL;
