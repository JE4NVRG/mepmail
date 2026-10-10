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
import { user } from "./auth.js";
import { teams } from "./teams.js";

/** Durable purchase intent. Provider ambiguity never expires a lease by wall-clock TTL. */
export const mailboxCheckouts = pgTable(
  "mailbox_checkouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    status: text("status")
      .$type<"prepared" | "creating" | "ready" | "completed" | "expired">()
      .notNull()
      .default("prepared"),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    seats: integer("seats").notNull(),
    livemode: boolean("livemode").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    currency: text("currency").notNull(),
    unitAmount: integer("unit_amount").notNull(),
    interval: text("interval").$type<"month" | "year">().notNull(),
    storageBytesPerMailbox: bigint("storage_bytes_per_mailbox", { mode: "number" }).notNull(),
    includedOutboundPerMailbox: integer("included_outbound_per_mailbox").notNull(),
    quotaScope: text("quota_scope").$type<"mailbox" | "team">().notNull().default("mailbox"),
    includedMailboxes: integer("included_mailboxes").notNull().default(1),
    extraUnitAmount: integer("extra_unit_amount"),
    planCode: text("plan_code").$type<"solo" | "duo" | "equipe">(),
    inboundDeliveriesPerPeriod: integer("inbound_deliveries_per_period"),
    inboundBytesPerPeriod: bigint("inbound_bytes_per_period", { mode: "number" }),
    outboundBytesPerPeriod: bigint("outbound_bytes_per_period", { mode: "number" }),
    /** Free trial the Checkout was opened with (0 = none); decided when the lease is created. */
    trialDays: integer("trial_days").notNull().default(0),
    successUrl: text("success_url").notNull(),
    cancelUrl: text("cancel_url").notNull(),
    automaticTax: boolean("automatic_tax").notNull().default(false),
    stripeSessionId: text("stripe_session_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    checkoutUrl: text("checkout_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mailbox_checkouts_idempotency_idx").on(t.idempotencyKey),
    uniqueIndex("mailbox_checkouts_session_idx")
      .on(t.stripeSessionId)
      .where(sql`${t.stripeSessionId} is not null`),
    uniqueIndex("mailbox_checkouts_open_team_idx")
      .on(t.teamId)
      .where(sql`${t.status} in ('prepared','creating','ready')`),
    check(
      "mailbox_checkouts_status_check",
      sql`${t.status} in ('prepared','creating','ready','completed','expired')`,
    ),
    check("mailbox_checkouts_seats_check", sql`${t.seats} between 1 and 10000`),
    check(
      "mailbox_checkouts_storage_check",
      sql`${t.storageBytesPerMailbox} between 1 and 10995116277760`,
    ),
    check(
      "mailbox_checkouts_outbound_check",
      sql`${t.includedOutboundPerMailbox} between 0 and 1000000`,
    ),
    check("mailbox_checkouts_amount_check", sql`${t.unitAmount} > 0`),
    check("mailbox_checkouts_interval_check", sql`${t.interval} in ('month','year')`),
    check("mailbox_checkouts_currency_check", sql`${t.currency} ~ '^[a-z]{3}$'`),
    check(
      "mailbox_checkouts_terms_check",
      sql`${t.quotaScope} in ('mailbox','team') and ${t.includedMailboxes} between 1 and 10000 and (${t.extraUnitAmount} is null or ${t.extraUnitAmount} > 0) and ${t.trialDays} between 0 and 30 and ${t.seats} >= ${t.includedMailboxes}`,
    ),
    check(
      "mailbox_checkouts_plan_check",
      sql`(${t.planCode} is null or ${t.planCode} in ('solo','duo','equipe')) and (${t.inboundDeliveriesPerPeriod} is null or ${t.inboundDeliveriesPerPeriod} between 0 and 10000000) and (${t.inboundBytesPerPeriod} is null or ${t.inboundBytesPerPeriod} between 0 and 10995116277760) and (${t.outboundBytesPerPeriod} is null or ${t.outboundBytesPerPeriod} between 0 and 10995116277760)`,
    ),
    check(
      "mailbox_checkouts_ready_check",
      sql`${t.status} <> 'ready' or (${t.stripeSessionId} is not null and ${t.checkoutUrl} is not null)`,
    ),
  ],
);
