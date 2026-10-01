import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  BOUND_ENVELOPE_VERSION_OFFSET,
  decryptPayload,
  encryptPayload,
} from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import type { MailboxRegistryActor } from "./mailbox-registry.js";

/** Actor comes from a trusted session adapter, never from an HTTP body or API key. */
export interface MailboxContentActor extends MailboxRegistryActor {
  supportView?: boolean;
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
): Promise<T> {
  if (actor.supportView) throw new MailboxContentError("forbidden");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
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
    const query = tx
      .select()
      .from(schema.mailboxes)
      .where(and(eq(schema.mailboxes.id, mailboxId), eq(schema.mailboxes.teamId, actor.teamId)));
    const [mailbox] = await (change ? query.for("update") : query.for("share"));
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
    return operation(tx);
  });
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
  operation: () => Promise<T>,
): Promise<T> {
  actor = { ...actor };
  const ids = [...new Set(mailboxIds)].sort();
  if (actor.supportView) throw new MailboxContentError("forbidden");
  if (ids.length > 20) throw new MailboxContentError("invalid");
  const visit = (tx: Db, index: number): Promise<T> =>
    index === ids.length
      ? operation()
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
    return operation({ ...summary(item), raw: await open(item, keyring) });
  });
}

/** Bounded metadata listing. Content is decrypted only by a separate authorized read. */
export async function listMailboxItems(db: Db, actor: MailboxContentActor, mailboxId: string) {
  actor = { ...actor };
  return scoped(db, actor, mailboxId, "read", false, async (tx) => {
    const items = await tx
      .select({
        id: schema.mailboxItems.id,
        mailboxId: schema.mailboxItems.mailboxId,
        kind: schema.mailboxItems.kind,
        revision: schema.mailboxItems.revision,
        createdAt: schema.mailboxItems.createdAt,
        updatedAt: schema.mailboxItems.updatedAt,
      })
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.mailboxId, mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
        ),
      )
      .orderBy(desc(schema.mailboxItems.createdAt), desc(schema.mailboxItems.id))
      .limit(100);
    return items;
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
    if (previous && (previous.kind !== "draft" || previous.revision !== input.expectedRevision))
      throw new MailboxContentError("conflict");
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
