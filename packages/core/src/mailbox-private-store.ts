import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import {
  BOUND_ENVELOPE_VERSION_OFFSET,
  decryptPayload,
  encryptPayload,
} from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import type { MailboxRegistryActor } from "./mailbox-registry.js";
import {
  assertMailboxStorage,
  lockMailboxService,
  MailboxServiceError,
  mailboxServiceEntitlement,
  requireMailboxOperationalPlan,
  requireMailboxSeat,
} from "./mailbox-service.js";

/** Actor comes from a trusted session adapter, never from an HTTP body or API key. */
export interface MailboxContentActor extends MailboxRegistryActor {
  supportView?: boolean;
  /** Set only by the trusted bearer adapter. Agent reads exclude unsafe folders. */
  agentAccess?: boolean;
}
export class MailboxContentError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict") {
    super(code);
  }
}
type Item = typeof schema.mailboxItems.$inferSelect;
type Permission = "read" | "draft" | "owner";
const MAX_MIME_BYTES = 1024 * 1024;

function bytes(raw: Buffer) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_MIME_BYTES)
    throw new MailboxContentError("invalid");
  // Snapshot before the first await so the caller cannot mutate stored bytes in flight.
  return Buffer.from(raw);
}
function binding(item: { teamId: string; mailboxId: string; id: string }) {
  // A separate row namespace prevents interchange with legacy email_body rows.
  return {
    teamId: item.teamId,
    rowId: `mailbox-private-v1:${item.mailboxId}:${item.id}`,
    kind: "email_body" as const,
  };
}
function summary(item: Item) {
  return {
    id: item.id,
    mailboxId: item.mailboxId,
    kind: item.kind,
    deliveryFolder: item.deliveryFolder,
    inboundAssessment: item.inboundAssessment,
    trashedAt: item.trashedAt,
    starredAt: item.starredAt,
    folderId: item.folderId,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
async function open(item: Item, keyring: Keyring) {
  if (item.keyVersion < BOUND_ENVELOPE_VERSION_OFFSET)
    throw new Error("Private mailbox requires a bound envelope");
  const raw = await decryptPayload(item, keyring, binding(item));
  if (raw.length !== item.rawBytes || raw.length > MAX_MIME_BYTES)
    throw new Error("Invalid private mailbox payload size");
  return raw;
}

/** Lock order matches registry mutations: current membership, then mailbox.
 * Revocation/suspension and member deletion wait for an authorized read to finish;
 * later requests see the new permission. Admin role alone never unlocks content.
 */
async function scoped<T>(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  permission: Permission,
  change: boolean,
  operation: (tx: Db) => Promise<T>,
  exclusive = false,
): Promise<T> {
  if (actor.supportView) throw new MailboxContentError("forbidden");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [team] = await tx
      .select({ suspendedAt: schema.teams.suspendedAt })
      .from(schema.teams)
      .where(eq(schema.teams.id, actor.teamId))
      .for("share");
    const [member] = await tx
      .select({ id: schema.teamMembers.id })
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, actor.teamId),
          eq(schema.teamMembers.userId, actor.userId),
        ),
      )
      .for("share");
    if (!member) throw new MailboxContentError("forbidden");
    // Lock billing before mailbox, but report access failures before entitlements.
    const entitlement = change ? await mailboxServiceEntitlement(tx, actor.teamId, true) : null;
    const query = tx
      .select()
      .from(schema.mailboxes)
      .where(and(eq(schema.mailboxes.id, mailboxId), eq(schema.mailboxes.teamId, actor.teamId)));
    const [mailbox] = await (change || exclusive ? query.for("update") : query.for("share"));
    if (!mailbox || mailbox.status !== "planned") throw new MailboxContentError("forbidden");
    const owner = mailbox.ownerUserId === actor.userId && mailbox.ownerMembershipId === member.id;
    if (!owner) {
      const [grant] = await tx
        .select({ permission: schema.mailboxGrants.permission })
        .from(schema.mailboxGrants)
        .where(
          and(
            eq(schema.mailboxGrants.mailboxId, mailbox.id),
            eq(schema.mailboxGrants.teamId, actor.teamId),
            eq(schema.mailboxGrants.userId, actor.userId),
            eq(schema.mailboxGrants.membershipId, member.id),
            isNull(schema.mailboxGrants.revokedAt),
          ),
        )
        .for("share");
      if (
        !grant ||
        permission === "owner" ||
        (permission === "draft" && grant.permission !== "draft")
      )
        throw new MailboxContentError("forbidden");
    }
    if (change) {
      if (!team || team.suspendedAt) throw new MailboxServiceError("not_entitled");
      const plan = requireMailboxOperationalPlan(entitlement);
      await requireMailboxSeat(tx, actor.teamId, mailboxId, plan);
    }
    return operation(tx);
  });
}

