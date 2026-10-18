import { createHash, randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { decryptPayload, encryptPayload } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import { assertMailboxExternalStorage, mailboxExternalLimits } from "./mailbox-external-limits.js";
import {
  MailboxExternalOAuthError,
  mailboxExternalOAuthProviderOf,
  mailboxExternalOAuthSecret,
  readMailboxExternalOAuthSecret,
  refreshMailboxExternalOAuthToken,
} from "./mailbox-external-oauth.js";
import type { MailboxExternalPresetId } from "./mailbox-external-providers.js";
import { MailboxContentError } from "./mailbox-private-store.js";
import { deriveMailboxRuleKey, mailboxRuleFor } from "./mailbox-rules.js";
import { isMailboxSenderBlocked } from "./mailbox-senders.js";
import { mailboxThreadKeys } from "./mailbox-thread.js";

/**
 * Contas externas (specs/correio-external-accounts.md, migration 0034): a person's own
 * Gmail/iCloud/Yahoo/IMAP account behind an `origin = 'external'` mailbox. This module
 * owns the account row (servers, the sealed app password, sync state), creates and
 * removes the mailbox that stands for it, and stores what the worker fetches with the
 * same sealing, conversation keys, storage limits, sender blocks and rules as mail that
 * arrives through SES. The secret is opened only in the worker (sync, send) and in the
 * web when the person replaces it; it is never returned.
 */

export type MailboxExternalErrorCode = "forbidden" | "not_found" | "conflict" | "invalid" | "limit";
export class MailboxExternalError extends Error {
  constructor(public readonly code: MailboxExternalErrorCode) {
    super(code);
  }
}

export interface MailboxExternalServersInput {
  provider: MailboxExternalPresetId;
  imapHost: string;
  smtpHost: string;
  smtpPort: 465 | 587;
  smtpSecurity: "tls" | "starttls";
  username: string;
}

interface Actor {
  teamId: string;
  userId: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** An app password, or an OAuth refresh token in its JSON wrapper (Microsoft's run long). */
const SECRET_MAX = 4000;
/** Between rounds for one account; the cron picks accounts whose time has come. */
export const MAILBOX_EXTERNAL_SYNC_EVERY_MS = 2 * 60_000;
/** How long a claimed round may run before another worker may take the account. */
const CLAIM_LEASE_MS = 5 * 60_000;

function secretBinding(teamId: string, mailboxId: string) {
  return {
    teamId,
    rowId: `mailbox-external-account-v1:${mailboxId}`,
    kind: "email_body" as const,
  };
}

function itemBinding(teamId: string, mailboxId: string, id: string) {
  return { teamId, rowId: `mailbox-private-v1:${mailboxId}:${id}`, kind: "email_body" as const };
}

async function sealSecret(keyring: Keyring, teamId: string, mailboxId: string, secret: string) {
  const sealed = await encryptPayload(
    Buffer.from(secret, "utf8"),
    keyring,
    secretBinding(teamId, mailboxId),
  );
  return {
    secretCiphertext: sealed.ciphertext,
    secretIv: sealed.iv,
    secretWrappedDek: sealed.wrappedDek,
    secretKeyVersion: sealed.keyVersion,
  };
}

/** Normal members connect their own accounts. Hold the membership lock through
 * writes, so profile activation cannot race creation or replacement of a secret. */
async function teamMember(tx: Db, actor: Actor) {
  const [member] = await tx
    .select({ id: schema.teamMembers.id, operationsAccess: schema.teamMembers.operationsAccess })
    .from(schema.teamMembers)
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    )
    .for("share");
  if (!member || member.operationsAccess !== null) throw new MailboxExternalError("forbidden");
  return member;
}

/**
 * Connects an account (servers and app password already proven by the caller): a new
 * external mailbox owned by the person connecting it, one seat, the sealed secret, and a
 * first sync due now. An address that is a Correio mailbox or alias anywhere, or already
 * connected on this team, is a plain conflict.
 */
export async function createMailboxExternalAccount(
  db: Db,
  keyring: Keyring,
  actor: Actor,
  input: {
    address: string;
    label: string;
    servers: MailboxExternalServersInput;
    secret: string;
    /** How the secret signs in: an app password (default) or an OAuth refresh token. */
    auth?: "password" | "oauth_google" | "oauth_microsoft";
  },
): Promise<{ mailboxId: string }> {
  const address = input.address.trim().toLowerCase();
  const label = input.label.trim();
  if (!EMAIL.test(address) || address.length > 254 || !label || label.length > 80)
    throw new MailboxExternalError("invalid");
  if (!input.secret || input.secret.length > SECRET_MAX) throw new MailboxExternalError("invalid");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const member = await teamMember(tx, actor);
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.mailboxes)
      .where(
        and(
          eq(schema.mailboxes.teamId, actor.teamId),
          eq(schema.mailboxes.ownerUserId, actor.userId),
          eq(schema.mailboxes.origin, "external"),
        ),
      );
    const limits = mailboxExternalLimits();
    if (count >= limits.accountsPerUser) throw new MailboxExternalError("limit");
    const [{ team } = { team: 0 }] = await tx
      .select({ team: sql<number>`count(*)::int` })
      .from(schema.mailboxes)
      .where(
        and(eq(schema.mailboxes.teamId, actor.teamId), eq(schema.mailboxes.origin, "external")),
      );
    if (team >= limits.accountsPerTeam) throw new MailboxExternalError("limit");
    const [domainBox] = await tx
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(and(eq(schema.mailboxes.address, address), eq(schema.mailboxes.origin, "domain")));
    const [alias] = await tx
      .select({ id: schema.mailboxAliases.id })
      .from(schema.mailboxAliases)
      .where(eq(schema.mailboxAliases.address, address));
    if (domainBox || alias) throw new MailboxExternalError("conflict");
    const [box] = await tx
      .insert(schema.mailboxes)
      .values({
        teamId: actor.teamId,
        origin: "external",
        domainId: null,
        address,
        label,
        kind: "person",
        ownerUserId: actor.userId,
        ownerMembershipId: member.id,
      })
      .onConflictDoNothing()
      .returning({ id: schema.mailboxes.id });
    if (!box) throw new MailboxExternalError("conflict");
    await tx.insert(schema.mailboxExternalAccounts).values({
      mailboxId: box.id,
      teamId: actor.teamId,
      provider: input.servers.provider,
      auth: input.auth ?? "password",
      imapHost: input.servers.imapHost,
      imapPort: 993,
      smtpHost: input.servers.smtpHost,
      smtpPort: input.servers.smtpPort,
      smtpSecurity: input.servers.smtpSecurity,
      username: input.servers.username,
      ...(await sealSecret(keyring, actor.teamId, box.id, input.secret)),
      createdBy: actor.userId,
    });
    return { mailboxId: box.id };
  });
}

