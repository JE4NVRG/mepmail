import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { teams } from "./teams.js";

/** One durable first-Customer request. An ambiguous provider call cannot be retried by TTL. */
export const mailboxCustomerRequests = pgTable(
  "mailbox_customer_requests",
  {
    teamId: uuid("team_id")
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    status: text("status").$type<"creating" | "ready">().notNull().default("creating"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    livemode: boolean("livemode").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mailbox_customer_requests_key_idx").on(t.idempotencyKey),
    uniqueIndex("mailbox_customer_requests_customer_idx")
      .on(t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} is not null`),
    check("mailbox_customer_requests_status_check", sql`${t.status} in ('creating','ready')`),
    check(
      "mailbox_customer_requests_ready_check",
      sql`${t.status} <> 'ready' or ${t.stripeCustomerId} is not null`,
    ),
  ],
);
