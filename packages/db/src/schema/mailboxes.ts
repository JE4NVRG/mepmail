import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { teamMembers, user } from "./auth.js";
import { domains } from "./domains.js";
import { teams } from "./teams.js";

/** Registry only: planned does not assert inbound, SMTP or client provisioning. */
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    address: text("address").notNull(),
    label: text("label").notNull(),
    signatureText: text("signature_text").notNull().default(""),
    kind: text("kind").$type<"person" | "agent">().notNull(),
    // Keep the registry if its responsible account is deleted. A team admin must reassign it.
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    ownerMembershipId: uuid("owner_membership_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<"planned" | "suspended">().notNull().default("planned"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mailboxes_address_idx").on(t.address),
    unique("mailboxes_id_team_unique").on(t.id, t.teamId),
    foreignKey({
      name: "mailboxes_domain_team_fk",
      columns: [t.domainId, t.teamId],
      foreignColumns: [domains.id, domains.teamId],
    }).onDelete("restrict"),
    index("mailboxes_team_created_idx").on(t.teamId, t.createdAt),
    check("mailboxes_kind_check", sql`${t.kind} in ('person', 'agent')`),
    check("mailboxes_status_check", sql`${t.status} in ('planned', 'suspended')`),
    check("mailboxes_signature_text_check", sql`char_length(${t.signatureText}) <= 4000`),
    check(
      "mailboxes_address_check",
      sql`${t.address} = lower(${t.address}) and length(${t.address}) <= 254`,
    ),
  ],
);

/** Human delegation. API/MCP credentials gain no implicit access from this registry. */
export const mailboxGrants = pgTable(
  "mailbox_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").references(() => teamMembers.id, { onDelete: "set null" }),
    permission: text("permission").$type<"read" | "draft">().notNull(),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "mailbox_grants_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    uniqueIndex("mailbox_grants_active_idx")
      .on(t.mailboxId, t.userId)
      .where(sql`${t.revokedAt} is null`),
    check("mailbox_grants_permission_check", sql`${t.permission} in ('read', 'draft')`),
  ],
);
