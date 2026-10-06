import { sql } from "drizzle-orm";
import {
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
import { mailboxes } from "./mailboxes.js";

/** Private names belong to one mailbox. Archive preserves the folder and every message. */
export const mailboxFolders = pgTable(
  "mailbox_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    name: text("name").notNull(),
    revision: integer("revision").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_folders_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("restrict"),
    uniqueIndex("mailbox_folders_id_box_team_idx").on(t.id, t.mailboxId, t.teamId),
    uniqueIndex("mailbox_folders_active_name_idx")
      .on(t.mailboxId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    index("mailbox_folders_box_created_idx").on(t.mailboxId, t.createdAt, t.id),
    check(
      "mailbox_folders_name_check",
      sql`char_length(${t.name}) between 1 and 80 and ${t.name} = btrim(${t.name})`,
    ),
    check("mailbox_folders_revision_check", sql`${t.revision} >= 1`),
  ],
);
