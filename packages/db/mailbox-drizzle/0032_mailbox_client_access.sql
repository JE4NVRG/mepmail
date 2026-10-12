-- Correio in mail clients (Jean 2026-10-11): Outlook, Apple Mail, Thunderbird and the
-- Gmail app reach a mailbox over IMAP and SMTP with an app password its owner creates.
-- Only a keyed hash of each password is kept (high-entropy random secrets, looked up by
-- hash like API keys); hint is its last four letters. A password signs in as the owner
-- it was made by and stops working when that person no longer owns the mailbox.
CREATE TABLE "mailbox_app_passwords" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "secret_hash" text NOT NULL,
  "hint" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "mailbox_app_passwords_box_team_fk" FOREIGN KEY ("mailbox_id", "team_id") REFERENCES "mailboxes"("id", "team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_app_passwords_label_check" CHECK (char_length("label") BETWEEN 1 AND 80),
  CONSTRAINT "mailbox_app_passwords_hash_check" CHECK ("secret_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "mailbox_app_passwords_hint_check" CHECK ("hint" ~ '^[a-z]{4}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_app_passwords_hash_idx" ON "mailbox_app_passwords" ("secret_hash");
--> statement-breakpoint
CREATE INDEX "mailbox_app_passwords_box_idx" ON "mailbox_app_passwords" ("mailbox_id", "created_at") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
-- IMAP numbering. Each folder of a mailbox has a UIDVALIDITY and the next UID; a message
-- gets a UID when IMAP first sees it in a folder and loses it when it leaves (archived,
-- moved, trashed), so UIDs only grow and are never reused. folder_key is inbox, sent,
-- drafts, archive, spam, trash or folder:<id>.
CREATE TABLE "mailbox_imap_folders" (
  "mailbox_id" uuid NOT NULL,
  "team_id" uuid NOT NULL,
  "folder_key" text NOT NULL,
  "uid_validity" integer NOT NULL,
  "uid_next" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_imap_folders_pk" PRIMARY KEY ("mailbox_id", "folder_key"),
  CONSTRAINT "mailbox_imap_folders_box_team_fk" FOREIGN KEY ("mailbox_id", "team_id") REFERENCES "mailboxes"("id", "team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_imap_folders_key_check" CHECK ("folder_key" IN ('inbox', 'sent', 'drafts', 'archive', 'spam', 'trash') OR "folder_key" ~ '^folder:[0-9a-f-]{36}$'),
  CONSTRAINT "mailbox_imap_folders_uid_check" CHECK ("uid_validity" > 0 AND "uid_next" BETWEEN 1 AND 2147483647)
);
--> statement-breakpoint
CREATE TABLE "mailbox_imap_uids" (
  "mailbox_id" uuid NOT NULL,
  "team_id" uuid NOT NULL,
  "folder_key" text NOT NULL,
  "uid" integer NOT NULL,
  "item_id" uuid NOT NULL,
  CONSTRAINT "mailbox_imap_uids_pk" PRIMARY KEY ("mailbox_id", "folder_key", "uid"),
  CONSTRAINT "mailbox_imap_uids_folder_fk" FOREIGN KEY ("mailbox_id", "folder_key") REFERENCES "mailbox_imap_folders"("mailbox_id", "folder_key") ON DELETE CASCADE,
  CONSTRAINT "mailbox_imap_uids_item_fk" FOREIGN KEY ("item_id", "mailbox_id", "team_id") REFERENCES "mailbox_items"("id", "mailbox_id", "team_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_imap_uids_item_idx" ON "mailbox_imap_uids" ("mailbox_id", "folder_key", "item_id");
--> statement-breakpoint
CREATE INDEX "mailbox_imap_uids_item_lookup_idx" ON "mailbox_imap_uids" ("item_id");
