import { randomBytes, randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { hashApiKey, verifyApiKey } from "./api-keys.js";
import type { MailboxRegistryActor } from "./mailbox-registry.js";
import {
  mailboxServiceEntitlement,
  requireMailboxOperationalPlan,
  requireMailboxSeat,
} from "./mailbox-service.js";

export type MailboxAgentScope = "read" | "draft" | "send";
/** Derived exclusively from a trusted human session, including its support-view flag. */
export interface MailboxAgentOwnerActor extends MailboxRegistryActor {
  supportView?: boolean;
}
export interface MailboxAgentAccessContext {
  db: Db;
  actor: MailboxRegistryActor & { agentAccess: true };
  mailboxId: string;
  /** Derived authorization provenance, never selected by an HTTP caller. */
  keyId: string;
  ownerMembershipId: string;
  expiresAt: Date | null;
}
export class MailboxAgentAccessError extends Error {
  constructor(
    public readonly code: "forbidden" | "not_found" | "invalid" | "quota" | "mailbox_required",
  ) {
    super(code);
  }
}
type AgentKey = typeof schema.mailboxAgentKeys.$inferSelect;
const SCOPES: readonly MailboxAgentScope[] = ["read", "draft", "send"];
const MAX_ACTIVE_KEYS_PER_MAILBOX = 25;
const MAX_TEAM_MAILBOXES = 20;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TOKEN =
  /^mmb_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.[A-Za-z0-9_-]{43}$/;
/** A team credential: one secret over several per-mailbox rows sharing its group id. */
const TEAM_TOKEN =
  /^mmt_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.[A-Za-z0-9_-]{43}$/;

/** Which mailbox a call is for: its id or its address. Anything else is refused. */
export type MailboxSelector = { id: string } | { address: string };
export function parseMailboxSelector(value: string | null | undefined): MailboxSelector | null {
  if (value === null || value === undefined) return null;
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (UUID.test(trimmed)) return { id: trimmed };
  if (trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
    return { address: trimmed };
  throw new MailboxAgentAccessError("invalid");
}
function selects(selector: MailboxSelector, box: { id: string; address: string }) {
  return "id" in selector ? box.id === selector.id : box.address.toLowerCase() === selector.address;
}

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

/** Label, scopes and expiry as every agent credential accepts them. */
function credentialFields(input: {
  label: unknown;
  scopes?: MailboxAgentScope[] | undefined;
  expiresAt?: Date | null | undefined;
}) {
  if (input.scopes !== undefined && !Array.isArray(input.scopes))
    throw new MailboxAgentAccessError("invalid");
  if (input.expiresAt != null && !(input.expiresAt instanceof Date))
    throw new MailboxAgentAccessError("invalid");
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const scopes: MailboxAgentScope[] = input.scopes ? [...input.scopes] : ["read", "draft"];
  const expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt.getTime());
  if (
    !label ||
    label.length > 80 ||
    // No control characters (C0 range, CR and LF included).
    [...label].some((char) => char.charCodeAt(0) < 0x20) ||
    !scopes.length ||
    scopes.length > 3 ||
    scopes.some((scope) => !SCOPES.includes(scope)) ||
    new Set(scopes).size !== scopes.length ||
    (expiresAt !== null &&
      (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()))
  )
    throw new MailboxAgentAccessError("invalid");
  return { label, scopes, expiresAt };
}

async function activeKeysOn(db: Db, teamId: string, mailboxId: string) {
  const existing = await db
    .select({ expiresAt: schema.mailboxAgentKeys.expiresAt })
    .from(schema.mailboxAgentKeys)
    .where(
      and(
        eq(schema.mailboxAgentKeys.teamId, teamId),
        eq(schema.mailboxAgentKeys.mailboxId, mailboxId),
        isNull(schema.mailboxAgentKeys.revokedAt),
      ),
    );
  return existing.filter((key) => !key.expiresAt || key.expiresAt.getTime() > Date.now()).length;
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
  input = { ...input, scopes: input.scopes ? [...input.scopes] : undefined };
  const { label, scopes, expiresAt } = credentialFields(input);
  // The token contains 256 random bits; its public ID is only a lookup handle.
  const id = randomUUID();
  const token = `mmb_${id}.${randomBytes(32).toString("base64url")}`;
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const memberId = await ownerMember(tx, actor, true);
    await credentialNamespace(tx, input.mailboxId);
    const box = await ownedBox(tx, actor, input.mailboxId, memberId, true);
    if (box.status !== "planned") throw new MailboxAgentAccessError("forbidden");
    if ((await activeKeysOn(tx, actor.teamId, box.id)) >= MAX_ACTIVE_KEYS_PER_MAILBOX)
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

/**
 * A team credential (mmt_…): one secret for several mailboxes. It is one key row per
 * mailbox, so each mailbox keeps its own owner authorization, locks, seat gate,
 * scopes, revocation on owner change and audit trail. Only mailboxes the minting
 * person owns can be included; one may be the default for calls that name none.
 */
export async function createMailboxTeamAgentKey(
  db: Db,
  actor: MailboxAgentOwnerActor,
  input: {
    label: string;
    mailboxIds: string[];
    scopes?: MailboxAgentScope[] | undefined;
    defaultMailboxId?: string | null | undefined;
    expiresAt?: Date | null | undefined;
  },
) {
  actor = { ...actor };
  if (!Array.isArray(input.mailboxIds)) throw new MailboxAgentAccessError("invalid");
  const mailboxIds = [...input.mailboxIds];
  const defaultMailboxId = input.defaultMailboxId ?? null;
  const { label, scopes, expiresAt } = credentialFields({
    label: input.label,
    scopes: input.scopes ? [...input.scopes] : undefined,
    expiresAt: input.expiresAt,
  });
  if (
    !mailboxIds.length ||
    mailboxIds.length > MAX_TEAM_MAILBOXES ||
    mailboxIds.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    new Set(mailboxIds).size !== mailboxIds.length ||
    (defaultMailboxId !== null && !mailboxIds.includes(defaultMailboxId))
  )
    throw new MailboxAgentAccessError("invalid");
  const groupId = randomUUID();
  const token = `mmt_${groupId}.${randomBytes(32).toString("base64url")}`;
  const keyHash = hashApiKey(token);
  // One lock order for every mailbox set, so concurrent mints never deadlock.
  const ordered = [...mailboxIds].sort();
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const memberId = await ownerMember(tx, actor, true);
    for (const id of ordered) await credentialNamespace(tx, id);
    const boxes = [];
    for (const id of ordered) {
      const box = await ownedBox(tx, actor, id, memberId, true);
      if (box.status !== "planned") throw new MailboxAgentAccessError("forbidden");
      if ((await activeKeysOn(tx, actor.teamId, box.id)) >= MAX_ACTIVE_KEYS_PER_MAILBOX)
        throw new MailboxAgentAccessError("quota");
      boxes.push(box);
    }
    const rows = await tx
      .insert(schema.mailboxAgentKeys)
      .values(
        boxes.map((box) => ({
          id: randomUUID(),
          teamId: actor.teamId,
          mailboxId: box.id,
          ownerUserId: actor.userId,
          ownerMembershipId: memberId,
          label,
          scopes: [...scopes],
          keyHash,
          expiresAt,
          groupId,
          isDefault: box.id === defaultMailboxId,
        })),
      )
      .returning();
    if (rows.length !== boxes.length)
      throw new Error("Mailbox team agent credential creation returned no row");
    const address = new Map(boxes.map((box) => [box.id, box.address]));
    // This is the only return path containing the bearer secret.
    return {
      id: groupId,
      label,
      scopes: [...scopes],
      createdAt: rows[0]!.createdAt,
      expiresAt,
      mailboxes: rows.map((row) => ({
        mailboxId: row.mailboxId,
        address: address.get(row.mailboxId) ?? "",
        isDefault: row.isDefault,
      })),
      token,
    };
  });
}

