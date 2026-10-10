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
import { mailboxes } from "./mailboxes.js";

/**
 * Aprovação de remetentes: the owner's allow/block answer for one sender of one
 * mailbox. The address is never stored in the clear: `senderKey` is an HMAC
 * of the normalized address (derived from the deployment's master key and
 * scoped to the mailbox) for lookups, and the address itself is sealed like
 * message content so the owner can review the list.
 */
export const mailboxSenderDecisions = pgTable(
  "mailbox_sender_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    senderKey: bytea("sender_key").notNull(),
    decision: text("decision").$type<"allow" | "block">().notNull(),
    addressCiphertext: bytea("address_ciphertext").notNull(),
    addressIv: bytea("address_iv").notNull(),
    addressWrappedDek: bytea("address_wrapped_dek").notNull(),
    addressKeyVersion: integer("address_key_version").notNull(),
    decidedBy: text("decided_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_sender_decisions_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    uniqueIndex("mailbox_sender_decisions_box_sender_idx").on(t.mailboxId, t.senderKey),
    index("mailbox_sender_decisions_box_updated_idx").on(t.mailboxId, t.updatedAt),
    check("mailbox_sender_decisions_decision_check", sql`${t.decision} in ('allow','block')`),
    check("mailbox_sender_decisions_key_check", sql`octet_length(${t.senderKey}) = 32`),
    check(
      "mailbox_sender_decisions_address_check",
      sql`${t.addressKeyVersion} >= 2000000 and octet_length(${t.addressIv}) = 12 and octet_length(${t.addressCiphertext}) between 17 and 1100`,
    ),
  ],
);
