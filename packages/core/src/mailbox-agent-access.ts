import { randomBytes, randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { hashApiKey, verifyApiKey } from "./api-keys.js";
import type { MailboxRegistryActor } from "./mailbox-registry.js";
import {
  MailboxServiceError,
  mailboxServiceActive,
  requireMailboxSeat,
} from "./mailbox-service.js";

export type MailboxAgentScope = "read" | "draft" | "send";
/** Derived exclusively from a trusted human session, including its support-view flag. */
export interface MailboxAgentOwnerActor extends MailboxRegistryActor {
  supportView?: boolean;
}
export interface MailboxAgentAccessContext {
  db: Db;
  actor: MailboxRegistryActor;
  mailboxId: string;
  /** Derived authorization provenance, never selected by an HTTP caller. */
  keyId: string;
  ownerMembershipId: string;
  expiresAt: Date | null;
}
export class MailboxAgentAccessError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "quota") {
    super(code);
  }
}
type AgentKey = typeof schema.mailboxAgentKeys.$inferSelect;
const SCOPES: readonly MailboxAgentScope[] = ["read", "draft", "send"];
const MAX_ACTIVE_KEYS_PER_MAILBOX = 25;
const TOKEN =
  /^mmb_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.[A-Za-z0-9_-]{43}$/;

async function credentialNamespace(db: Db, mailboxId: string, shared = false) {
  // Serialize namespace changes before discovering credential rows. Otherwise an owner change
  // could miss a concurrent mint, then acquire its credential lock after the mailbox lock.
  const namespace = "mailbox-agent-credentials:" + mailboxId;
  await db.execute(
    shared
      ? sql`select pg_advisory_xact_lock_shared(hashtext(${namespace}))`
      : sql`select pg_advisory_xact_lock(hashtext(${namespace}))`,
  );
}

/** Registry integration only: call AFTER team/current membership and BEFORE the mailbox lock.
 * Return a closure to invalidate old authorizations once the registry resolves the new pin.
 * The same transaction must surround this helper, the closure and the ownership update.
 */
export async function lockMailboxAgentKeysForOwnerChange(
  db: Db,
  teamId: string,
  mailboxId: string,
) {
  await credentialNamespace(db, mailboxId);
  await db
    .select({ id: schema.mailboxAgentKeys.id })
    .from(schema.mailboxAgentKeys)
    .where(
      and(
        eq(schema.mailboxAgentKeys.teamId, teamId),
        eq(schema.mailboxAgentKeys.mailboxId, mailboxId),
      ),
    )
    .orderBy(asc(schema.mailboxAgentKeys.id))
    .for("update");
  return async (ownerUserId: string | null, ownerMembershipId: string | null) => {
    await db
      .update(schema.mailboxAgentKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.mailboxAgentKeys.teamId, teamId),
          eq(schema.mailboxAgentKeys.mailboxId, mailboxId),
          isNull(schema.mailboxAgentKeys.revokedAt),
          or(
            sql`${schema.mailboxAgentKeys.ownerUserId} is distinct from ${ownerUserId}`,
            sql`${schema.mailboxAgentKeys.ownerMembershipId} is distinct from ${ownerMembershipId}`,
          ),
        ),
      );
  };
}

function metadata(key: AgentKey) {
  return {
    id: key.id,
    mailboxId: key.mailboxId,
    label: key.label,
    scopes: [...key.scopes],
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
  };
}
async function ownerMember(db: Db, actor: MailboxAgentOwnerActor, minting = false) {
  if (actor.supportView) throw new MailboxAgentAccessError("forbidden");
  const [team] = await db
    .select({ suspendedAt: schema.teams.suspendedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, actor.teamId))
    .for("share");
  if (!team || (minting && team.suspendedAt)) throw new MailboxAgentAccessError("forbidden");
  const [member] = await db
    .select({ id: schema.teamMembers.id })
    .from(schema.teamMembers)
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    )
    .for("share");
  if (!member) throw new MailboxAgentAccessError("forbidden");
  return member.id;
}
async function ownedBox(
  db: Db,
  actor: MailboxAgentOwnerActor,
  mailboxId: string,
  memberId: string,
  write = false,
) {
  const query = db
    .select()
    .from(schema.mailboxes)
    .where(and(eq(schema.mailboxes.id, mailboxId), eq(schema.mailboxes.teamId, actor.teamId)));
  const [box] = await (write ? query.for("update") : query.for("share"));
  // Administrative role or human content grants do not authorize agent credentials.
  if (!box || box.ownerUserId !== actor.userId || box.ownerMembershipId !== memberId)
    throw new MailboxAgentAccessError("forbidden");
  return box;
}

