import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { teams } from "./teams.js";

/** Financial intents survive ambiguous POSTs; neither lease expiry nor retention closes one. */
export const sendCheckoutAttempts = pgTable(
  "send_checkout_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    status: text("status").$type<"prepared" | "unknown" | "created" | "resolved">().notNull(),
    rung: text("rung").notNull(),
    livemode: boolean("livemode").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
    stripeSessionId: text("stripe_session_id"),
    checkoutUrl: text("checkout_url"),
    firstRequestedAt: timestamp("first_requested_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("send_checkout_attempts_key_idx").on(t.idempotencyKey),
    uniqueIndex("send_checkout_attempts_session_idx")
      .on(t.stripeSessionId)
      .where(sql`${t.stripeSessionId} is not null`),
    uniqueIndex("send_checkout_attempts_active_team_idx")
      .on(t.teamId)
      .where(sql`${t.status} <> 'resolved'`),
    check(
      "send_checkout_attempts_status_check",
      sql`${t.status} in ('prepared','unknown','created','resolved')`,
    ),
    check(
      "send_checkout_attempts_created_check",
      sql`${t.status} <> 'created' or (${t.stripeSessionId} is not null and ${t.checkoutUrl} is not null)`,
    ),
    check(
      "send_checkout_attempts_unknown_check",
      sql`${t.status} <> 'unknown' or ${t.firstRequestedAt} is not null`,
    ),
    check(
      "send_checkout_attempts_resolved_check",
      sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)`,
    ),
    check(
      "send_checkout_attempts_lease_check",
      sql`(${t.leaseToken} is null) = (${t.leaseUntil} is null)`,
    ),
  ],
);
