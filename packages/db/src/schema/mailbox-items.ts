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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { bytea } from "./custom-types.js";
import { mailboxFolders } from "./mailbox-folders.js";
import { mailboxes } from "./mailboxes.js";

/** Why a scheduled send did not go out when it came due (the draft stays a draft). */
export type MailboxScheduledSendFailure =
  | "forbidden"
  | "not_entitled"
  | "conflict"
  | "invalid"
  | "not_found";
export type MailboxVerdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED" | "UNKNOWN";
export type MailboxSafetyReason =
  | "spam"
  | "spam_uncertain"
  | "spam_unchecked"
  | "sender_policy"
  | "sender_authentication"
  | "virus"
  | "virus_unchecked";
export interface MailboxInboundAssessment {
  version: 1;
  decision: "inbox" | "spam" | "quarantine";
  verdicts: Record<"virus" | "spam" | "spf" | "dkim" | "dmarc", MailboxVerdict>;
  dmarcPolicy: "none" | "quarantine" | "reject" | null;
  reasons: MailboxSafetyReason[];
}

/** Private local persistence contract. No transport, delivery or public blob URLs. */
export const mailboxItems = pgTable(
  "mailbox_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    kind: text("kind").$type<"inbox" | "draft" | "sent">().notNull(),
    deliveryFolder: text("delivery_folder")
      .$type<"inbox" | "spam" | "quarantine">()
      .notNull()
      .default("inbox"),
    inboundAssessment: jsonb("inbound_assessment").$type<MailboxInboundAssessment>(),
    // Soft trash retains original kind, safety classification, MIME and storage usage.
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    starredAt: timestamp("starred_at", { withTimezone: true }),
    // When the mailbox owner first read it; null = unread. Not content: no revision bump.
    seenAt: timestamp("seen_at", { withTimezone: true }),
    // Archived items leave the inbox for the Archive view; archiving clears folderId.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    folderId: uuid("folder_id"),
    // Snoozed: out of every view but "Adiadas" until this time, then back in the inbox,
    // unread and on top (resurfacedAt orders it). Received messages only.
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    resurfacedAt: timestamp("resurfaced_at", { withTimezone: true }),
    // Pinned to the top of the inbox by its owner.
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    // Send later (drafts only): due at sendAt; the person who scheduled it must still own
    // the mailbox, with license, plan and seat, when the worker admits it.
    sendAt: timestamp("send_at", { withTimezone: true }),
    sendScheduledBy: text("send_scheduled_by").references(() => user.id, {
      onDelete: "set null",
    }),
    sendClaimedAt: timestamp("send_claimed_at", { withTimezone: true }),
    sendFailure: text("send_failure").$type<MailboxScheduledSendFailure>(),
    // Follow-up (sent only): check for a reply at remindAt; remindedAt marks it due.
    remindAt: timestamp("remind_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    sourceId: text("source_id"),
    // Digests of this message's Message-ID and of its conversation's root (mailbox-thread.ts).
    messageKey: text("message_key"),
    threadKey: text("thread_key"),
    revision: integer("revision").notNull().default(1),
    rawBytes: integer("raw_bytes").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    wrappedDek: bytea("wrapped_dek").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_items_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    uniqueIndex("mailbox_items_source_idx")
      .on(t.mailboxId, t.sourceId)
      .where(sql`${t.sourceId} is not null`),
    uniqueIndex("mailbox_items_id_box_team_idx").on(t.id, t.mailboxId, t.teamId),
    index("mailbox_items_thread_idx")
      .on(t.mailboxId, t.threadKey)
      .where(sql`${t.threadKey} is not null`),
    foreignKey({
      name: "mailbox_items_named_folder_fk",
      columns: [t.folderId, t.mailboxId, t.teamId],
      foreignColumns: [mailboxFolders.id, mailboxFolders.mailboxId, mailboxFolders.teamId],
    }).onDelete("restrict"),
    index("mailbox_items_starred_created_idx")
      .on(t.mailboxId, t.createdAt, t.id)
      .where(sql`${t.starredAt} is not null and ${t.trashedAt} is null`),
    index("mailbox_items_named_folder_created_idx")
      .on(t.mailboxId, t.folderId, t.createdAt, t.id)
      .where(sql`${t.folderId} is not null and ${t.trashedAt} is null`),
    index("mailbox_items_box_created_idx").on(t.mailboxId, t.createdAt, t.id),
    index("mailbox_items_unseen_inbox_idx")
      .on(t.mailboxId)
      .where(
        sql`${t.kind} = 'inbox' and ${t.seenAt} is null and ${t.trashedAt} is null and ${t.archivedAt} is null`,
      ),
    index("mailbox_items_archived_created_idx")
      .on(t.mailboxId, t.createdAt, t.id)
      .where(sql`${t.archivedAt} is not null and ${t.trashedAt} is null`),
    index("mailbox_items_trash_created_idx")
      .on(t.mailboxId, t.trashedAt, t.id)
      .where(sql`${t.trashedAt} is not null`),
    index("mailbox_items_folder_created_idx").on(
      t.mailboxId,
      t.kind,
      t.deliveryFolder,
      t.createdAt,
      t.id,
    ),
    // The order received messages are listed in once a snoozed one can resurface.
    index("mailbox_items_folder_order_idx").on(
      t.mailboxId,
      t.kind,
      t.deliveryFolder,
      sql`coalesce(${t.resurfacedAt}, ${t.createdAt})`,
      t.id,
    ),
    index("mailbox_items_snoozed_idx").on(t.snoozedUntil).where(sql`${t.snoozedUntil} is not null`),
    index("mailbox_items_pinned_idx")
      .on(t.mailboxId)
      .where(sql`${t.pinnedAt} is not null and ${t.trashedAt} is null`),
    index("mailbox_items_send_at_idx").on(t.sendAt).where(sql`${t.sendAt} is not null`),
    index("mailbox_items_remind_at_idx")
      .on(t.remindAt)
      .where(sql`${t.remindAt} is not null and ${t.remindedAt} is null`),
    index("mailbox_items_reminded_idx")
      .on(t.mailboxId, t.remindedAt)
      .where(sql`${t.remindedAt} is not null`),
    check(
      "mailbox_items_folder_check",
      sql`${t.deliveryFolder} in ('inbox','spam','quarantine') and (${t.kind} = 'inbox' or (${t.deliveryFolder} = 'inbox' and ${t.inboundAssessment} is null))`,
    ),
    check(
      "mailbox_items_quarantine_check",
      sql`coalesce((${t.deliveryFolder} = 'quarantine') = (${t.inboundAssessment}->>'decision' = 'quarantine'), ${t.deliveryFolder} <> 'quarantine')`,
    ),
    check("mailbox_items_kind_check", sql`${t.kind} in ('inbox', 'draft', 'sent')`),
    check(
      "mailbox_items_snooze_check",
      sql`(${t.snoozedUntil} is null and ${t.resurfacedAt} is null) or ${t.kind} = 'inbox'`,
    ),
    check(
      "mailbox_items_send_later_check",
      sql`(${t.sendAt} is null and ${t.sendClaimedAt} is null and ${t.sendFailure} is null) or (${t.kind} = 'draft' and (${t.sendAt} is not null or ${t.sendClaimedAt} is null) and (${t.sendFailure} is null or ${t.sendFailure} in ('forbidden','not_entitled','conflict','invalid','not_found')))`,
    ),
    check(
      "mailbox_items_follow_up_check",
      sql`(${t.remindAt} is null and ${t.remindedAt} is null) or ${t.kind} = 'sent'`,
    ),
    check(
      "mailbox_items_source_check",
      sql`(${t.kind} in ('inbox', 'sent') and ${t.sourceId} is not null and length(${t.sourceId}) between 1 and 128) or (${t.kind} = 'draft' and ${t.sourceId} is null)`,
    ),
    check("mailbox_items_revision_check", sql`${t.revision} >= 1`),
    check("mailbox_items_raw_bytes_check", sql`${t.rawBytes} between 1 and 1048576`),
    check(
      "mailbox_items_envelope_check",
      sql`${t.keyVersion} >= 2000000 and octet_length(${t.iv}) = 12 and octet_length(${t.ciphertext}) between 17 and 1048592`,
    ),
  ],
);