async function ownedAccount(tx: Db, actor: Actor, mailboxId: string, lock = false) {
  const query = tx
    .select({
      mailboxId: schema.mailboxes.id,
      ownerUserId: schema.mailboxes.ownerUserId,
      origin: schema.mailboxes.origin,
    })
    .from(schema.mailboxes)
    .innerJoin(
      schema.mailboxExternalAccounts,
      eq(schema.mailboxExternalAccounts.mailboxId, schema.mailboxes.id),
    )
    .where(and(eq(schema.mailboxes.id, mailboxId), eq(schema.mailboxes.teamId, actor.teamId)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row || row.origin !== "external") throw new MailboxExternalError("not_found");
  if (row.ownerUserId !== actor.userId) throw new MailboxExternalError("forbidden");
  return row;
}

/** What the owner sees about the account: never the secret. */
export async function getMailboxExternalAccount(db: Db, actor: Actor, mailboxId: string) {
  await ownedAccount(db, actor, mailboxId);
  const [row] = await db
    .select({
      provider: schema.mailboxExternalAccounts.provider,
      auth: schema.mailboxExternalAccounts.auth,
      imapHost: schema.mailboxExternalAccounts.imapHost,
      smtpHost: schema.mailboxExternalAccounts.smtpHost,
      smtpPort: schema.mailboxExternalAccounts.smtpPort,
      username: schema.mailboxExternalAccounts.username,
      status: schema.mailboxExternalAccounts.status,
      lastError: schema.mailboxExternalAccounts.lastError,
      lastSyncedAt: schema.mailboxExternalAccounts.lastSyncedAt,
      nextSyncAt: schema.mailboxExternalAccounts.nextSyncAt,
      createdAt: schema.mailboxExternalAccounts.createdAt,
    })
    .from(schema.mailboxExternalAccounts)
    .where(eq(schema.mailboxExternalAccounts.mailboxId, mailboxId));
  if (!row) throw new MailboxExternalError("not_found");
  return row;
}

/** A new app password (already proven by the caller): the account syncs again now. */
export async function replaceMailboxExternalSecret(
  db: Db,
  keyring: Keyring,
  actor: Actor,
  input: { mailboxId: string; secret: string },
) {
  if (!input.secret || input.secret.length > SECRET_MAX) throw new MailboxExternalError("invalid");
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await teamMember(tx, actor);
    await ownedAccount(tx, actor, input.mailboxId, true);
    await tx
      .update(schema.mailboxExternalAccounts)
      .set({
        ...(await sealSecret(keyring, actor.teamId, input.mailboxId, input.secret)),
        status: "active",
        lastError: null,
        nextSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.mailboxExternalAccounts.mailboxId, input.mailboxId));
  });
}

