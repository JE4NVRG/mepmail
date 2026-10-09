-- Folder color and manual order, and per-person inbox preferences. Presentation
-- only: no content, grants or delivery state. Existing folders keep the order
-- they had (by name) as their starting positions.
ALTER TABLE "mailbox_folders" ADD COLUMN "color" text;
--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "mailbox_folders" AS f SET "position" = ranked.n
FROM (
  SELECT "id", (row_number() OVER (PARTITION BY "mailbox_id" ORDER BY lower("name"), "id") - 1)::int AS n
  FROM "mailbox_folders"
  WHERE "archived_at" IS NULL
) AS ranked
WHERE f."id" = ranked."id";
--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD CONSTRAINT "mailbox_folders_color_check" CHECK ("color" IS NULL OR "color" IN ('violet','blue','green','amber','red','pink','teal','gray'));
--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD CONSTRAINT "mailbox_folders_position_check" CHECK ("position" BETWEEN 0 AND 10000);
--> statement-breakpoint
CREATE TABLE "mailbox_user_preferences" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_user_preferences_object_check" CHECK (jsonb_typeof("preferences") = 'object' AND octet_length("preferences"::text) <= 4096)
);
