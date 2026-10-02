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
import { bytea } from "./custom-types.js";
import { mailboxItems } from "./mailbox-items.js";
import { mailboxes } from "./mailboxes.js";

/** Private, immutable submitted revision. Jobs carry only this row's ID.
 * On acceptance the envelope moves to mailbox_items with the same ID/binding;
 * metadata remains here and the duplicate binary payload is cleared atomically.
 */
export const mailboxOutbox = pgTable(
  "mailbox_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    draftId: uuid("draft_id").notNull(),
    draftRevision: integer("draft_revision").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedMembershipId: uuid("approved_membership_id").notNull(),
    approvalKind: text("approval_kind").$type<"human" | "agent">().notNull().default("human"),
    // Immutable provenance, deliberately without a credential FK. Deleted credentials fail
    // authorization closed instead of losing the ID or becoming human-approved messages.
    agentKeyId: uuid("agent_key_id"),
    recipientCount: integer("recipient_count").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    rawBytes: integer("raw_bytes").notNull(),
    rawSha256: text("raw_sha256").notNull(),
    ciphertext: bytea("ciphertext"),
    iv: bytea("iv"),
    wrappedDek: bytea("wrapped_dek"),
    keyVersion: integer("key_version"),
    status: text("status")
      .$type<"queued" | "sending" | "accepted" | "unknown" | "failed">()
      .notNull()
      .default("queued"),
    attemptId: uuid("attempt_id"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_outbox_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    foreignKey({
      name: "mailbox_outbox_draft_box_team_fk",
      columns: [t.draftId, t.mailboxId, t.teamId],
      foreignColumns: [mailboxItems.id, mailboxItems.mailboxId, mailboxItems.teamId],
    }).onDelete("restrict"),
    uniqueIndex("mailbox_outbox_draft_revision_idx").on(t.mailboxId, t.draftId, t.draftRevision),
    index("mailbox_outbox_pending_idx").on(t.status, t.createdAt, t.id),
    index("mailbox_outbox_period_idx").on(t.mailboxId, t.periodStart),
    check(
      "mailbox_outbox_status_check",
      sql`${t.status} in ('queued','sending','accepted','unknown','failed')`,
    ),
    check("mailbox_outbox_revision_check", sql`${t.draftRevision} >= 1`),
    check(
      "mailbox_outbox_approval_check",
      sql`(${t.approvalKind} = 'human' and ${t.agentKeyId} is null) or (${t.approvalKind} = 'agent' and ${t.agentKeyId} is not null)`,
    ),
    check("mailbox_outbox_recipients_check", sql`${t.recipientCount} between 1 and 20`),
    check("mailbox_outbox_period_check", sql`${t.periodEnd} > ${t.periodStart}`),
    check(
      "mailbox_outbox_raw_check",
      sql`${t.rawBytes} between 1 and 1048576 and ${t.rawSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "mailbox_outbox_attempt_check",
      sql`(${t.status} = 'queued' and ${t.attemptId} is null and ${t.attemptedAt} is null) or (${t.status} = 'failed') or (${t.attemptId} is not null and ${t.attemptedAt} is not null)`,
    ),
    check(
      "mailbox_outbox_payload_check",
      sql`(${t.status} = 'accepted' and ${t.ciphertext} is null and ${t.iv} is null and ${t.wrappedDek} is null and ${t.keyVersion} is null and ${t.providerMessageId} is not null and ${t.acceptedAt} is not null) or (${t.status} <> 'accepted' and ${t.ciphertext} is not null and ${t.iv} is not null and ${t.wrappedDek} is not null and ${t.keyVersion} >= 2000000 and octet_length(${t.iv}) = 12 and octet_length(${t.ciphertext}) between 17 and 1048592)`,
    ),
  ],
);
