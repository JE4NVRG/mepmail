-- Correio search (Jean 2026-10-11): a blind index, one row per message. Mail stays
-- sealed; each word of a field (subject, from, to/cc, body, attachment names) becomes a
-- 64-bit token, an HMAC under a per-team key derived from the master key, so a token
-- matches only when the searcher already has the word and the key, and the table
-- holds no text. The worker fills it within a minute of a message arriving or a draft
-- being saved, and backfills older mail the same way.
-- content_iv is the item's sealing IV when it was indexed: a new IV means new content
-- (a saved draft), while starring, filing or archiving keep it and need no reindex.
-- Quarantined mail is recorded with no tokens and indexed once it is released.
CREATE TABLE "mailbox_search_index" (
  "item_id" uuid PRIMARY KEY NOT NULL,
  "team_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "content_iv" bytea NOT NULL,
  "quarantined" boolean DEFAULT false NOT NULL,
  "key_version" smallint NOT NULL,
  "tokens" bigint[] DEFAULT '{}' NOT NULL,
  "indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_search_index_item_fk" FOREIGN KEY ("item_id", "mailbox_id", "team_id") REFERENCES "mailbox_items"("id", "mailbox_id", "team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_search_index_tokens_check" CHECK (cardinality("tokens") <= 8000),
  CONSTRAINT "mailbox_search_index_key_version_check" CHECK ("key_version" BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE INDEX "mailbox_search_index_tokens_idx" ON "mailbox_search_index" USING gin ("tokens");
--> statement-breakpoint
CREATE INDEX "mailbox_search_index_mailbox_idx" ON "mailbox_search_index" ("mailbox_id");
