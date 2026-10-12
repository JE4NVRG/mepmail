import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { mailboxItems } from "./mailbox-items.js";
import { mailboxes } from "./mailboxes.js";

/**
 * App passwords (mailbox-drizzle 0032): what Outlook, Apple Mail, Thunderbird or the Gmail
 * app use to reach a mailbox over IMAP and SMTP. Only a keyed hash of each password is
 * kept; it signs in as the owner who made it and stops working when they no longer own
 * the mailbox.
 */
export const mailboxAppPasswords = pgTable(
  "mailbox_app_passwords",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    secretHash: text("secret_hash").notNull(),
    hint: text("hint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "mailbox_app_passwords_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    uniqueIndex("mailbox_app_passwords_hash_idx").on(t.secretHash),
    index("mailbox_app_passwords_box_idx")
      .on(t.mailboxId, t.createdAt)
      .where(sql`${t.revokedAt} is null`),
    check("mailbox_app_passwords_label_check", sql`char_length(${t.label}) between 1 and 80`),
    check("mailbox_app_passwords_hash_check", sql`${t.secretHash} ~ '^[a-f0-9]{64}$'`),
    check("mailbox_app_passwords_hint_check", sql`${t.hint} ~ '^[a-z]{4}$'`),
  ],
);

/** IMAP numbering per folder of a mailbox: UIDVALIDITY and the next UID. */
export const mailboxImapFolders = pgTable(
  "mailbox_imap_folders",
  {
    mailboxId: uuid("mailbox_id").notNull(),
    teamId: uuid("team_id").notNull(),
    folderKey: text("folder_key").notNull(),
    uidValidity: integer("uid_validity").notNull(),
    uidNext: integer("uid_next").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "mailbox_imap_folders_pk", columns: [t.mailboxId, t.folderKey] }),
    foreignKey({
      name: "mailbox_imap_folders_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
  ],
);

/** A message's UID in one folder, from when IMAP first saw it there until it leaves. */
export const mailboxImapUids = pgTable(
  "mailbox_imap_uids",
  {
    mailboxId: uuid("mailbox_id").notNull(),
    teamId: uuid("team_id").notNull(),
    folderKey: text("folder_key").notNull(),
    uid: integer("uid").notNull(),
    itemId: uuid("item_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "mailbox_imap_uids_pk", columns: [t.mailboxId, t.folderKey, t.uid] }),
    foreignKey({
      name: "mailbox_imap_uids_folder_fk",
      columns: [t.mailboxId, t.folderKey],
      foreignColumns: [mailboxImapFolders.mailboxId, mailboxImapFolders.folderKey],
    }).onDelete("cascade"),
    foreignKey({
      name: "mailbox_imap_uids_item_fk",
      columns: [t.itemId, t.mailboxId, t.teamId],
      foreignColumns: [mailboxItems.id, mailboxItems.mailboxId, mailboxItems.teamId],
    }).onDelete("cascade"),
    uniqueIndex("mailbox_imap_uids_item_idx").on(t.mailboxId, t.folderKey, t.itemId),
    index("mailbox_imap_uids_item_lookup_idx").on(t.itemId),
  ],
);