/** The team credentials this person minted, one entry per credential with its mailboxes. */
export async function listMailboxTeamAgentKeys(db: Db, actor: MailboxAgentOwnerActor) {
  actor = { ...actor };
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await ownerMember(tx, actor);
    const rows = await tx
      .select({
        groupId: schema.mailboxAgentKeys.groupId,
        mailboxId: schema.mailboxAgentKeys.mailboxId,
        address: schema.mailboxes.address,
        label: schema.mailboxAgentKeys.label,
        scopes: schema.mailboxAgentKeys.scopes,
        isDefault: schema.mailboxAgentKeys.isDefault,
        createdAt: schema.mailboxAgentKeys.createdAt,
        expiresAt: schema.mailboxAgentKeys.expiresAt,
        revokedAt: schema.mailboxAgentKeys.revokedAt,
      })
      .from(schema.mailboxAgentKeys)
      .innerJoin(
        schema.mailboxes,
        and(
          eq(schema.mailboxes.id, schema.mailboxAgentKeys.mailboxId),
          eq(schema.mailboxes.teamId, schema.mailboxAgentKeys.teamId),
        ),
      )
      .where(
        and(
          eq(schema.mailboxAgentKeys.teamId, actor.teamId),
          eq(schema.mailboxAgentKeys.ownerUserId, actor.userId),
          sql`${schema.mailboxAgentKeys.groupId} is not null`,
        ),
      )
      .orderBy(desc(schema.mailboxAgentKeys.createdAt), asc(schema.mailboxes.address))
      .limit(MAX_TEAM_MAILBOXES * 50);
    const groups = new Map<
      string,
      {
        id: string;
        label: string;
        scopes: MailboxAgentScope[];
        createdAt: Date;
        expiresAt: Date | null;
        revokedAt: Date | null;
        mailboxes: { mailboxId: string; address: string; isDefault: boolean; revoked: boolean }[];
      }
    >();
    for (const row of rows) {
      const id = row.groupId as string;
      const group = groups.get(id) ?? {
        id,
        label: row.label,
        scopes: [...row.scopes],
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        mailboxes: [],
      };
      // The credential is revoked only when every one of its mailboxes is.
      if (!row.revokedAt) group.revokedAt = null;
      group.mailboxes.push({
        mailboxId: row.mailboxId,
        address: row.address,
        isDefault: row.isDefault,
        revoked: row.revokedAt !== null,
      });
      groups.set(id, group);
    }
    return [...groups.values()];
  });
}

