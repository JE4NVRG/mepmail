import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { advertisingConsentReceipts } from "./meta-advertising.js";
import { sendCheckoutAttempts } from "./send-checkouts.js";

/**
 * The Google Analytics browser identity captured once, at the first financial
 * intent, and only under an accepted advertising consent. Withdrawal deletes it.
 */
export const googleCheckoutContexts = pgTable(
  "google_checkout_contexts",
  {
    attemptId: uuid("attempt_id")
      .primaryKey()
      .references(() => sendCheckoutAttempts.id, { onDelete: "cascade" }),
    consentReceiptId: uuid("consent_receipt_id")
      .notNull()
      .references(() => advertisingConsentReceipts.id, { onDelete: "restrict" }),
    /** The `_ga` cookie's client id ("<random>.<seconds>"), never a user identifier. */
    clientId: text("client_id").notNull(),
    sessionId: text("session_id"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "google_checkout_identity_check",
      sql`${t.clientId} ~ '^[0-9]{1,20}\\.[0-9]{1,20}$' and (${t.sessionId} is null or ${t.sessionId} ~ '^[0-9]{1,20}$')`,
    ),
  ],
);

/** One GA4 `purchase` per initial Send invoice, sent by the worker over the Measurement Protocol. */
export const googleConversionOutbox = pgTable(
  "google_conversion_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => sendCheckoutAttempts.id, { onDelete: "cascade" }),
    consentReceiptId: uuid("consent_receipt_id")
      .notNull()
      .references(() => advertisingConsentReceipts.id, { onDelete: "restrict" }),
    /** The Stripe invoice id: GA4 deduplicates purchases by transaction_id. */
    transactionId: text("transaction_id").notNull(),
    rung: text("rung").notNull(),
    valueMinor: integer("value_minor").notNull(),
    currency: text("currency").notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    status: text("status")
      .$type<"pending" | "leased" | "sent" | "cancelled" | "dead">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastFailure: text("last_failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("google_conversion_transaction_idx").on(t.transactionId),
    index("google_conversion_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('pending','leased')`),
    check(
      "google_conversion_status_check",
      sql`${t.status} in ('pending','leased','sent','cancelled','dead')`,
    ),
    check("google_conversion_value_check", sql`${t.valueMinor} > 0 and ${t.attempts} >= 0`),
    check(
      "google_conversion_lease_check",
      sql`(${t.status} = 'leased') = (${t.leaseUntil} is not null)`,
    ),
  ],
);