/** Owner authorization is independent of billing so expired subscribers can revoke credentials. */
export async function createMailboxAgentKey(
  db: Db,
  actor: MailboxAgentOwnerActor,
  input: {
    mailboxId: string;
    label: string;
    scopes?: MailboxAgentScope[] | undefined;
    expiresAt?: Date | null | undefined;
  },
) {
  actor = { ...actor };
  if (input.scopes !== undefined && !Array.isArray(input.scopes))
    throw new MailboxAgentAccessError("invalid");
  if (input.expiresAt != null && !(input.expiresAt instanceof Date))
    throw new MailboxAgentAccessError("invalid");
  input = { ...input, scopes: input.scopes ? [...input.scopes] : undefined };
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const scopes: MailboxAgentScope[] = input.scopes ?? ["read", "draft"];
  const expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt.getTime());
  if (
    !label ||
    label.length > 80 ||
    /[\r\n\x00-\x1f]/.test(label) ||
    !scopes.length ||
    scopes.length > 3 ||
    scopes.some((scope) => !SCOPES.includes(scope)) ||
    new Set(scopes).size !== scopes.length ||
    (expiresAt !== null &&
      (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()))
  )
    throw new MailboxAgentAccessError("invalid");
  // The token contains 256 random bits; its public ID is only a lookup handle.
  const id = randomUUID();
  const token = `mmb_${id}.${randomBytes(32).toString("base64url")}`;
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const memberId = await ownerMember(tx, actor, true);
    await credentialNamespace(tx, input.mailboxId);
    const box = await ownedBox(tx, actor, input.mailboxId, memberId, true);
    if (box.status !== "planned") throw new MailboxAgentAccessError("forbidden");
    const existing = await tx
      .select({ expiresAt: schema.mailboxAgentKeys.expiresAt })
      .from(schema.mailboxAgentKeys)
      .where(
        and(
          eq(schema.mailboxAgentKeys.teamId, actor.teamId),
          eq(schema.mailboxAgentKeys.mailboxId, box.id),
          isNull(schema.mailboxAgentKeys.revokedAt),
        ),
      );
    if (
      existing.filter((key) => !key.expiresAt || key.expiresAt.getTime() > Date.now()).length >=
      MAX_ACTIVE_KEYS_PER_MAILBOX
    )
      throw new MailboxAgentAccessError("quota");
    const [key] = await tx
      .insert(schema.mailboxAgentKeys)
      .values({
        id,
        teamId: actor.teamId,
        mailboxId: box.id,
        ownerUserId: actor.userId,
        ownerMembershipId: memberId,
        label,
        scopes: [...scopes],
        keyHash: hashApiKey(token),
        expiresAt,
      })
      .returning();
    if (!key) throw new Error("Mailbox agent credential creation returned no row");
    // This is the only return path containing the bearer secret.
    return { ...metadata(key), token };
  });
}

export async function listMailboxAgentKeys(
  db: Db,
  actor: MailboxAgentOwnerActor,
  mailboxId: string,
) {
  actor = { ...actor };
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const memberId = await ownerMember(tx, actor);
    await ownedBox(tx, actor, mailboxId, memberId);
    const keys = await tx
      .select({
        id: schema.mailboxAgentKeys.id,
        mailboxId: schema.mailboxAgentKeys.mailboxId,
        label: schema.mailboxAgentKeys.label,
        scopes: schema.mailboxAgentKeys.scopes,
        createdAt: schema.mailboxAgentKeys.createdAt,
        expiresAt: schema.mailboxAgentKeys.expiresAt,
        revokedAt: schema.mailboxAgentKeys.revokedAt,
      })
      .from(schema.mailboxAgentKeys)
      .where(
        and(
          eq(schema.mailboxAgentKeys.teamId, actor.teamId),
          eq(schema.mailboxAgentKeys.mailboxId, mailboxId),
        ),
      )
      .orderBy(desc(schema.mailboxAgentKeys.createdAt), desc(schema.mailboxAgentKeys.id))
      .limit(100);
    return keys;
  });
}

/** Team -> membership -> credential -> mailbox; revocation remains possible while suspended. */
export async function revokeMailboxAgentKey(
  db: Db,
  actor: MailboxAgentOwnerActor,
  input: { mailboxId: string; id: string },
) {
  actor = { ...actor };
  input = { ...input };
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const memberId = await ownerMember(tx, actor);
    await credentialNamespace(tx, input.mailboxId);
    const [key] = await tx
      .select({ id: schema.mailboxAgentKeys.id })
      .from(schema.mailboxAgentKeys)
      .where(
        and(
          eq(schema.mailboxAgentKeys.id, input.id),
          eq(schema.mailboxAgentKeys.teamId, actor.teamId),
          eq(schema.mailboxAgentKeys.mailboxId, input.mailboxId),
        ),
      )
      .for("update");
    await ownedBox(tx, actor, input.mailboxId, memberId);
    if (!key) throw new MailboxAgentAccessError("not_found");
    await tx
      .update(schema.mailboxAgentKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(schema.mailboxAgentKeys.id, key.id), isNull(schema.mailboxAgentKeys.revokedAt)),
      );
    return { id: key.id };
  });
}

/** Trusted runtime bridge. The caller supplies no identity or mailbox override.
 * All locks remain held through the private-store/send callback and its response construction.
 * Read access survives billing expiry; draft/send keep the paid seat gate before mailbox writes.
 */
