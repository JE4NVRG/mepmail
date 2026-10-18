import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
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

/**
 * The structured email signature of a mailbox. Every field may be empty;
 * `logoUrl` is set only by the logo upload route (an https URL in our public
 * storage), never from client input.
 */
export interface MailboxSignatureProfile {
  version: 1;
  name: string;
  title: string;
  company: string;
  phone: string;
  website: string;
  logoUrl: string | null;
  /** Pixel size of the stored logo, so mail clients get explicit width/height. */
  logoWidth: number | null;
  logoHeight: number | null;
}

/** Registry only: planned does not assert inbound, SMTP or client provisioning. */
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // Null only for an external account (origin 'external', mailbox-drizzle 0034).
    domainId: uuid("domain_id").references(() => domains.id, { onDelete: "restrict" }),
    /** 'domain': a Correio address on a team domain; 'external': a connected Gmail/iCloud/IMAP account. */
    origin: text("origin").$type<"domain" | "external">().notNull().default("domain"),
    address: text("address").notNull(),
    label: text("label").notNull(),
    signatureText: text("signature_text").notNull().default(""),
    signatureProfile: jsonb("signature_profile").$type<MailboxSignatureProfile>(),
    kind: text("kind").$type<"person" | "agent">().notNull(),
    // Keep the registry if its responsible account is deleted. A team admin must reassign it.
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    ownerMembershipId: uuid("owner_membership_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<"planned" | "suspended">().notNull().default("planned"),
    // Excluir caixa (mailbox-drizzle 0031): suspended, out of the seat count and restorable
    // until deleteAfter; then the worker erases it. statusBeforeDeletion is what a restore
    // puts back.
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
    deletionRequestedBy: text("deletion_requested_by").references(() => user.id, {
      onDelete: "set null",
    }),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    statusBeforeDeletion: text("status_before_deletion").$type<"planned" | "suspended">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A Correio address is unique everywhere; a connected account only within its team.
    uniqueIndex("mailboxes_address_idx").on(t.address).where(sql`${t.origin} = 'domain'`),
    uniqueIndex("mailboxes_external_address_idx")
      .on(t.teamId, t.address)
      .where(sql`${t.origin} = 'external'`),
    unique("mailboxes_id_team_unique").on(t.id, t.teamId),
    foreignKey({
      name: "mailboxes_domain_team_fk",
      columns: [t.domainId, t.teamId],
      foreignColumns: [domains.id, domains.teamId],
    }).onDelete("restrict"),
    index("mailboxes_team_created_idx").on(t.teamId, t.createdAt),
    index("mailboxes_delete_after_idx").on(t.deleteAfter).where(sql`${t.deleteAfter} is not null`),
    check("mailboxes_kind_check", sql`${t.kind} in ('person', 'agent')`),
    check(
      "mailboxes_origin_check",
      sql`${t.origin} in ('domain', 'external') and (${t.origin} = 'domain') = (${t.domainId} is not null)`,
    ),
    check("mailboxes_status_check", sql`${t.status} in ('planned', 'suspended')`),
    check(
      "mailboxes_deletion_check",
      sql`(${t.deletionRequestedAt} is null) = (${t.deleteAfter} is null) and (${t.deleteAfter} is null) = (${t.statusBeforeDeletion} is null) and (${t.deleteAfter} is null or (${t.status} = 'suspended' and ${t.statusBeforeDeletion} in ('planned', 'suspended') and ${t.deleteAfter} > ${t.deletionRequestedAt}))`,
    ),
    check("mailboxes_signature_text_check", sql`char_length(${t.signatureText}) <= 4000`),
    check(
      "mailboxes_signature_profile_check",
      sql`${t.signatureProfile} is null or (jsonb_typeof(${t.signatureProfile}) = 'object' and octet_length(${t.signatureProfile}::text) <= 2048)`,
    ),
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
    permission: text("permission").$type<"read" | "draft" | "send">().notNull(),
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
    check("mailbox_grants_permission_check", sql`${t.permission} in ('read', 'draft', 'send')`),
  ],
);
