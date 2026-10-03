import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { teams } from "./teams.js";

/** One durable attempt per Mail operation. An ambiguous provider write is read back, never replayed. */
export const mailboxManagementRequests = pgTable(
  "mailbox_management_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    action: text("action").$type<"cancel" | "resume" | "increase" | "decrease">().notNull(),
    status: text("status")
      .$type<"prepared" | "creating" | "pending" | "scheduled" | "confirmed" | "expired">()
      .notNull(),
    step: text("step")
      .$type<"update" | "create_schedule" | "configure_schedule" | "release_schedule">()
      .notNull(),
    seatsBefore: integer("seats_before").notNull(),
    seats: integer("seats").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripeSubscriptionItemId: text("stripe_subscription_item_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    livemode: boolean("livemode").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    previousInvoiceId: text("previous_invoice_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeScheduleId: text("stripe_schedule_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mailbox_management_idempotency_idx").on(t.idempotencyKey),
    uniqueIndex("mailbox_management_open_team_idx")
      .on(t.teamId)
      .where(sql`${t.status} in ('prepared','creating','pending')`),
    check(
      "mailbox_management_action_check",
      sql`${t.action} in ('cancel','resume','increase','decrease')`,
    ),
    check(
      "mailbox_management_status_check",
      sql`${t.status} in ('prepared','creating','pending','scheduled','confirmed','expired')`,
    ),
    check(
      "mailbox_management_step_check",
      sql`${t.step} in ('update','create_schedule','configure_schedule','release_schedule')`,
    ),
    check(
      "mailbox_management_seats_check",
      sql`${t.seats} between 1 and 10000 and ${t.seatsBefore} between 1 and 10000`,
    ),
    check("mailbox_management_period_check", sql`${t.periodEnd} > ${t.periodStart}`),
  ],
);