export async function withMailboxAgentAccess<T>(
  db: Db,
  token: string,
  scope: MailboxAgentScope,
  operation: (context: MailboxAgentAccessContext) => Promise<T>,
): Promise<T> {
  if (typeof token !== "string" || !SCOPES.includes(scope))
    throw new MailboxAgentAccessError("forbidden");
  const match = TOKEN.exec(token);
  if (!match) throw new MailboxAgentAccessError("forbidden");
  // Discovery acquires no row lock. All authorization fields are re-read under locks below.
  const [hint] = await db
    .select({
      teamId: schema.mailboxAgentKeys.teamId,
      mailboxId: schema.mailboxAgentKeys.mailboxId,
      ownerUserId: schema.mailboxAgentKeys.ownerUserId,
    })
    .from(schema.mailboxAgentKeys)
    .where(eq(schema.mailboxAgentKeys.id, match[1]!));
  if (!hint) throw new MailboxAgentAccessError("forbidden");
  return withLockedMailboxAgentKey(
    db,
    { ...hint, id: match[1]! },
    scope,
    (key) => verifyApiKey(token, key.keyHash),
    operation,
  );
}

/** Worker-only bridge for an immutable approval previously authenticated with a secret.
 * No HTTP runtime may use this instead of bearer authentication. A missing credential
 * never falls back to a human actor. Keep these locks until queued -> sending commits.
 */
export async function withMailboxAgentQueuedSendAccess<T>(
  db: Db,
  approval: {
    keyId: string;
    teamId: string;
    mailboxId: string;
    approvedBy: string;
    approvedMembershipId: string;
  },
  operation: (context: MailboxAgentAccessContext) => Promise<T>,
): Promise<T> {
  approval = { ...approval };
  return withLockedMailboxAgentKey(
    db,
    {
      id: approval.keyId,
      teamId: approval.teamId,
      mailboxId: approval.mailboxId,
      ownerUserId: approval.approvedBy,
    },
    "send",
    (key) => key.ownerMembershipId === approval.approvedMembershipId,
    operation,
  );
}

async function withLockedMailboxAgentKey<T>(
  db: Db,
  hint: { id: string; teamId: string; mailboxId: string; ownerUserId: string },
  scope: MailboxAgentScope,
  verify: (key: AgentKey) => boolean,
  operation: (context: MailboxAgentAccessContext) => Promise<T>,
): Promise<T> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [team] = await tx
      .select({ suspendedAt: schema.teams.suspendedAt })
      .from(schema.teams)
      .where(eq(schema.teams.id, hint.teamId))
      .for("share");
    if (!team) throw new MailboxAgentAccessError("forbidden");
    const [member] = await tx
      .select({ id: schema.teamMembers.id })
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, hint.teamId),
          eq(schema.teamMembers.userId, hint.ownerUserId),
        ),
      )
      .for("share");
    if (!member) throw new MailboxAgentAccessError("forbidden");
    await credentialNamespace(tx, hint.mailboxId, true);
    const [key] = await tx
      .select()
      .from(schema.mailboxAgentKeys)
      .where(
        and(
          eq(schema.mailboxAgentKeys.id, hint.id),
          eq(schema.mailboxAgentKeys.teamId, hint.teamId),
          eq(schema.mailboxAgentKeys.mailboxId, hint.mailboxId),
          eq(schema.mailboxAgentKeys.ownerUserId, hint.ownerUserId),
        ),
      )
      .for("share");
    if (
      !key ||
      key.revokedAt ||
      (key.expiresAt && key.expiresAt.getTime() <= Date.now()) ||
      key.ownerMembershipId !== member.id ||
      !key.scopes.includes(scope) ||
      !verify(key)
    )
      throw new MailboxAgentAccessError("forbidden");
    const change = scope !== "read";
    // Preserve the private-store lock order, including the subscription before mailbox writes.
    const [plan] = change
      ? await tx
          .select()
          .from(schema.mailboxSubscriptions)
          .where(eq(schema.mailboxSubscriptions.teamId, key.teamId))
          .for("update")
      : [];
    const query = tx
      .select()
      .from(schema.mailboxes)
      .where(and(eq(schema.mailboxes.id, key.mailboxId), eq(schema.mailboxes.teamId, key.teamId)));
    const [box] = await (change ? query.for("update") : query.for("share"));
    if (
      !box ||
      box.status !== "planned" ||
      box.ownerUserId !== key.ownerUserId ||
      box.ownerMembershipId !== key.ownerMembershipId ||
      (key.expiresAt && key.expiresAt.getTime() <= Date.now())
    )
      throw new MailboxAgentAccessError("forbidden");
    if (change) {
      if (team.suspendedAt) throw new MailboxAgentAccessError("forbidden");
      if (!mailboxServiceActive(plan)) throw new MailboxServiceError("not_entitled");
      await requireMailboxSeat(tx, key.teamId, box.id, plan!);
    }
    return operation({
      db: tx,
      actor: { teamId: key.teamId, userId: key.ownerUserId },
      mailboxId: box.id,
      keyId: key.id,
      ownerMembershipId: member.id,
      expiresAt: key.expiresAt ? new Date(key.expiresAt.getTime()) : null,
    });
  });
}
