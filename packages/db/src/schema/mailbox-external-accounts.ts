import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./custom-types.js";
import { mailboxes } from "./mailboxes.js";

export type MailboxExternalProvider = "gmail" | "icloud" | "yahoo" | "zoho" | "outlook" | "imap";
export type MailboxExternalAuth = "password" | "oauth_microsoft" | "oauth_google";
export type MailboxExternalStatus = "active" | "auth_failed" | "error" | "paused";

/** Where the INBOX sync stands: UIDs seen are only meaningful under one UIDVALIDITY. */
export interface MailboxExternalSyncState {
  inbox?: { uidValidity: number; lastUid: number };
}

/**
 * Contas externas (mailbox-drizzle 0034): the IMAP/SMTP account behind an `origin =
 * 'external'` mailbox. The secret (an app password, later an OAuth refresh token) is
 * sealed with encryptPayload (binding mailbox-external-account-v1:<mailboxId>) and never
 * leaves the server once saved.
 */
export const mailboxExternalAccounts = pgTable(
  "mailbox_external_accounts",
  {
    mailboxId: uuid("mailbox_id").primaryKey(),
    teamId: uuid("team_id").notNull(),
    provider: text("provider").$type<MailboxExternalProvider>().notNull(),
    auth: text("auth").$type<MailboxExternalAuth>().notNull().default("password"),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull().default(993),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    smtpSecurity: text("smtp_security").$type<"tls" | "starttls">().notNull(),
    username: text("username").notNull(),
    secretCiphertext: bytea("secret_ciphertext").notNull(),
    secretIv: bytea("secret_iv").notNull(),
    secretWrappedDek: bytea("secret_wrapped_dek").notNull(),
    secretKeyVersion: integer("secret_key_version").notNull(),
    syncState: jsonb("sync_state").$type<MailboxExternalSyncState>().notNull().default({}),
    status: text("status").$type<MailboxExternalStatus>().notNull().default("active"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_external_accounts_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    index("mailbox_external_accounts_due_idx").on(t.nextSyncAt).where(sql`${t.status} = 'active'`),
    index("mailbox_external_accounts_team_idx").on(t.teamId),
    check(
      "mailbox_external_accounts_provider_check",
      sql`${t.provider} in ('gmail', 'icloud', 'yahoo', 'zoho', 'outlook', 'imap')`,
    ),
    check(
      "mailbox_external_accounts_auth_check",
      sql`${t.auth} in ('password', 'oauth_microsoft', 'oauth_google')`,
    ),
    check(
      "mailbox_external_accounts_status_check",
      sql`${t.status} in ('active', 'auth_failed', 'error', 'paused')`,
    ),
  ],
);
