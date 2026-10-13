-- Contas externas (Jean 2026-10-13, specs/correio-external-accounts.md): a person's own
-- Gmail, iCloud, Yahoo or other IMAP account read and answered inside the Correio. Such
-- a mailbox has no team domain (origin 'external'); its address may be connected by more
-- than one team, so uniqueness of the address holds only among domain mailboxes. The app
-- password is sealed like message content (encryptPayload, row binding
-- mailbox-external-account-v1:<mailboxId>) and never returned once saved.
ALTER TABLE "mailboxes" ADD COLUMN "origin" text DEFAULT 'domain' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailboxes" ALTER COLUMN "domain_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_origin_check" CHECK ("origin" IN ('domain', 'external') AND ("origin" = 'domain') = ("domain_id" IS NOT NULL));
--> statement-breakpoint
DROP INDEX "mailboxes_address_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_address_idx" ON "mailboxes" ("address") WHERE "origin" = 'domain';
--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_external_address_idx" ON "mailboxes" ("team_id", "address") WHERE "origin" = 'external';
--> statement-breakpoint
CREATE TABLE "mailbox_external_accounts" (
  "mailbox_id" uuid PRIMARY KEY NOT NULL,
  "team_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "auth" text DEFAULT 'password' NOT NULL,
  "imap_host" text NOT NULL,
  "imap_port" integer DEFAULT 993 NOT NULL,
  "smtp_host" text NOT NULL,
  "smtp_port" integer NOT NULL,
  "smtp_security" text NOT NULL,
  "username" text NOT NULL,
  "secret_ciphertext" bytea NOT NULL,
  "secret_iv" bytea NOT NULL,
  "secret_wrapped_dek" bytea NOT NULL,
  "secret_key_version" integer NOT NULL,
  "sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_error" text,
  "last_synced_at" timestamp with time zone,
  "next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_external_accounts_box_team_fk" FOREIGN KEY ("mailbox_id", "team_id") REFERENCES "mailboxes"("id", "team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_external_accounts_provider_check" CHECK ("provider" IN ('gmail', 'icloud', 'yahoo', 'zoho', 'outlook', 'imap')),
  CONSTRAINT "mailbox_external_accounts_auth_check" CHECK ("auth" IN ('password', 'oauth_microsoft', 'oauth_google')),
  CONSTRAINT "mailbox_external_accounts_ports_check" CHECK ("imap_port" = 993 AND "smtp_port" IN (465, 587) AND "smtp_security" IN ('tls', 'starttls') AND ("smtp_port" = 465) = ("smtp_security" = 'tls')),
  CONSTRAINT "mailbox_external_accounts_hosts_check" CHECK (char_length("imap_host") BETWEEN 3 AND 253 AND char_length("smtp_host") BETWEEN 3 AND 253 AND char_length("username") BETWEEN 1 AND 254),
  CONSTRAINT "mailbox_external_accounts_secret_check" CHECK ("secret_key_version" >= 2000000 AND octet_length("secret_iv") = 12 AND octet_length("secret_ciphertext") BETWEEN 17 AND 4200),
  CONSTRAINT "mailbox_external_accounts_status_check" CHECK ("status" IN ('active', 'auth_failed', 'error', 'paused')),
  CONSTRAINT "mailbox_external_accounts_error_check" CHECK ("last_error" IS NULL OR char_length("last_error") <= 64),
  CONSTRAINT "mailbox_external_accounts_state_check" CHECK (jsonb_typeof("sync_state") = 'object' AND octet_length("sync_state"::text) <= 4096)
);
--> statement-breakpoint
CREATE INDEX "mailbox_external_accounts_due_idx" ON "mailbox_external_accounts" ("next_sync_at") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "mailbox_external_accounts_team_idx" ON "mailbox_external_accounts" ("team_id");
