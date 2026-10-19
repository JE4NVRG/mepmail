-- Contas externas: which connection a worker round or a send belongs to. Signing in again
-- (or a new app password) moves the generation forward; a token the provider rotates does
-- not. Results of a round or send opened under an older generation are dropped, so a slow
-- failure never marks the new connection. Accounts in error are picked up again when due.
ALTER TABLE "mailbox_external_accounts" ADD COLUMN "connection_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_external_accounts" ADD CONSTRAINT "mailbox_external_accounts_generation_check" CHECK ("connection_generation" >= 1);
--> statement-breakpoint
DROP INDEX IF EXISTS "mailbox_external_accounts_due_idx";
--> statement-breakpoint
CREATE INDEX "mailbox_external_accounts_due_idx" ON "mailbox_external_accounts" ("next_sync_at") WHERE "status" IN ('active', 'error');
