import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { sendCheckoutAttempts } from "./send-checkouts.js";

export const advertisingConsentReceipts = pgTable(
  "advertising_consent_receipts",
  {
    id: uuid("id").primaryKey(),
    proofNonce: uuid("proof_nonce").notNull(),
    policyVersion: text("policy_version").notNull(),
    state: text("state").$type<"accepted" | "denied">().notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    sourceUrl: text("source_url"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("advertising_consent_state_check", sql`${t.state} in ('accepted','denied')`),
    check(
      "advertising_consent_accepted_check",
      sql`${t.state} <> 'accepted' or (${t.acceptedAt} is not null and ${t.revokedAt} is null)`,
    ),
  ],
);

/** One immutable choice per financial attempt, including disabled/denied choices. */
export const metaCheckoutContexts = pgTable(
  "meta_checkout_contexts",
  {
    attemptId: uuid("attempt_id")
      .primaryKey()
      .references(() => sendCheckoutAttempts.id, { onDelete: "cascade" }),
    consentReceiptId: uuid("consent_receipt_id").references(() => advertisingConsentReceipts.id, {
      onDelete: "restrict",
    }),
    eligible: boolean("eligible").notNull(),
    sourceUrl: text("source_url"),
    fbp: text("fbp"),
    fbc: text("fbc"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "meta_checkout_eligible_check",
      sql`not ${t.eligible} or (${t.consentReceiptId} is not null and ${t.sourceUrl} is not null and (${t.fbp} is not null or ${t.fbc} is not null))`,
    ),
  ],
);

/** Delivery never calls Stripe. Business keys outlive the 90-day Stripe event ledger. */
export const metaConversionOutbox = pgTable(
  "meta_conversion_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull().defaultRandom(),
    eventName: text("event_name").$type<"InitiateCheckout" | "Purchase">().notNull(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => metaCheckoutContexts.attemptId, { onDelete: "cascade" }),
    consentReceiptId: uuid("consent_receipt_id")
      .notNull()
      .references(() => advertisingConsentReceipts.id, { onDelete: "restrict" }),
    livemode: boolean("livemode").notNull(),
    stripeSessionId: text("stripe_session_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    amountPaidMinor: integer("amount_paid_minor"),
    currency: text("currency"),
    /** Selected authenticated invoice/subscription facts only; no raw provider payload or PII. */
    confirmation: jsonb("confirmation").$type<Record<string, unknown>>(),
    status: text("status")
      .$type<"waiting" | "pending" | "leased" | "sent" | "cancelled" | "dead">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastFailure: text("last_failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_conversion_event_id_idx").on(t.eventId),
    uniqueIndex("meta_conversion_session_idx")
      .on(t.livemode, t.stripeSessionId)
      .where(sql`${t.eventName} = 'InitiateCheckout'`),
    uniqueIndex("meta_conversion_invoice_idx")
      .on(t.livemode, t.stripeInvoiceId)
      .where(sql`${t.eventName} = 'Purchase'`),
    uniqueIndex("meta_conversion_acquisition_idx")
      .on(t.livemode, t.stripeSubscriptionId)
      .where(sql`${t.eventName} = 'Purchase'`),
    index("meta_conversion_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('waiting','pending','leased')`),
    check("meta_conversion_name_check", sql`${t.eventName} in ('InitiateCheckout','Purchase')`),
    check(
      "meta_conversion_status_check",
      sql`${t.status} in ('waiting','pending','leased','sent','cancelled','dead')`,
    ),
    check(
      "meta_conversion_purchase_check",
      sql`${t.eventName} <> 'Purchase' or (${t.stripeInvoiceId} is not null and ${t.stripeSubscriptionId} is not null and ${t.amountPaidMinor} is not null and ${t.amountPaidMinor} > 0 and ${t.currency} is not null)`,
    ),
    check(
      "meta_conversion_checkout_check",
      sql`${t.eventName} <> 'InitiateCheckout' or ${t.stripeSessionId} is not null`,
    ),
    check(
      "meta_conversion_lease_check",
      sql`(${t.status} = 'leased') = (${t.leaseToken} is not null and ${t.leaseUntil} is not null)`,
    ),
    check(
      "meta_conversion_lease_pair_check",
      sql`(${t.leaseToken} is null) = (${t.leaseUntil} is null)`,
    ),
    check(
      "meta_conversion_waiting_check",
      sql`${t.status} <> 'waiting' or (${t.eventName} = 'Purchase' and ${t.confirmation} is not null)`,
    ),
    check("meta_conversion_attempts_check", sql`${t.attempts} >= 0`),
  ],
);
