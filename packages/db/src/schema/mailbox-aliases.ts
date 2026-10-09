import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { domains } from "./domains.js";
import { mailboxes } from "./mailboxes.js";

/**
 * An extra address that delivers into one mailbox on the same domain, e.g.
 * support@ into jean@. Receiving lists it in the SES rules beside the
 * mailbox's own address; inbound mail to it lands in that mailbox.
 */
export const mailboxAliases = pgTable(
  "mailbox_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    mailboxId: uuid("mailbox_id").notNull(),
    domainId: uuid("domain_id").notNull(),
    address: text("address").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_aliases_box_team_fk",
      columns: [t.mailboxId, t.teamId],
      foreignColumns: [mailboxes.id, mailboxes.teamId],
    }).onDelete("cascade"),
    foreignKey({
      name: "mailbox_aliases_domain_team_fk",
      columns: [t.domainId, t.teamId],
      foreignColumns: [domains.id, domains.teamId],
    }).onDelete("cascade"),
    uniqueIndex("mailbox_aliases_address_idx").on(t.address),
    index("mailbox_aliases_mailbox_idx").on(t.mailboxId),
    check(
      "mailbox_aliases_address_check",
      sql`${t.address} = lower(${t.address}) and length(${t.address}) between 3 and 254`,
    ),
  ],
);
