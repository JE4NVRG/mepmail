import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Fixed-window counter for purchase attempts (checkout, Pix, plan change).
 *
 * One row per bucket, bumped with an atomic `on conflict do update`, so
 * concurrent requests, or two replicas, cannot overshoot the window. Buckets
 * are `team:<uuid>` and `ip:<sha256>`; the address is hashed with the auth
 * secret and never stored raw. Rows are reused forever because the window
 * resets in place, so the table keeps one row per team and per address that
 * ever tried to buy, not one row per attempt.
 *
 * Stripe Radar already refuses bad cards. This counter exists for the layer
 * before it: account and session churn from the same team or address.
 */
export const purchaseRateLimits = pgTable("purchase_rate_limits", {
  bucket: text("bucket").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});
