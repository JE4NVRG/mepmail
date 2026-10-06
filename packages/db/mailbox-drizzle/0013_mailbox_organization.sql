CREATE TABLE "mailbox_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "name" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_folders_box_team_fk" FOREIGN KEY ("mailbox_id", "team_id") REFERENCES "mailboxes"("id", "team_id") ON DELETE restrict,
  CONSTRAINT "mailbox_folders_name_check" CHECK (char_length("name") between 1 and 80 and "name" = btrim("name")),
  CONSTRAINT "mailbox_folders_revision_check" CHECK ("revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_folders_id_box_team_idx" ON "mailbox_folders" ("id", "mailbox_id", "team_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_folders_active_name_idx" ON "mailbox_folders" ("mailbox_id", lower("name")) WHERE "archived_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "mailbox_folders_box_created_idx" ON "mailbox_folders" ("mailbox_id", "created_at", "id");
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "starred_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "folder_id" uuid;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_named_folder_fk" FOREIGN KEY ("folder_id", "mailbox_id", "team_id") REFERENCES "mailbox_folders"("id", "mailbox_id", "team_id") ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX "mailbox_items_starred_created_idx" ON "mailbox_items" ("mailbox_id", "created_at", "id") WHERE "starred_at" IS NOT NULL AND "trashed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "mailbox_items_named_folder_created_idx" ON "mailbox_items" ("mailbox_id", "folder_id", "created_at", "id") WHERE "folder_id" IS NOT NULL AND "trashed_at" IS NULL;