/** Revokes every mailbox of a team credential the person minted. */
export async function revokeMailboxTeamAgentKey(
  db: Db,
  actor: MailboxAgentOwnerActor,
  input: { id: string },
) {
  actor = { ...actor };
  input = { ...input };
  if (typeof input.id !== "string" || !UUID.test(input.id))
    throw new MailboxAgentAccessError("invalid");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await ownerMember(tx, actor);
    const rows = await tx
      .select({ mailboxId: schema.mailboxAgentKeys.mailboxId })
      .from(schema.mailboxAgentKeys)
      .where(
        and(
          eq(schema.mailboxAgentKeys.groupId, input.id),
          eq(schema.mailboxAgentKeys.teamId, actor.teamId),
          eq(schema.mailboxAgentKeys.ownerUserId, actor.userId),
        ),
      );
    if (!rows.length) throw new MailboxAgentAccessError("not_found");
    for (const id of [...new Set(rows.map((row) => row.mailboxId))].sort())
      await credentialNamespace(tx, id);
    await tx
      .update(schema.mailboxAgentKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.mailboxAgentKeys.groupId, input.id),
          eq(schema.mailboxAgentKeys.teamId, actor.teamId),
          isNull(schema.mailboxAgentKeys.revokedAt),
        ),
      );
    return { id: input.id };
  });
}

/**
 * The mailboxes an agent credential reaches, without any message content: for a
 * team credential every live mailbox of it (and which is the default), for a
 * single-mailbox key its one mailbox. `available` is false when the mailbox is
 * suspended or changed owner since the credential was made.
 */
