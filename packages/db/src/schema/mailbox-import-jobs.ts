import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mailboxes } from "./mailboxes.js";

export interface MailboxImportFolder {
  /** The raw IMAP name used in commands, and the decoded one to show. */
  name: string;
  display: string;
  target: "inbox" | "sent" | "archive" | "folder";
  folderId: string | null;
  uidValidity: number | null;
  lastUid: number;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
}

/**
 * IMAP history imports: where each folder stands, so a job resumes. Never the
 * password, which lives only in the web process while the job runs.
 */
export const mailboxImportJobs = pgTable(
  "mailbox_import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    createdBy: text("created_by").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    username: text("username").notNull(),
    state: text("state")
      .$type<"running" | "done" | "failed" | "interrupted" | "canceled">()
      .notNull()
      .default("running"),
    folders: jsonb("folders").$type<MailboxImportFolder[]>().notNull(),
    imported: integer("imported").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    error: text("error").$type<
      "login" | "network" | "protocol" | "blocked" | "quota" | "not_entitled" | "canceled"
    >(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "mailbox_import_jobs_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    check(
      "mailbox_import_jobs_state_check",
      sql`${t.state} in ('running','done','failed','interrupted','canceled')`,
    ),
    check(
      "mailbox_import_jobs_counts_check",
      sql`${t.imported} >= 0 and ${t.skipped} >= 0 and ${t.failed} >= 0 and ${t.bytes} >= 0 and ${t.port} = 993`,
    ),
    check(
      "mailbox_import_jobs_error_check",
      sql`${t.error} is null or ${t.error} in ('login','network','protocol','blocked','quota','not_entitled','canceled')`,
    ),
    uniqueIndex("mailbox_import_jobs_running_idx")
      .on(t.mailboxId)
      .where(sql`${t.state} = 'running'`),
    index("mailbox_import_jobs_box_idx").on(t.mailboxId, t.startedAt),
  ],
);
