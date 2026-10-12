import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./custom-types.js";
import { mailboxFolders } from "./mailbox-folders.js";
import { mailboxes } from "./mailboxes.js";

/**
 * Regras automáticas: the owner's filters for one mailbox. Receipt files new mail
 * from a sender or a domain in a named folder, the Archive or another mailbox the same
 * person owns, and may mark it read or starred. `matchKey` is an HMAC of the kind and
 * the normalized value scoped to the mailbox; the value itself is sealed so the owner
 * can review the rules.
 */
export const mailboxRules = pgTable(
  "mailbox_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    matchKind: text("match_kind").$type<"sender" | "domain">().notNull(),
    matchKey: bytea("match_key").notNull(),
    matchCiphertext: bytea("match_ciphertext").notNull(),
    matchIv: bytea("match_iv").notNull(),
    matchWrappedDek: bytea("match_wrapped_dek").notNull(),
    matchKeyVersion: integer("match_key_version").notNull(),
    folderId: uuid("folder_id"),
    archive: boolean("archive").notNull().default(false),
    targetMailboxId: uuid("target_mailbox_id"),
    markRead: boolean("mark_read").notNull().default(false),
    star: boolean("star").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_rules_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    foreignKey({
      name: "mailbox_rules_target_team_fk",
      columns: [t.targetMailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    foreignKey({
      name: "mailbox_rules_folder_fk",
      columns: [t.folderId, t.mailboxId, t.teamId],
      foreignColumns: [mailboxFolders.id, mailboxFolders.mailboxId, mailboxFolders.teamId],
    }).onDelete("cascade"),
    uniqueIndex("mailbox_rules_box_key_idx").on(t.mailboxId, t.matchKey),
    index("mailbox_rules_box_updated_idx").on(t.mailboxId, t.updatedAt),
    index("mailbox_rules_target_idx")
      .on(t.targetMailboxId)
      .where(sql`${t.targetMailboxId} is not null`),
    check("mailbox_rules_kind_check", sql`${t.matchKind} in ('sender','domain')`),
    check("mailbox_rules_key_check", sql`octet_length(${t.matchKey}) = 32`),
    check(
      "mailbox_rules_match_check",
      sql`${t.matchKeyVersion} >= 2000000 and octet_length(${t.matchIv}) = 12 and octet_length(${t.matchCiphertext}) between 17 and 1100`,
    ),
    check(
      "mailbox_rules_destination_check",
      sql`((${t.folderId} is not null)::int + ${t.archive}::int + (${t.targetMailboxId} is not null)::int) <= 1`,
    ),
    check(
      "mailbox_rules_action_check",
      sql`${t.folderId} is not null or ${t.archive} or ${t.targetMailboxId} is not null or ${t.markRead} or ${t.star}`,
    ),
    check(
      "mailbox_rules_target_check",
      sql`${t.targetMailboxId} is null or ${t.targetMailboxId} <> ${t.mailboxId}`,
    ),
  ],
);