/** Trusted server-side send admission. The session actor must own the box now;
 * readers and draft delegates cannot enqueue a message. Keep locks through capture.
 */
export function withMailboxWriteAccess<T>(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  operation: (tx: Db) => Promise<T>,
): Promise<T> {
  return scoped(db, { ...actor }, mailboxId, "owner", true, operation);
}

/** Human owner metadata access; permits organization of retained data without renewing billing. */
export function withMailboxOrganizationAccess<T>(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  operation: (tx: Db) => Promise<T>,
): Promise<T> {
  if (actor.agentAccess) throw new MailboxContentError("forbidden");
  return scoped(db, { ...actor }, mailboxId, "owner", false, operation, true);
}

/** Owner-only import for local qualification/export restore. No inbound transport is activated. */
export async function importMailboxMime(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string; sourceId: string; raw: Buffer },
) {
  actor = { ...actor };
  input = { ...input };
  const raw = bytes(input.raw);
  if (typeof input.sourceId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.sourceId))
    throw new MailboxContentError("invalid");
  return scoped(db, actor, input.mailboxId, "owner", true, async (tx) => {
    const [previous] = await tx
      .select()
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.mailboxId, input.mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
          eq(schema.mailboxItems.sourceId, input.sourceId),
        ),
      );
    if (previous) {
      if (!(await open(previous, keyring)).equals(raw)) throw new MailboxContentError("conflict");
      return summary(previous);
    }
    const id = randomUUID();
    const plan = await lockMailboxService(tx, actor.teamId);
    await assertMailboxStorage(tx, actor.teamId, input.mailboxId, raw.length, plan);
    const sealed = await encryptPayload(
      raw,
      keyring,
      binding({ teamId: actor.teamId, mailboxId: input.mailboxId, id }),
    );
    const [item] = await tx
      .insert(schema.mailboxItems)
      .values({
        id,
        mailboxId: input.mailboxId,
        teamId: actor.teamId,
        kind: "inbox",
        sourceId: input.sourceId,
        rawBytes: raw.length,
        ...sealed,
      })
      .returning();
    if (!item) throw new Error("Private mailbox import returned no item");
    return summary(item);
  });
}

/** MIME, subject, body and attachment bytes travel together inside one private envelope. */
export async function readMailboxItem(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string },
) {
  return withMailboxItem(db, keyring, actor, input, async (item) => item);
}

/** Authorize a completed aggregate under one transaction before returning private DTOs. */
export async function withMailboxContentAccess<T>(
  db: Db,
  actor: MailboxContentActor,
  mailboxIds: string[],
  operation: (tx: Db) => Promise<T>,
): Promise<T> {
  actor = { ...actor };
  const ids = [...new Set(mailboxIds)].sort();
  if (actor.supportView) throw new MailboxContentError("forbidden");
  if (ids.length > 20) throw new MailboxContentError("invalid");
  const visit = (tx: Db, index: number): Promise<T> =>
    index === ids.length
      ? operation(tx)
      : scoped(tx, actor, ids[index]!, "read", false, (locked) => visit(locked, index + 1));
  return visit(db, 0);
}

/** Keep authorization locks through parsing/DTO or binary response construction. */
export async function withMailboxItem<T>(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string },
  operation: (item: ReturnType<typeof summary> & { raw: Buffer }) => Promise<T>,
): Promise<T> {
  actor = { ...actor };
  input = { ...input };
  return scoped(db, actor, input.mailboxId, "read", false, async (tx) => {
    const [item] = await tx
      .select()
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.id, input.id),
          eq(schema.mailboxItems.mailboxId, input.mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
        ),
      );
    if (!item) throw new MailboxContentError("not_found");
    if (
      item.deliveryFolder === "quarantine" ||
      item.inboundAssessment?.decision === "quarantine" ||
      (actor.agentAccess && item.trashedAt !== null) ||
      (actor.agentAccess && item.kind === "inbox" && item.deliveryFolder !== "inbox")
    )
      throw new MailboxContentError("forbidden");
    return operation({ ...summary(item), raw: await open(item, keyring) });
  });
}

