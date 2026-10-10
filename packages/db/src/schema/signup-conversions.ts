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
import { user } from "./auth.js";
import { advertisingConsentReceipts } from "./meta-advertising.js";

/**
 * One finished sign-up per person and vendor, under an accepted advertising
 * consent given in the same browser: Meta `CompleteRegistration` over the
 * Conversions API and GA4 `sign_up` over the Measurement Protocol, sent by the
 * worker. Only browser identifiers travel (the `_fbp`/`_fbc` cookies, the GA
 * client and session ids), never the account, its email or its name. A withdrawn
 * consent cancels what is pending and erases those identifiers.
 */
export const signupConversionOutbox = pgTable(
  "signup_conversion_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    vendor: text("vendor").$type<"meta" | "google">().notNull(),
    /** Meta deduplicates on it; retries reuse it. */
    eventId: uuid("event_id").notNull().defaultRandom(),
    consentReceiptId: uuid("consent_receipt_id")
      .notNull()
      .references(() => advertisingConsentReceipts.id, { onDelete: "restrict" }),
    sourceUrl: text("source_url"),
    fbp: text("fbp"),
    fbc: text("fbc"),
    clientId: text("client_id"),
    sessionId: text("session_id"),
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
    uniqueIndex("signup_conversion_user_vendor_idx").on(t.userId, t.vendor),
    index("signup_conversion_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('pending','leased')`),
    index("signup_conversion_receipt_idx").on(t.consentReceiptId),
    check("signup_conversion_vendor_check", sql`${t.vendor} in ('meta','google')`),
    check(
      "signup_conversion_status_check",
      sql`${t.status} in ('pending','leased','sent','cancelled','dead') and ${t.attempts} >= 0`,
    ),
    check(
      "signup_conversion_lease_check",
      sql`(${t.status} = 'leased') = (${t.leaseUntil} is not null)`,
    ),
    // While it may still leave, a row carries exactly its vendor's identity.
    check(
      "signup_conversion_identity_check",
      sql`${t.status} not in ('pending','leased') or (
        (${t.vendor} = 'meta' and ${t.sourceUrl} is not null and (${t.fbp} is not null or ${t.fbc} is not null) and ${t.clientId} is null and ${t.sessionId} is null)
        or (${t.vendor} = 'google' and ${t.clientId} ~ '^[0-9]{1,20}\\.[0-9]{1,20}$' and (${t.sessionId} is null or ${t.sessionId} ~ '^[0-9]{1,20}$') and ${t.fbp} is null and ${t.fbc} is null)
      )`,
    ),
  ],
);
