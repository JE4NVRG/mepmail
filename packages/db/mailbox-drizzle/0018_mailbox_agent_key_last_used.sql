-- When an agent credential last authenticated, for the agents page's health badge.
-- Stamped at most every few minutes outside the access locks; NULL = never used.
ALTER TABLE "mailbox_agent_keys" ADD COLUMN "last_used_at" timestamp with time zone;
