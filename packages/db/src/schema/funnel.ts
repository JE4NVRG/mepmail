import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { user } from "./auth.js";

/**
 * Where a sign-up came from, as the visit's landing page could see it. One row
 * per account, written once by the auth user.create hook from the visit cookie
 * the proxy left (apps/web/src/proxy.ts); an account with no cookie on file is
 * simply not measured and reads as "(nao medido)" in the funnel report, never
 * as a channel it might not have come from. No address, no IP, no user agent:
 * the channel is the whole point, and every row here is one account.
 */
export const signupAttribution = pgTable("signup_attribution", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** utm_source, else the referrer's host, else "direct". Never empty. */
  source: text("source").notNull(),
  medium: text("medium"),
  campaign: text("campaign"),
  content: text("content"),
  term: text("term"),
  /** Host of the external referrer, if any; the path is dropped (may carry PII). */
  referrer: text("referrer"),
  /** Pathname the visit landed on; query and fragment are dropped. */
  landingPath: text("landing_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ledger of the server-side product events (the funnel in packages/core
 * funnel-events). The insert is the lock: a unique dedupe_key means exactly
 * one caller emits a given event, so a retried Stripe delivery or a second
 * first-mail race cannot double-count. `props` is the payload that was sent —
 * kept so a lost Umami delivery can be replayed by hand, and so the event is
 * auditable without reading the analytics database.
 */
export const funnelEvents = pgTable(
  "funnel_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    /** Set for team-scoped events (first_email_sent, checkout, payment). */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    props: jsonb("props").$type<Record<string, string>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("funnel_events_name_created_idx").on(t.name, t.createdAt)],
);
