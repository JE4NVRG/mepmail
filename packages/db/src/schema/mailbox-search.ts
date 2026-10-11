import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  smallint,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./custom-types.js";
import { mailboxItems } from "./mailbox-items.js";

/**
 * Correio search: a blind index, one row per message (mailbox-drizzle 0030). Tokens are
 * 64-bit HMACs of field + word under a per-team key; the table holds no text. content_iv
 * is the item's sealing IV when it was indexed, so only new content is reindexed.
 */
export const mailboxSearchIndex = pgTable(
  "mailbox_search_index",
  {
    itemId: uuid("item_id").primaryKey(),
    teamId: uuid("team_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    contentIv: bytea("content_iv").notNull(),
    quarantined: boolean("quarantined").notNull().default(false),
    keyVersion: smallint("key_version").notNull(),
    tokens: bigint("tokens", { mode: "bigint" }).array().notNull().default(sql`'{}'`),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_search_index_item_fk",
      columns: [t.itemId, t.mailboxId, t.teamId],
      foreignColumns: [mailboxItems.id, mailboxItems.mailboxId, mailboxItems.teamId],
    }).onDelete("cascade"),
    check("mailbox_search_index_tokens_check", sql`cardinality(${t.tokens}) <= 8000`),
    check("mailbox_search_index_key_version_check", sql`${t.keyVersion} BETWEEN 1 AND 1000`),
    index("mailbox_search_index_tokens_idx").using("gin", t.tokens),
    index("mailbox_search_index_mailbox_idx").on(t.mailboxId),
  ],
);
