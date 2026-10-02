CREATE TABLE "mailbox_agent_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "mailbox_id" uuid NOT NULL,
  "owner_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "owner_membership_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "label" text NOT NULL,
  "scopes" text[] NOT NULL,
  "key_hash" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  CONSTRAINT "mailbox_agent_keys_box_team_fk" FOREIGN KEY ("mailbox_id","team_id") REFERENCES "mailboxes"("id","team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_agent_keys_hash_check" CHECK ("key_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "mailbox_agent_keys_label_check" CHECK (length("label") BETWEEN 1 AND 80),
  CONSTRAINT "mailbox_agent_keys_scopes_check" CHECK (cardinality("scopes") BETWEEN 1 AND 3 AND "scopes" <@ ARRAY['read','draft','send']::text[] AND array_position("scopes", NULL) IS NULL),
  CONSTRAINT "mailbox_agent_keys_expiry_check" CHECK ("expires_at" IS NULL OR "expires_at" > "created_at")
);
--> statement-breakpoint
CREATE INDEX "mailbox_agent_keys_box_created_idx" ON "mailbox_agent_keys"("mailbox_id","created_at");