/** Bounded metadata listing. Content is decrypted only by a separate authorized read. */
export async function listMailboxItems(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  filter?: {
    kind?: "inbox" | "draft" | "sent";
    deliveryFolder?: "inbox" | "spam" | "quarantine";
    trashed?: boolean;
    starred?: boolean;
    folderId?: string | null;
    safeOnly?: boolean;
  },
) {
  actor = { ...actor };
  filter = filter ? { ...filter } : undefined;
  if (actor.agentAccess && filter?.trashed) throw new MailboxContentError("forbidden");
  return scoped(db, actor, mailboxId, "read", false, async (tx) => {
    const items = await tx
      .select({
        id: schema.mailboxItems.id,
        mailboxId: schema.mailboxItems.mailboxId,
        kind: schema.mailboxItems.kind,
        deliveryFolder: schema.mailboxItems.deliveryFolder,
        inboundAssessment: schema.mailboxItems.inboundAssessment,
        trashedAt: schema.mailboxItems.trashedAt,
        starredAt: schema.mailboxItems.starredAt,
        folderId: schema.mailboxItems.folderId,
        revision: schema.mailboxItems.revision,
        createdAt: schema.mailboxItems.createdAt,
        updatedAt: schema.mailboxItems.updatedAt,
      })
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.mailboxId, mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
          ...(filter?.kind ? [eq(schema.mailboxItems.kind, filter.kind)] : []),
          filter?.trashed === true && !actor.agentAccess
            ? isNotNull(schema.mailboxItems.trashedAt)
            : isNull(schema.mailboxItems.trashedAt),
          ...(filter?.deliveryFolder
            ? [eq(schema.mailboxItems.deliveryFolder, filter.deliveryFolder)]
            : []),
          ...(filter?.starred ? [isNotNull(schema.mailboxItems.starredAt)] : []),
          ...(filter?.folderId === null
            ? [isNull(schema.mailboxItems.folderId)]
            : filter?.folderId
              ? [eq(schema.mailboxItems.folderId, filter.folderId)]
              : []),
          ...(filter?.safeOnly ? [eq(schema.mailboxItems.deliveryFolder, "inbox")] : []),
          ...(actor.agentAccess ? [eq(schema.mailboxItems.deliveryFolder, "inbox")] : []),
        ),
      )
      .orderBy(desc(schema.mailboxItems.createdAt), desc(schema.mailboxItems.id))
      .limit(100);
    return items;
  });
}

