-- A team credential minted by an OAuth consent: bound to the MCP client the person
-- approved. Its secret is never returned; the API reaches it through the verified
-- grant (user, team, client), never as a bearer.
ALTER TABLE "mailbox_agent_keys" ADD COLUMN "oauth_client_id" text;
--> statement-breakpoint
ALTER TABLE "mailbox_agent_keys" ADD CONSTRAINT "mailbox_agent_keys_oauth_group_check" CHECK ("oauth_client_id" IS NULL OR "group_id" IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "mailbox_agent_keys_oauth_idx" ON "mailbox_agent_keys" ("team_id", "owner_user_id", "oauth_client_id") WHERE "oauth_client_id" IS NOT NULL;
