import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    /** "team": the storage and outbound figures above are the whole team's, shared by its mailboxes. */
    quotaScope: text("quota_scope").$type<"mailbox" | "team">().notNull().default("mailbox"),
    /** Seats the base price covers; every seat above them is billed at extraUnitAmount. */
    includedMailboxes: integer("included_mailboxes").notNull().default(1),
    extraUnitAmount: integer("extra_unit_amount"),
    /** A Correio plan (Solo, Duo, Equipe): its fixed mailboxes and the per-period allowances below. */
    planCode: text("plan_code").$type<"solo" | "duo" | "equipe">(),
    /** Team-wide allowances per billing period; null = no such allowance (pre-plan terms). */
    inboundDeliveriesPerPeriod: integer("inbound_deliveries_per_period"),
    inboundBytesPerPeriod: bigint("inbound_bytes_per_period", { mode: "number" }),
    outboundBytesPerPeriod: bigint("outbound_bytes_per_period", { mode: "number" }),
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
    check(
      "mailbox_subscriptions_quota_scope_check",
      sql`${t.quotaScope} in ('mailbox','team') and ${t.includedMailboxes} between 1 and 10000 and (${t.extraUnitAmount} is null or ${t.extraUnitAmount} > 0)`,
    ),
    check(
      "mailbox_subscriptions_plan_check",
      sql`(${t.planCode} is null or ${t.planCode} in ('solo','duo','equipe')) and (${t.inboundDeliveriesPerPeriod} is null or ${t.inboundDeliveriesPerPeriod} between 0 and 10000000) and (${t.inboundBytesPerPeriod} is null or ${t.inboundBytesPerPeriod} between 0 and 10995116277760) and (${t.outboundBytesPerPeriod} is null or ${t.outboundBytesPerPeriod} between 0 and 10995116277760)`,
    ),
  ],
);

/**
 * What a team received in one billing period, counted with the message: one delivery
 * per provider receipt and its raw MIME bytes. A redelivered receipt counts once and
 * deleting mail never gives the allowance back. Outbound usage lives in mailbox_outbox.
 */
export const mailboxUsagePeriods = pgTable(
  "mailbox_usage_periods",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    inboundDeliveries: integer("inbound_deliveries").notNull().default(0),
    inboundBytes: bigint("inbound_bytes", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "mailbox_usage_periods_pk", columns: [t.teamId, t.periodStart] }),
    check(
      "mailbox_usage_periods_check",
      sql`${t.periodEnd} > ${t.periodStart} and ${t.inboundDeliveries} >= 0 and ${t.inboundBytes} >= 0`,
    ),
  ],
);

/**
 * Receiving paused for a team whose inbound allowance or storage ran out: its addresses
 * leave the SES receipt rules, so SES refuses new mail before accepting (and billing) it.
 * "pausing"/"resuming" are wanted, not yet confirmed in SES; "paused" is confirmed.
 */
export const mailboxReceivingHolds = pgTable(
  "mailbox_receiving_holds",
  {
    teamId: uuid("team_id")
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    reason: text("reason").$type<"inbound_deliveries" | "inbound_bytes" | "storage">().notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    state: text("state").$type<"pausing" | "paused" | "resuming">().notNull().default("pausing"),
    /** Addresses taken out of SES (plus any activated meanwhile), put back on resume. */
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "mailbox_receiving_holds_reason_check",
      sql`${t.reason} in ('inbound_deliveries','inbound_bytes','storage')`,
    ),
    check(
      "mailbox_receiving_holds_state_check",
      sql`${t.state} in ('pausing','paused','resuming')`,
    ),
  ],
);