/** Human owner review only. Classification never releases quarantined bytes or trusts a sender. */
export async function setMailboxDeliveryFolder(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; folder: "inbox" | "spam" },
) {
  actor = { ...actor };
  input = { ...input };
  if (actor.agentAccess) throw new MailboxContentError("forbidden");
  if (
    !["inbox", "spam"].includes(input.folder) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    input.expectedRevision >= 2147483647
  )
    throw new MailboxContentError("invalid");
  return scoped(db, actor, input.mailboxId, "owner", false, async (tx) => {
    const [item] = await tx
      .select()
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.id, input.id),
          eq(schema.mailboxItems.mailboxId, input.mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
        ),
      )
      .for("update");
    if (!item) throw new MailboxContentError("not_found");
    if (
      item.kind !== "inbox" ||
      item.deliveryFolder === "quarantine" ||
      item.inboundAssessment?.decision === "quarantine" ||
      item.trashedAt !== null
    )
      throw new MailboxContentError("forbidden");
    if (item.revision !== input.expectedRevision) throw new MailboxContentError("conflict");
    if (item.deliveryFolder === input.folder) return summary(item);
    const [updated] = await tx
      .update(schema.mailboxItems)
      .set({
        deliveryFolder: input.folder,
        revision: item.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.mailboxItems.id, item.id),
          eq(schema.mailboxItems.mailboxId, input.mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
          eq(schema.mailboxItems.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (!updated) throw new MailboxContentError("conflict");
    return summary(updated);
  });
}

/** Reversible owner-only metadata operation. Original MIME, classification,
 * transport facts and storage accounting remain intact, including quarantine.
 */
export async function setMailboxItemTrash(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; trashed: boolean },
  now = new Date(),
) {
  actor = { ...actor };
  input = { ...input };
  if (actor.agentAccess) throw new MailboxContentError("forbidden");
  if (
    typeof input.trashed !== "boolean" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    input.expectedRevision >= 2147483647 ||
    !Number.isFinite(now.getTime())
  )
    throw new MailboxContentError("invalid");
  return scoped(db, actor, input.mailboxId, "owner", false, async (tx) => {
    const [item] = await tx
      .select()
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.id, input.id),
          eq(schema.mailboxItems.mailboxId, input.mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
        ),
      )
      .for("update");
    if (!item) throw new MailboxContentError("not_found");
    if (item.revision !== input.expectedRevision) throw new MailboxContentError("conflict");
    if ((item.trashedAt !== null) === input.trashed) return { ...summary(item), changed: false };
    if (item.kind === "draft") {
      const [pending] = await tx
        .select({ id: schema.mailboxOutbox.id })
        .from(schema.mailboxOutbox)
        .where(
          and(
            eq(schema.mailboxOutbox.teamId, actor.teamId),
            eq(schema.mailboxOutbox.mailboxId, input.mailboxId),
            eq(schema.mailboxOutbox.draftId, item.id),
            ne(schema.mailboxOutbox.status, "failed"),
          ),
        )
        .limit(1);
      if (pending) throw new MailboxContentError("conflict");
    }
    const [updated] = await tx
      .update(schema.mailboxItems)
      .set({ trashedAt: input.trashed ? now : null, revision: item.revision + 1, updatedAt: now })
      .where(
        and(
          eq(schema.mailboxItems.id, item.id),
          eq(schema.mailboxItems.mailboxId, input.mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
          eq(schema.mailboxItems.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (!updated) throw new MailboxContentError("conflict");
    return { ...summary(updated), changed: true };
  });
}

/** Optimistic revision prevents a stale editor from overwriting another saved draft. No send. */
export async function saveMailboxDraft(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string; id?: string; expectedRevision: number; raw: Buffer },
) {
  actor = { ...actor };
  input = { ...input };
  const raw = bytes(input.raw);
  if (
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= 2147483647 ||
    (!input.id && input.expectedRevision !== 0)
  )
    throw new MailboxContentError("invalid");
  return scoped(db, actor, input.mailboxId, "draft", true, async (tx) => {
    const id = input.id ?? randomUUID();
    const [previous] = await tx
      .select()
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.id, id),
          eq(schema.mailboxItems.mailboxId, input.mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
        ),
      );
    if (input.id && !previous) throw new MailboxContentError("not_found");
    if (
      previous &&
      (previous.kind !== "draft" ||
        previous.revision !== input.expectedRevision ||
        previous.trashedAt !== null)
    )
      throw new MailboxContentError("conflict");
    const plan = await lockMailboxService(tx, actor.teamId);
    await assertMailboxStorage(
      tx,
      actor.teamId,
      input.mailboxId,
      raw.length - (previous?.rawBytes ?? 0),
      plan,
    );
    const sealed = await encryptPayload(
      raw,
      keyring,
      binding({ teamId: actor.teamId, mailboxId: input.mailboxId, id }),
    );
    const data = {
      rawBytes: raw.length,
      revision: input.expectedRevision + 1,
      updatedAt: new Date(),
      ...sealed,
    };
    const [item] = previous
      ? await tx
          .update(schema.mailboxItems)
          .set(data)
          .where(
            and(
              eq(schema.mailboxItems.id, id),
              eq(schema.mailboxItems.mailboxId, input.mailboxId),
              eq(schema.mailboxItems.teamId, actor.teamId),
            ),
          )
          .returning()
      : await tx
          .insert(schema.mailboxItems)
          .values({ id, mailboxId: input.mailboxId, teamId: actor.teamId, kind: "draft", ...data })
          .returning();
    if (!item) throw new Error("Private mailbox draft returned no item");
    return summary(item);
  });
}