export async function listMailboxAgentAccounts(db: Db, token: string) {
  if (typeof token !== "string") throw new MailboxAgentAccessError("forbidden");
  const team = TEAM_TOKEN.exec(token);
  const single = team ? null : TOKEN.exec(token);
  if (!team && !single) throw new MailboxAgentAccessError("forbidden");
  const rows = await db
    .select({
      keyHash: schema.mailboxAgentKeys.keyHash,
      teamId: schema.mailboxAgentKeys.teamId,
      ownerUserId: schema.mailboxAgentKeys.ownerUserId,
      ownerMembershipId: schema.mailboxAgentKeys.ownerMembershipId,
      scopes: schema.mailboxAgentKeys.scopes,
      isDefault: schema.mailboxAgentKeys.isDefault,
      expiresAt: schema.mailboxAgentKeys.expiresAt,
      revokedAt: schema.mailboxAgentKeys.revokedAt,
      mailboxId: schema.mailboxes.id,
      address: schema.mailboxes.address,
      label: schema.mailboxes.label,
      kind: schema.mailboxes.kind,
      status: schema.mailboxes.status,
      boxOwnerUserId: schema.mailboxes.ownerUserId,
      boxOwnerMembershipId: schema.mailboxes.ownerMembershipId,
    })
    .from(schema.mailboxAgentKeys)
    .innerJoin(
      schema.mailboxes,
      and(
        eq(schema.mailboxes.id, schema.mailboxAgentKeys.mailboxId),
        eq(schema.mailboxes.teamId, schema.mailboxAgentKeys.teamId),
      ),
    )
    .where(
      team
        ? eq(schema.mailboxAgentKeys.groupId, team[1]!)
        : and(eq(schema.mailboxAgentKeys.id, single![1]!), isNull(schema.mailboxAgentKeys.groupId)),
    )
    .orderBy(asc(schema.mailboxes.address));
  const first = rows[0];
  if (!first || !verifyApiKey(token, first.keyHash)) throw new MailboxAgentAccessError("forbidden");
  const [member] = await db
    .select({ id: schema.teamMembers.id })
    .from(schema.teamMembers)
    .where(
      and(
        eq(schema.teamMembers.teamId, first.teamId),
        eq(schema.teamMembers.userId, first.ownerUserId),
      ),
    );
  const live = rows.filter(
    (row) =>
      row.keyHash === first.keyHash &&
      !row.revokedAt &&
      (!row.expiresAt || row.expiresAt.getTime() > Date.now()),
  );
  if (!member || !live.length) throw new MailboxAgentAccessError("forbidden");
  return {
    credential: team ? ("team" as const) : ("mailbox" as const),
    mailboxes: live.map((row) => ({
      id: row.mailboxId,
      address: row.address,
      label: row.label,
      kind: row.kind,
      scopes: [...row.scopes],
      default: team ? row.isDefault : true,
      available:
        row.status === "planned" &&
        row.boxOwnerUserId === row.ownerUserId &&
        row.boxOwnerMembershipId === row.ownerMembershipId &&
        row.ownerMembershipId === member.id,
    })),
  };
}

/** Trusted runtime bridge. The caller supplies no identity; the credential decides the mailboxes.
 * `mailbox` names one of them (id or address): required for a team credential without a
 * default, and for a single-mailbox key it must be that key's own mailbox or nothing.
 * All locks remain held through the private-store/send callback and its response construction.
 * Read access survives billing expiry; draft/send keep the paid seat gate before mailbox writes.
 */
