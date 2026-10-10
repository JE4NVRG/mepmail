-- Snooze, pin, send later and follow-up reminders: organization and scheduling
-- metadata on existing items. No content, recipients or delivery state change here;
-- a scheduled send still goes through the same admission (queueMailboxDraft), with
-- ownership, license, plan and seat checked again when it comes due.
ALTER TABLE "mailbox_items" ADD COLUMN "snoozed_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "resurfaced_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "pinned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "send_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "send_scheduled_by" text REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "send_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "send_failure" text;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "remind_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "reminded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_snooze_check" CHECK (("snoozed_until" IS NULL AND "resurfaced_at" IS NULL) OR "kind" = 'inbox');
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_send_later_check" CHECK (("send_at" IS NULL AND "send_claimed_at" IS NULL AND "send_failure" IS NULL) OR ("kind" = 'draft' AND ("send_at" IS NOT NULL OR "send_claimed_at" IS NULL) AND ("send_failure" IS NULL OR "send_failure" IN ('forbidden','not_entitled','conflict','invalid','not_found'))));
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_follow_up_check" CHECK (("remind_at" IS NULL AND "reminded_at" IS NULL) OR "kind" = 'sent');
--> statement-breakpoint
CREATE INDEX "mailbox_items_folder_order_idx" ON "mailbox_items" USING btree ("mailbox_id","kind","delivery_folder",(coalesce("resurfaced_at","created_at")),"id");
--> statement-breakpoint
CREATE INDEX "mailbox_items_snoozed_idx" ON "mailbox_items" USING btree ("snoozed_until") WHERE "snoozed_until" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "mailbox_items_pinned_idx" ON "mailbox_items" USING btree ("mailbox_id") WHERE "pinned_at" IS NOT NULL AND "trashed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "mailbox_items_send_at_idx" ON "mailbox_items" USING btree ("send_at") WHERE "send_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "mailbox_items_remind_at_idx" ON "mailbox_items" USING btree ("remind_at") WHERE "remind_at" IS NOT NULL AND "reminded_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "mailbox_items_reminded_idx" ON "mailbox_items" USING btree ("mailbox_id","reminded_at") WHERE "reminded_at" IS NOT NULL;