/** "Sincronizar agora": due at once (an active account only). */
export async function requestMailboxExternalSync(db: Db, actor: Actor, mailboxId: string) {
  await ownedAccount(db, actor, mailboxId);
  await db
    .update(schema.mailboxExternalAccounts)
    .set({ nextSyncAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.mailboxExternalAccounts.mailboxId, mailboxId),
        eq(schema.mailboxExternalAccounts.status, "active"),
      ),
    );
}

/**
 * "Desconectar": the copies in the Correio, the sealed secret and the seat go now. What
 * is at the provider is never touched (this mailbox only ever read it).
 */
export async function disconnectMailboxExternalAccount(db: Db, actor: Actor, mailboxId: string) {
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await ownedAccount(tx, actor, mailboxId, true);
    await tx
      .delete(schema.mailboxes)
      .where(
        and(
          eq(schema.mailboxes.id, mailboxId),
          eq(schema.mailboxes.teamId, actor.teamId),
          eq(schema.mailboxes.origin, "external"),
        ),
      );
  });
}

// ---- Worker side ---------------------------------------------------------------------

/**
 * Accounts whose round is due, claimed for one lease: their next time moves forward now,
 * so two workers never sync one account at the same time.
 */
export async function claimDueMailboxExternalAccounts(
  db: Db,
  limit: number,
  now = new Date(),
): Promise<string[]> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const due = await tx
      .select({ mailboxId: schema.mailboxExternalAccounts.mailboxId })
      .from(schema.mailboxExternalAccounts)
      .where(
        and(
          eq(schema.mailboxExternalAccounts.status, "active"),
          lte(schema.mailboxExternalAccounts.nextSyncAt, now),
        ),
      )
      .orderBy(asc(schema.mailboxExternalAccounts.nextSyncAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const ids = due.map((row) => row.mailboxId);
    if (ids.length)
      await tx
        .update(schema.mailboxExternalAccounts)
        .set({ nextSyncAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
        .where(inArray(schema.mailboxExternalAccounts.mailboxId, ids));
    return ids;
  });
}

/** One account with its secret opened, for a sync round or a send (worker only). */
export async function openMailboxExternalAccount(db: Db, keyring: Keyring, mailboxId: string) {
  const [row] = await db
    .select({
      account: schema.mailboxExternalAccounts,
      teamId: schema.mailboxes.teamId,
      address: schema.mailboxes.address,
      ownerUserId: schema.mailboxes.ownerUserId,
      status: schema.mailboxes.status,
    })
    .from(schema.mailboxExternalAccounts)
    .innerJoin(schema.mailboxes, eq(schema.mailboxes.id, schema.mailboxExternalAccounts.mailboxId))
    .where(eq(schema.mailboxExternalAccounts.mailboxId, mailboxId));
  if (!row) return null;
  const secret = (
    await decryptPayload(
      {
        ciphertext: row.account.secretCiphertext,
        iv: row.account.secretIv,
        wrappedDek: row.account.secretWrappedDek,
        keyVersion: row.account.secretKeyVersion,
      },
      keyring,
      secretBinding(row.teamId, mailboxId),
    )
  ).toString("utf8");
  return {
    mailboxId,
    teamId: row.teamId,
    address: row.address,
    ownerUserId: row.ownerUserId,
    mailboxStatus: row.status,
    provider: row.account.provider,
    auth: row.account.auth,
    imapHost: row.account.imapHost,
    smtpHost: row.account.smtpHost,
    smtpPort: row.account.smtpPort as 465 | 587,
    smtpSecurity: row.account.smtpSecurity,
    username: row.account.username,
    syncState: row.account.syncState,
    secret,
  };
}

/** Access tokens this process holds, per account, tied to the refresh token they came from. */
const accessTokens = new Map<string, { token: string; expiresAt: number; refresh: string }>();

/**
 * What IMAP and SMTP sign in with: the app password, or for an OAuth account a short
 * access token (kept in memory until two minutes before it expires). A refresh token the
 * provider rotates is sealed again at once. A refused grant throws
 * MailboxExternalOAuthError("invalid_grant"): the person must sign in again.
 */
export async function mailboxExternalCredential(
  db: Db,
  keyring: Keyring,
  account: { mailboxId: string; teamId: string; auth: string; secret: string },
  refresh = refreshMailboxExternalOAuthToken,
  now = Date.now,
): Promise<{ password: string } | { accessToken: string }> {
  const provider = mailboxExternalOAuthProviderOf(account.auth);
  if (!provider) return { password: account.secret };
  const stored = readMailboxExternalOAuthSecret(account.secret);
  if (!stored) throw new MailboxExternalOAuthError("invalid_grant", "unreadable");
  const cached = accessTokens.get(account.mailboxId);
  if (cached && cached.refresh === stored && cached.expiresAt - now() > 120_000)
    return { accessToken: cached.token };
  const fresh = await refresh(provider, stored);
  if (fresh.refreshToken !== stored)
    await db
      .update(schema.mailboxExternalAccounts)
      .set({
        ...(await sealSecret(
          keyring,
          account.teamId,
          account.mailboxId,
          mailboxExternalOAuthSecret(fresh.refreshToken),
        )),
        updatedAt: new Date(),
      })
      .where(eq(schema.mailboxExternalAccounts.mailboxId, account.mailboxId));
  if (accessTokens.size >= 5000) accessTokens.clear();
  accessTokens.set(account.mailboxId, {
    token: fresh.accessToken,
    expiresAt: fresh.expiresAt.getTime(),
    refresh: fresh.refreshToken,
  });
  return { accessToken: fresh.accessToken };
}

/** The end of a round: where the INBOX stands, how it went, and when to come back. */
export async function finishMailboxExternalSync(
  db: Db,
  mailboxId: string,
  outcome:
    | { ok: true; syncState: schema.MailboxExternalSyncState; more: boolean }
    | { ok: false; status: "auth_failed" | "error"; error: string },
  now = new Date(),
) {
  await db
    .update(schema.mailboxExternalAccounts)
    .set(
      outcome.ok
        ? {
            syncState: outcome.syncState,
            status: "active",
            lastError: null,
            lastSyncedAt: now,
            // More waiting at the provider: the next round comes right away.
            nextSyncAt: new Date(
              now.getTime() + (outcome.more ? 5_000 : MAILBOX_EXTERNAL_SYNC_EVERY_MS),
            ),
            updatedAt: now,
          }
        : {
            status: outcome.status,
            lastError: outcome.error.slice(0, 64),
            // A refused password waits for the person; other failures retry later.
            nextSyncAt: new Date(now.getTime() + 15 * 60_000),
            updatedAt: now,
          },
    )
    .where(eq(schema.mailboxExternalAccounts.mailboxId, mailboxId));
}

/** A send refused the password: the account waits for a new one (no retry loop). */
export async function markMailboxExternalAuthFailed(db: Db, mailboxId: string, error: string) {
  await db
    .update(schema.mailboxExternalAccounts)
    .set({ status: "auth_failed", lastError: error.slice(0, 64), updatedAt: new Date() })
    .where(eq(schema.mailboxExternalAccounts.mailboxId, mailboxId));
}

/** sourceId for one provider message ("ext:", never "imap:": that prefix stays silent). */
export function mailboxExternalSourceId(
  mailboxId: string,
  uidValidity: number,
  uid: number,
): string {
  return `ext:${createHash("sha256").update(`${mailboxId}|${uidValidity}|${uid}`).digest("hex").slice(0, 40)}`;
}

/**
 * Stores one message fetched from the provider's INBOX: sealed like any received mail,
 * with its conversation keys, the plan's storage limit, the owner's blocked senders
 * (Spam) and rules (folder, Archive, read, star; no redirect to another mailbox).
 * A message seen before (same sourceId) is a duplicate, never a second copy.
 */
export async function receiveExternalMailboxMime(
  db: Db,
  keyring: Keyring,
  input: {
    mailboxId: string;
    sourceId: string;
    raw: Buffer;
    receivedAt: Date;
    seen: boolean;
    /** The From address, parsed by the caller (null: no rules or sender screen). */
    from: string | null;
    /** deriveMailboxSenderKey(master key). */
    senderKey?: Buffer;
  },
): Promise<{ id: string; duplicate: boolean }> {
  if (!/^ext:[a-f0-9]{40}$/.test(input.sourceId)) throw new MailboxContentError("invalid");
  if (!Buffer.isBuffer(input.raw) || !input.raw.length || input.raw.length > 25 * 1024 * 1024)
    throw new MailboxContentError("invalid");
  const raw = Buffer.from(input.raw);
  const from = input.from?.trim().toLowerCase() || null;
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [box] = await tx
      .select()
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, input.mailboxId))
      .for("update");
    if (!box || box.origin !== "external" || box.status !== "planned" || !box.ownerUserId)
      throw new MailboxContentError("forbidden");
    const [previous] = await tx
      .select({ id: schema.mailboxItems.id })
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.mailboxId, box.id),
          eq(schema.mailboxItems.teamId, box.teamId),
          eq(schema.mailboxItems.sourceId, input.sourceId),
        ),
      );
    if (previous) return { id: previous.id, duplicate: true };
    // The provider renumbered the folder (new UIDVALIDITY): the same message, by its
    // Message-ID, is still the one already here.
    const keys = mailboxThreadKeys(raw);
    if (keys.messageKey) {
      const [same] = await tx
        .select({ id: schema.mailboxItems.id })
        .from(schema.mailboxItems)
        .where(
          and(
            eq(schema.mailboxItems.mailboxId, box.id),
            eq(schema.mailboxItems.kind, "inbox"),
            eq(schema.mailboxItems.messageKey, keys.messageKey),
          ),
        )
        .limit(1);
      if (same) return { id: same.id, duplicate: true };
    }
    await assertMailboxExternalStorage(tx, box.id, raw.length);
    const blocked =
      !!input.senderKey &&
      !!from &&
      (await isMailboxSenderBlocked(tx, input.senderKey, {
        teamId: box.teamId,
        mailboxId: box.id,
        address: from,
      }));
    const rule =
      !blocked && input.senderKey && from
        ? await mailboxRuleFor(tx, deriveMailboxRuleKey(input.senderKey), {
            mailboxId: box.id,
            from,
          })
        : null;
    const receivedAt = Number.isFinite(input.receivedAt.getTime()) ? input.receivedAt : new Date();
    const id = randomUUID();
    const sealed = await encryptPayload(raw, keyring, itemBinding(box.teamId, box.id, id));
    await tx.insert(schema.mailboxItems).values({
      id,
      teamId: box.teamId,
      mailboxId: box.id,
      kind: "inbox",
      deliveryFolder: blocked ? "spam" : "inbox",
      createdAt: receivedAt,
      ...(input.seen || rule?.markRead ? { seenAt: receivedAt } : {}),
      ...(rule?.folderId ? { folderId: rule.folderId } : {}),
      ...(rule?.archive ? { archivedAt: receivedAt } : {}),
      ...(rule?.star ? { starredAt: receivedAt } : {}),
      inboundAssessment: null,
      sourceId: input.sourceId,
      rawBytes: raw.length,
      ...keys,
      ...sealed,
    });
    return { id, duplicate: false };
  });
}

/** Mailboxes to skip while a receiving hold stands on their team (holds only touched SES). */
export async function heldMailboxExternalTeams(db: Db, teamIds: readonly string[]) {
  if (!teamIds.length) return new Set<string>();
  const rows = await db
    .select({ teamId: schema.mailboxReceivingHolds.teamId })
    .from(schema.mailboxReceivingHolds)
    .where(
      and(
        inArray(schema.mailboxReceivingHolds.teamId, [...teamIds]),
        inArray(schema.mailboxReceivingHolds.state, ["pausing", "paused"]),
      ),
    );
  return new Set(rows.map((row) => row.teamId));
}
