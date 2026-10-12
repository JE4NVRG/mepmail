import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, asc, count, eq, isNull, lt, or, sql } from "drizzle-orm";
import { type MailboxContentActor, withMailboxOwnerAccess } from "./mailbox-private-store.js";

/**
 * App passwords: how Outlook, Apple Mail, Thunderbird or the Gmail app reach a Correio
 * mailbox over IMAP and SMTP (specs/correio-imap-smtp.md). The mailbox's owner makes one
 * per app; it is shown once, as 16 letters in four groups, and only a keyed hash is kept.
 * Being random and long (≈72 bits), it is looked up by that hash like an API key. It signs
 * in as the owner who made it, and only while that person still owns the mailbox, the
 * mailbox is active and the password is not revoked.
 */
export const MAILBOX_APP_PASSWORD_LIMIT = 10;
/** No i, l or o: nothing to confuse with 1 or 0 when typed from the screen. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz";
const LENGTH = 16;
/** last_used_at is written at most this often, not on every IMAP command. */
const USED_EVERY_MS = 5 * 60_000;

export class MailboxAppPasswordError extends Error {
  constructor(public readonly code: "invalid" | "quota" | "not_found") {
    super(code);
  }
}

export function deriveMailboxAppPasswordKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("mepmail/mailbox-app-password/v1").digest();
}

/** 16 letters from the alphabet above. */
export function generateMailboxAppPassword(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** "abcd efgh jkmn pqrs": how it is shown, and how most people will type it. */
export function formatMailboxAppPassword(password: string): string {
  return password.match(/.{1,4}/g)?.join(" ") ?? password;
}

/** What was typed, without spaces or dashes and lower-cased; null when it cannot be one. */
export function normalizeMailboxAppPassword(input: string): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const value = input.replace(/[\s-]/g, "").toLowerCase();
  return value.length === LENGTH && [...value].every((c) => ALPHABET.includes(c)) ? value : null;
}

export function hashMailboxAppPassword(key: Buffer, password: string): string {
  return createHmac("sha256", key).update(password).digest("hex");
}

function cleanLabel(label: string) {
  const value = typeof label === "string" ? label.trim().replace(/\s+/g, " ") : "";
  if (!value || value.length > 80 || [...value].some((c) => c.charCodeAt(0) < 32))
    throw new MailboxAppPasswordError("invalid");
  return value;
}

export interface MailboxAppPasswordRow {
  id: string;
  label: string;
  hint: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const visible = {
  id: schema.mailboxAppPasswords.id,
  label: schema.mailboxAppPasswords.label,
  hint: schema.mailboxAppPasswords.hint,
  createdAt: schema.mailboxAppPasswords.createdAt,
  lastUsedAt: schema.mailboxAppPasswords.lastUsedAt,
};
const active = (actor: MailboxContentActor, mailboxId: string) =>
  and(
    eq(schema.mailboxAppPasswords.mailboxId, mailboxId),
    eq(schema.mailboxAppPasswords.teamId, actor.teamId),
    eq(schema.mailboxAppPasswords.userId, actor.userId),
    isNull(schema.mailboxAppPasswords.revokedAt),
  );

/**
 * A new app password for the owner's person mailbox (licensed, plan active). The clear
 * password is returned here and never again.
 */
export async function createMailboxAppPassword(
  db: Db,
  key: Buffer,
  actor: MailboxContentActor,
  input: { mailboxId: string; label: string },
): Promise<MailboxAppPasswordRow & { password: string }> {
  const label = cleanLabel(input.label);
  return withMailboxOwnerAccess(
    db,
    actor,
    input.mailboxId,
    async (tx) => {
      const [box] = await tx
        .select({ kind: schema.mailboxes.kind })
        .from(schema.mailboxes)
        .where(eq(schema.mailboxes.id, input.mailboxId));
      // Agent mailboxes keep their agent keys; app passwords are for people's mail apps.
      if (box?.kind !== "person") throw new MailboxAppPasswordError("invalid");
      const [held] = await tx
        .select({ n: count() })
        .from(schema.mailboxAppPasswords)
        .where(active(actor, input.mailboxId));
      if ((held?.n ?? 0) >= MAILBOX_APP_PASSWORD_LIMIT) throw new MailboxAppPasswordError("quota");
      const password = generateMailboxAppPassword();
      const [row] = await tx
        .insert(schema.mailboxAppPasswords)
        .values({
          teamId: actor.teamId,
          mailboxId: input.mailboxId,
          userId: actor.userId,
          label,
          secretHash: hashMailboxAppPassword(key, password),
          hint: password.slice(-4),
        })
        .returning(visible);
      if (!row) throw new MailboxAppPasswordError("invalid");
      return { ...row, password: formatMailboxAppPassword(password) };
    },
    true,
  );
}

/** The owner's active app passwords for the mailbox, oldest first. */
export async function listMailboxAppPasswords(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
): Promise<MailboxAppPasswordRow[]> {
  return withMailboxOwnerAccess(db, actor, mailboxId, (tx) =>
    tx
      .select(visible)
      .from(schema.mailboxAppPasswords)
      .where(active(actor, mailboxId))
      .orderBy(asc(schema.mailboxAppPasswords.createdAt), asc(schema.mailboxAppPasswords.id)),
  );
}

export async function revokeMailboxAppPassword(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string },
): Promise<{ id: string }> {
  return withMailboxOwnerAccess(db, actor, input.mailboxId, async (tx) => {
    const [row] = await tx
      .update(schema.mailboxAppPasswords)
      .set({ revokedAt: new Date() })
      .where(and(active(actor, input.mailboxId), eq(schema.mailboxAppPasswords.id, input.id)))
      .returning({ id: schema.mailboxAppPasswords.id });
    if (!row) throw new MailboxAppPasswordError("not_found");
    return row;
  });
}

