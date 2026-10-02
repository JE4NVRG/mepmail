import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/** Mail is billed by mailbox; it never overwrites the team's Send subscription. */
export const mailboxSubscriptions = pgTable(
  "mailbox_subscriptions",
  {
    teamId: uuid("team_id")
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<"inactive" | "trialing" | "active" | "past_due" | "canceled">()
      .notNull()
      .default("inactive"),
    seats: integer("seats").notNull().default(0),
    storageBytesPerMailbox: bigint("storage_bytes_per_mailbox", { mode: "number" }).notNull(),
    includedOutboundPerMailbox: integer("included_outbound_per_mailbox").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    stripeSubscriptionItemId: text("stripe_subscription_item_id"),
    currency: text("currency"),
    unitAmount: integer("unit_amount"),
    interval: text("interval").$type<"month" | "year">(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    cancelAt: timestamp("cancel_at", { withTimezone: true }),
    stripeSubscriptionCreated: integer("stripe_subscription_created"),
    livemode: boolean("livemode"),
    lastEventCreated: integer("last_event_created"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mailbox_subscriptions_stripe_id_idx")
      .on(t.stripeSubscriptionId)
      .where(sql`${t.stripeSubscriptionId} is not null`),
    check(
      "mailbox_subscriptions_status_check",
      sql`${t.status} in ('inactive','trialing','active','past_due','canceled')`,
    ),
    check("mailbox_subscriptions_seats_check", sql`${t.seats} between 0 and 10000`),
    check(
      "mailbox_subscriptions_storage_check",
      sql`${t.storageBytesPerMailbox} between 1 and 10995116277760`,
    ),
    check(
      "mailbox_subscriptions_outbound_check",
      sql`${t.includedOutboundPerMailbox} between 0 and 1000000`,
    ),
    check("mailbox_subscriptions_period_check", sql`${t.periodEnd} > ${t.periodStart}`),
  ],
);
