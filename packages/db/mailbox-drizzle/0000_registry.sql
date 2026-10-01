-- Optional mailbox registry. Separate ledger; never applies billing/main migrations.
ALTER TABLE "domains" ADD CONSTRAINT "domains_id_team_unique" UNIQUE ("id","team_id");
--> statement-breakpoint
CREATE TABLE "mailboxes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "domain_id" uuid NOT NULL REFERENCES "domains"("id") ON DELETE RESTRICT,
  "address" text NOT NULL,
  "label" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('person','agent')),
  "owner_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "owner_membership_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "status" text DEFAULT 'planned' NOT NULL CHECK ("status" IN ('planned','suspended')),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mailboxes_id_team_unique" UNIQUE ("id","team_id"),
  CONSTRAINT "mailboxes_domain_team_fk" FOREIGN KEY ("domain_id","team_id") REFERENCES "domains"("id","team_id") ON DELETE RESTRICT,
  CONSTRAINT "mailboxes_address_check" CHECK ("address" = lower("address") AND length("address") <= 254)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_address_idx" ON "mailboxes"("address");
--> statement-breakpoint
CREATE INDEX "mailboxes_team_created_idx" ON "mailboxes"("team_id","created_at");
--> statement-breakpoint
CREATE TABLE "mailbox_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "mailbox_id" uuid NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "membership_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "permission" text NOT NULL CHECK ("permission" IN ('read','draft')),
  "granted_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "mailbox_grants_box_team_fk" FOREIGN KEY ("mailbox_id","team_id") REFERENCES "mailboxes"("id","team_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_grants_active_idx" ON "mailbox_grants"("mailbox_id","user_id") WHERE "revoked_at" IS NULL;
