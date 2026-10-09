import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

/**
 * How one person likes the Correio inbox to look and behave, across every team and
 * mailbox they use. Presentation only: never content, grants or delivery state.
 * The app validates the object and fills defaults; unknown or stale keys are ignored.
 */
export const mailboxUserPreferences = pgTable(
  "mailbox_user_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "mailbox_user_preferences_object_check",
      sql`jsonb_typeof(${t.preferences}) = 'object' and octet_length(${t.preferences}::text) <= 4096`,
    ),
  ],
);