export async function withMailboxAgentAccess<T>(
  db: Db,
  token: string,
  scope: MailboxAgentScope,
  operation: (context: MailboxAgentAccessContext) => Promise<T>,
  mailbox?: MailboxSelector | null,
): Promise<T> {
  if (typeof token !== "string" || !SCOPES.includes(scope))
    throw new MailboxAgentAccessError("forbidden");
  const team = TEAM_TOKEN.exec(token);
  if (team) return withTeamMailboxAgentAccess(db, token, team[1]!, scope, operation, mailbox);
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
    .where(and(eq(schema.mailboxAgentKeys.id, match[1]!), isNull(schema.mailboxAgentKeys.groupId)));
  if (!hint) throw new MailboxAgentAccessError("forbidden");
  return withLockedMailboxAgentKey(
    db,
    { ...hint, id: match[1]! },
    scope,
    (key) => verifyApiKey(token, key.keyHash),
    operation,
    mailbox ?? null,
  );
}

async function withTeamMailboxAgentAccess<T>(
  db: Db,
  token: string,
  groupId: string,
  scope: MailboxAgentScope,
  operation: (context: MailboxAgentAccessContext) => Promise<T>,
  mailbox: MailboxSelector | null | undefined,
): Promise<T> {
  // Discovery acquires no row lock and decides nothing: the chosen row is re-read and
  // re-verified under the same locks a single-mailbox key takes.
  const rows = await db
    .select({
      id: schema.mailboxAgentKeys.id,
      teamId: schema.mailboxAgentKeys.teamId,
      mailboxId: schema.mailboxAgentKeys.mailboxId,
      ownerUserId: schema.mailboxAgentKeys.ownerUserId,
      keyHash: schema.mailboxAgentKeys.keyHash,
      isDefault: schema.mailboxAgentKeys.isDefault,
      address: schema.mailboxes.address,
    })
    .from(schema.mailboxAgentKeys)
    .innerJoin(
      schema.mailboxes,
      and(
        eq(schema.mailboxes.id, schema.mailboxAgentKeys.mailboxId),
        eq(schema.mailboxes.teamId, schema.mailboxAgentKeys.teamId),
      ),
    )
    .where(
      and(eq(schema.mailboxAgentKeys.groupId, groupId), isNull(schema.mailboxAgentKeys.revokedAt)),
    );
  // The secret is checked before anything about the mailbox set is revealed.
  if (!rows[0] || !verifyApiKey(token, rows[0].keyHash))
    throw new MailboxAgentAccessError("forbidden");
  const chosen = mailbox
    ? rows.find((row) => selects(mailbox, { id: row.mailboxId, address: row.address }))
    : (rows.find((row) => row.isDefault) ?? (rows.length === 1 ? rows[0] : undefined));
  if (!chosen) throw new MailboxAgentAccessError(mailbox ? "forbidden" : "mailbox_required");
  return withLockedMailboxAgentKey(
    db,
    {
      id: chosen.id,
      teamId: chosen.teamId,
      mailboxId: chosen.mailboxId,
      ownerUserId: chosen.ownerUserId,
    },
    scope,
    (key) => key.groupId === groupId && verifyApiKey(token, key.keyHash),
    operation,
    null,
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
  mailbox: MailboxSelector | null = null,
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
    const change = scope !== "read";
    const entitlement = change ? await mailboxServiceEntitlement(tx, hint.teamId, true) : null;
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
    // Entitlement is locked before credentials and mailbox writes; reads remain recoverable.
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
      (key.expiresAt && key.expiresAt.getTime() <= Date.now()) ||
      // A single-mailbox key named for another mailbox never falls back to its own.
      (mailbox !== null && !selects(mailbox, box))
    )
      throw new MailboxAgentAccessError("forbidden");
    if (change) {
      if (team.suspendedAt) throw new MailboxAgentAccessError("forbidden");
      const plan = requireMailboxOperationalPlan(entitlement);
      await requireMailboxSeat(tx, key.teamId, box.id, plan);
    }
    return operation({
      db: tx,
      actor: { teamId: key.teamId, userId: key.ownerUserId, agentAccess: true },
      mailboxId: box.id,
      keyId: key.id,
      ownerMembershipId: member.id,
      expiresAt: key.expiresAt ? new Date(key.expiresAt.getTime()) : null,
    });
  });
}
