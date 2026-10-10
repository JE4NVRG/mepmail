import { type Db, schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { quickRepliesSchema, undoSendSchema } from "../lib/mailbox-quick-replies";

/**
 * How one person likes the Correio inbox to look and behave. Stored per user (not
 * per team or mailbox); the server owns the defaults, so a read never misses a
 * field and a stored value that no longer validates falls back to its default.
 */
const FIELDS = {
  theme: z.enum(["system", "light", "dark"]),
  density: z.enum(["comfortable", "compact"]),
  readingPane: z.enum(["right", "bottom", "off"]),
  previewLines: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  groupByThread: z.boolean(),
  startFolder: z.union([
    z.enum(["inbox", "favorites", "drafts", "sent", "archive", "trash"]),
    z
      .string()
      .regex(/^folder:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .transform((value) => value as `folder:${string}`),
  ]),
  showAvatars: z.boolean(),
  markSeenAfterMs: z.union([z.literal(0), z.literal(1500), z.literal(3000), z.null()]),
  showShortcutHints: z.boolean(),
  undoSendSeconds: undoSendSchema,
  quickReplies: quickRepliesSchema,
  smartInbox: z.boolean(),
  askNewSenders: z.boolean(),
};
type Field = keyof typeof FIELDS;
export type MailboxPreferences = { [K in Field]: z.output<(typeof FIELDS)[K]> };

export const MAILBOX_PREFERENCE_DEFAULTS: MailboxPreferences = {
  theme: "system",
  density: "comfortable",
  readingPane: "right",
  previewLines: 1,
  groupByThread: true,
  startFolder: "inbox",
  showAvatars: true,
  markSeenAfterMs: 1500,
  showShortcutHints: true,
  undoSendSeconds: 10,
  quickReplies: null,
  smartInbox: true,
  askNewSenders: true,
};

/** A rejected change, naming the field so the UI can point at it. */
export class MailboxPreferenceError extends Error {
  constructor(public readonly field: string) {
    super(`invalid_preference:${field}`);
  }
}

const fields = Object.keys(FIELDS) as Field[];
const isField = (key: string): key is Field => Object.hasOwn(FIELDS, key);

function complete(stored: unknown): MailboxPreferences {
  const source =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const result = { ...MAILBOX_PREFERENCE_DEFAULTS } as Record<Field, unknown>;
  for (const field of fields) {
    if (!Object.hasOwn(source, field)) continue;
    const parsed = FIELDS[field].safeParse(source[field]);
    if (parsed.success) result[field] = parsed.data;
  }
  return result as MailboxPreferences;
}

/** A read: every field, plus when this person last saved (null: never, all defaults). */
export type MailboxPreferencesState = MailboxPreferences & { updatedAt: string | null };

/**
 * Only known fields, each valid; the first problem is reported by name. A returned
 * `updatedAt` sent back unchanged is accepted and ignored, so a full object round-trips.
 */
export function parseMailboxPreferencePatch(patch: unknown): Partial<MailboxPreferences> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new MailboxPreferenceError("preferences");
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "updatedAt" && (value === null || typeof value === "string")) continue;
    if (!isField(key)) throw new MailboxPreferenceError(key.slice(0, 40));
    const parsed = FIELDS[key].safeParse(value);
    if (!parsed.success) throw new MailboxPreferenceError(key);
    result[key] = parsed.data;
  }
  return result as Partial<MailboxPreferences>;
}

const state = (row: { preferences: unknown; updatedAt: Date } | undefined) => ({
  ...complete(row?.preferences),
  updatedAt: row ? row.updatedAt.toISOString() : null,
});

export async function getMailboxPreferences(
  db: Db,
  userId: string,
): Promise<MailboxPreferencesState> {
  const [row] = await db
    .select({
      preferences: schema.mailboxUserPreferences.preferences,
      updatedAt: schema.mailboxUserPreferences.updatedAt,
    })
    .from(schema.mailboxUserPreferences)
    .where(eq(schema.mailboxUserPreferences.userId, userId));
  return state(row);
}

/** Merges the changed fields into what is stored, atomically, and returns the full object. */
export async function setMailboxPreferences(
  db: Db,
  userId: string,
  patch: unknown,
): Promise<MailboxPreferencesState> {
  const changes = parseMailboxPreferencePatch(patch);
  if (!Object.keys(changes).length) return getMailboxPreferences(db, userId);
  const [row] = await db
    .insert(schema.mailboxUserPreferences)
    .values({ userId, preferences: changes, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.mailboxUserPreferences.userId,
      set: {
        preferences: sql`${schema.mailboxUserPreferences.preferences} || excluded.preferences`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning({
      preferences: schema.mailboxUserPreferences.preferences,
      updatedAt: schema.mailboxUserPreferences.updatedAt,
    });
  return state(row);
}
