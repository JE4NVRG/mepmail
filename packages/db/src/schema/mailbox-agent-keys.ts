import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { teamMembers, user } from "./auth.js";
import { mailboxes } from "./mailboxes.js";
import { teams } from "./teams.js";

/** A machine credential is bound to one mailbox and the authorizing owner's membership. */
export const mailboxAgentKeys = pgTable(
  "mailbox_agent_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Membership deletion leaves an unusable historical credential; a new membership cannot revive it.
    ownerMembershipId: uuid("owner_membership_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    label: text("label").notNull(),
    scopes: text("scopes").array().$type<Array<"read" | "draft" | "send">>().notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "mailbox_agent_keys_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    index("mailbox_agent_keys_box_created_idx").on(t.mailboxId, t.createdAt),
    check("mailbox_agent_keys_hash_check", sql`${t.keyHash} ~ '^[a-f0-9]{64}$'`),
    check("mailbox_agent_keys_label_check", sql`length(${t.label}) between 1 and 80`),
    check(
      "mailbox_agent_keys_scopes_check",
      sql`cardinality(${t.scopes}) between 1 and 3 and ${t.scopes} <@ ARRAY['read','draft','send']::text[] and array_position(${t.scopes}, NULL) is null`,
    ),
    check(
      "mailbox_agent_keys_expiry_check",
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.createdAt}`,
    ),
  ],
);