export interface MailboxClientIdentity {
  passwordId: string;
  teamId: string;
  mailboxId: string;
  userId: string;
  /** The mailbox's own address (the login may have used an alias). */
  address: string;
}

/**
 * Sign-in for IMAP and SMTP: the mailbox's address (or one of its aliases) and an app
 * password. Null for anything wrong, without saying what: unknown address, wrong or
 * revoked password, owner changed or gone, mailbox suspended or being deleted. Plan and
 * seat are checked by every operation the session then does, as for the web.
 */
export async function authenticateMailboxAppPassword(
  db: Db,
  key: Buffer,
  input: { username: string; password: string },
  now = new Date(),
): Promise<MailboxClientIdentity | null> {
  const username = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
  const password = normalizeMailboxAppPassword(input.password);
  if (!password || !username || username.length > 254 || !username.includes("@")) return null;
  const hash = hashMailboxAppPassword(key, password);
  const [row] = await db
    .select({
      passwordId: schema.mailboxAppPasswords.id,
      secretHash: schema.mailboxAppPasswords.secretHash,
      lastUsedAt: schema.mailboxAppPasswords.lastUsedAt,
      teamId: schema.mailboxes.teamId,
      mailboxId: schema.mailboxes.id,
      userId: schema.mailboxAppPasswords.userId,
      address: schema.mailboxes.address,
    })
    .from(schema.mailboxAppPasswords)
    .innerJoin(
      schema.mailboxes,
      and(
        eq(schema.mailboxes.id, schema.mailboxAppPasswords.mailboxId),
        eq(schema.mailboxes.teamId, schema.mailboxAppPasswords.teamId),
      ),
    )
    .innerJoin(
      schema.teamMembers,
      and(
        eq(schema.teamMembers.id, schema.mailboxes.ownerMembershipId),
        eq(schema.teamMembers.teamId, schema.mailboxes.teamId),
        eq(schema.teamMembers.userId, schema.mailboxAppPasswords.userId),
      ),
    )
    .where(
      and(
        eq(schema.mailboxAppPasswords.secretHash, hash),
        isNull(schema.mailboxAppPasswords.revokedAt),
        eq(schema.mailboxes.ownerUserId, schema.mailboxAppPasswords.userId),
        eq(schema.mailboxes.status, "planned"),
        isNull(schema.mailboxes.deleteAfter),
        or(
          eq(schema.mailboxes.address, username),
          sql`exists (select 1 from ${schema.mailboxAliases} where ${schema.mailboxAliases.mailboxId} = ${schema.mailboxes.id} and ${schema.mailboxAliases.address} = ${username})`,
        ),
      ),
    );
  // The index found it by hash; compare again in constant time all the same.
  if (!row || !timingSafeEqual(Buffer.from(row.secretHash), Buffer.from(hash))) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > USED_EVERY_MS)
    await db
      .update(schema.mailboxAppPasswords)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(schema.mailboxAppPasswords.id, row.passwordId),
          or(
            isNull(schema.mailboxAppPasswords.lastUsedAt),
            lt(schema.mailboxAppPasswords.lastUsedAt, new Date(now.getTime() - USED_EVERY_MS)),
          ),
        ),
      );
  return {
    passwordId: row.passwordId,
    teamId: row.teamId,
    mailboxId: row.mailboxId,
    userId: row.userId,
    address: row.address,
  };
}

/** For long IMAP sessions: still not revoked and still the owner's (checked per command). */
export async function mailboxAppPasswordActive(db: Db, identity: MailboxClientIdentity) {
  const [row] = await db
    .select({ id: schema.mailboxAppPasswords.id })
    .from(schema.mailboxAppPasswords)
    .innerJoin(schema.mailboxes, eq(schema.mailboxes.id, schema.mailboxAppPasswords.mailboxId))
    .where(
      and(
        eq(schema.mailboxAppPasswords.id, identity.passwordId),
        isNull(schema.mailboxAppPasswords.revokedAt),
        eq(schema.mailboxes.ownerUserId, identity.userId),
        eq(schema.mailboxes.status, "planned"),
        isNull(schema.mailboxes.deleteAfter),
      ),
    );
  return !!row;
}
