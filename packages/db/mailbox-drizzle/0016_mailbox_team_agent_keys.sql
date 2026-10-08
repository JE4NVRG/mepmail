ALTER TABLE "mailbox_agent_keys" ADD COLUMN "group_id" uuid;
--> statement-breakpoint
ALTER TABLE "mailbox_agent_keys" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_agent_keys_group_box_idx" ON "mailbox_agent_keys" ("group_id", "mailbox_id") WHERE "group_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_agent_keys" ADD CONSTRAINT "mailbox_agent_keys_default_group_check" CHECK ("group_id" IS NOT NULL OR NOT "is_default");
