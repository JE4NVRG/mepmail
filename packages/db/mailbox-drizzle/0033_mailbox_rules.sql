-- Regras automáticas (Jean 2026-10-12): the owner's filters for one mailbox. New mail
-- from a sender (exact address) or a domain (and its subdomains) is filed at receipt in
-- a named folder, the Archive or another mailbox the same person owns, and may be marked
-- read or starred. Mail the provider or the sender screen sends to Spam or Quarantine is
-- never moved. No address or domain in the clear: match_key is an HMAC scoped to the
-- mailbox (derived from the sender key), and the value is sealed like message content so
-- the owner can review the rules.
CREATE TABLE "mailbox_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "match_kind" text NOT NULL,
  "match_key" bytea NOT NULL,
  "match_ciphertext" bytea NOT NULL,
  "match_iv" bytea NOT NULL,
  "match_wrapped_dek" bytea NOT NULL,
  "match_key_version" integer NOT NULL,
  "folder_id" uuid,
  "archive" boolean DEFAULT false NOT NULL,
  "target_mailbox_id" uuid,
  "mark_read" boolean DEFAULT false NOT NULL,
  "star" boolean DEFAULT false NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_rules_box_team_fk" FOREIGN KEY ("mailbox_id", "team_id") REFERENCES "mailboxes"("id", "team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_rules_target_team_fk" FOREIGN KEY ("target_mailbox_id", "team_id") REFERENCES "mailboxes"("id", "team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_rules_folder_fk" FOREIGN KEY ("folder_id", "mailbox_id", "team_id") REFERENCES "mailbox_folders"("id", "mailbox_id", "team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_rules_kind_check" CHECK ("match_kind" IN ('sender', 'domain')),
  CONSTRAINT "mailbox_rules_key_check" CHECK (octet_length("match_key") = 32),
  CONSTRAINT "mailbox_rules_match_check" CHECK ("match_key_version" >= 2000000 AND octet_length("match_iv") = 12 AND octet_length("match_ciphertext") BETWEEN 17 AND 1100),
  CONSTRAINT "mailbox_rules_destination_check" CHECK ((("folder_id" IS NOT NULL)::int + "archive"::int + ("target_mailbox_id" IS NOT NULL)::int) <= 1),
  CONSTRAINT "mailbox_rules_action_check" CHECK ("folder_id" IS NOT NULL OR "archive" OR "target_mailbox_id" IS NOT NULL OR "mark_read" OR "star"),
  CONSTRAINT "mailbox_rules_target_check" CHECK ("target_mailbox_id" IS NULL OR "target_mailbox_id" <> "mailbox_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_rules_box_key_idx" ON "mailbox_rules" ("mailbox_id", "match_key");
--> statement-breakpoint
CREATE INDEX "mailbox_rules_box_updated_idx" ON "mailbox_rules" ("mailbox_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "mailbox_rules_target_idx" ON "mailbox_rules" ("target_mailbox_id") WHERE "target_mailbox_id" IS NOT NULL;
