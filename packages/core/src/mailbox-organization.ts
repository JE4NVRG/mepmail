import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type MailboxContentActor,
  MailboxContentError,
  withMailboxContentAccess,
  withMailboxOrganizationAccess,
} from "./mailbox-private-store.js";

const MAX_FOLDERS = 50;
const revision = z.number().int().min(1).max(2147483646);
const mailbox = z.object({ mailboxId: z.uuid() }).strict();
const folderMutation = z
  .object({ mailboxId: z.uuid(), id: z.uuid(), expectedRevision: revision })
  .strict();
const itemMutation = folderMutation;
type Folder = typeof schema.mailboxFolders.$inferSelect;
type Item = typeof schema.mailboxItems.$inferSelect;

function parse<T>(validator: z.ZodType<T>, value: unknown): T {
  const result = validator.safeParse(value);
  if (!result.success) throw new MailboxContentError("invalid");
  return result.data;
}
function name(value: string) {
  if (
    typeof value !== "string" ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new MailboxContentError("invalid");
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 80) throw new MailboxContentError("invalid");
  return normalized;
}
function folderDto(folder: Folder) {
  return {
    id: folder.id,
    name: folder.name,
    revision: folder.revision,
    archivedAt: folder.archivedAt,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}
function itemDto(item: Item, changed: boolean) {
  return {
    id: item.id,
    mailboxId: item.mailboxId,
    revision: item.revision,
    starredAt: item.starredAt,
    seenAt: item.seenAt,
    archivedAt: item.archivedAt,
    folderId: item.folderId,
    changed,
  };
}
function validNow(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new MailboxContentError("invalid");
}
async function existingFolder(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string },
) {
  const [folder] = await db
    .select()
    .from(schema.mailboxFolders)
    .where(
      and(
        eq(schema.mailboxFolders.id, input.id),
        eq(schema.mailboxFolders.teamId, actor.teamId),
        eq(schema.mailboxFolders.mailboxId, input.mailboxId),
        isNull(schema.mailboxFolders.archivedAt),
      ),
    )
    .for("update");
  if (!folder) throw new MailboxContentError("not_found");
  return folder;
}
async function uniqueName(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  folderName: string,
  exceptId?: string,
) {
  const [duplicate] = await db
    .select({ id: schema.mailboxFolders.id })
    .from(schema.mailboxFolders)
    .where(
      and(
        eq(schema.mailboxFolders.teamId, actor.teamId),
        eq(schema.mailboxFolders.mailboxId, mailboxId),
        isNull(schema.mailboxFolders.archivedAt),
        sql`lower(${schema.mailboxFolders.name}) = lower(${folderName})`,
      ),
    )
    .limit(1);
  if (duplicate && duplicate.id !== exceptId) throw new MailboxContentError("conflict");
}

/** Names are private mailbox metadata: live read grants apply, team admin is insufficient. */
export async function listMailboxFolders(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string },
) {
  actor = { ...actor };
  const parsed = parse(mailbox, input);
  return withMailboxContentAccess(db, actor, [parsed.mailboxId], async (tx) => {
    const folders = await tx
      .select()
      .from(schema.mailboxFolders)
      .where(
        and(
          eq(schema.mailboxFolders.teamId, actor.teamId),
          eq(schema.mailboxFolders.mailboxId, parsed.mailboxId),
          isNull(schema.mailboxFolders.archivedAt),
        ),
      )
      .orderBy(asc(schema.mailboxFolders.name), asc(schema.mailboxFolders.id))
      .limit(MAX_FOLDERS);
    return folders.map(folderDto);
  });
}

export async function createMailboxFolder(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; name: string },
) {
  actor = { ...actor };
  const parsed = parse(mailbox.extend({ name: z.string() }).strict(), input);
  const folderName = name(parsed.name);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    await uniqueName(tx, actor, parsed.mailboxId, folderName);
    const [total] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.mailboxFolders)
      .where(
        and(
          eq(schema.mailboxFolders.teamId, actor.teamId),
          eq(schema.mailboxFolders.mailboxId, parsed.mailboxId),
          isNull(schema.mailboxFolders.archivedAt),
        ),
      );
    if ((total?.count ?? 0) >= MAX_FOLDERS) throw new MailboxContentError("conflict");
    const [folder] = await tx
      .insert(schema.mailboxFolders)
      .values({ teamId: actor.teamId, mailboxId: parsed.mailboxId, name: folderName })
      .returning();
    if (!folder) throw new Error("Private mailbox folder insert returned no row");
    return { ...folderDto(folder), changed: true };
  });
}

export async function updateMailboxFolder(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; name: string },
) {
  actor = { ...actor };
  const parsed = parse(folderMutation.extend({ name: z.string() }).strict(), input);
  const folderName = name(parsed.name);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    const folder = await existingFolder(tx, actor, parsed);
    if (folder.revision !== parsed.expectedRevision) throw new MailboxContentError("conflict");
    if (folder.name === folderName) return { ...folderDto(folder), changed: false };
    await uniqueName(tx, actor, parsed.mailboxId, folderName, folder.id);
    const [updated] = await tx
      .update(schema.mailboxFolders)
      .set({ name: folderName, revision: folder.revision + 1, updatedAt: new Date() })
      .where(
        and(
          eq(schema.mailboxFolders.id, folder.id),
          eq(schema.mailboxFolders.teamId, actor.teamId),
          eq(schema.mailboxFolders.mailboxId, parsed.mailboxId),
          eq(schema.mailboxFolders.revision, parsed.expectedRevision),
        ),
      )
      .returning();
    if (!updated) throw new MailboxContentError("conflict");
    return { ...folderDto(updated), changed: true };
  });
}

async function mutableItem(
  tx: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number },
) {
  const [item] = await tx
    .select()
    .from(schema.mailboxItems)
    .where(
      and(
        eq(schema.mailboxItems.id, input.id),
        eq(schema.mailboxItems.teamId, actor.teamId),
        eq(schema.mailboxItems.mailboxId, input.mailboxId),
      ),
    )
    .for("update");
  if (!item) throw new MailboxContentError("not_found");
  if (item.revision !== input.expectedRevision) throw new MailboxContentError("conflict");
  if (
    item.trashedAt !== null ||
    item.deliveryFolder !== "inbox" ||
    item.inboundAssessment?.decision === "quarantine"
  )
    throw new MailboxContentError("forbidden");
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
  return item;
}

/** Metadata never changes MIME, safety classification, recipient reservations or storage. */
export async function setMailboxItemStar(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; starred: boolean },
  now = new Date(),
) {
  actor = { ...actor };
  const parsed = parse(itemMutation.extend({ starred: z.boolean() }).strict(), input);
  validNow(now);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    const item = await mutableItem(tx, actor, parsed);
    if ((item.starredAt !== null) === parsed.starred) return itemDto(item, false);
    const [updated] = await tx
      .update(schema.mailboxItems)
      .set({ starredAt: parsed.starred ? now : null, revision: item.revision + 1, updatedAt: now })
      .where(
        and(
          eq(schema.mailboxItems.id, item.id),
          eq(schema.mailboxItems.teamId, actor.teamId),
          eq(schema.mailboxItems.mailboxId, parsed.mailboxId),
          eq(schema.mailboxItems.revision, parsed.expectedRevision),
        ),
      )
      .returning();
    if (!updated) throw new MailboxContentError("conflict");
    return itemDto(updated, true);
  });
}

export async function setMailboxItemFolder(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; folderId: string | null },
  now = new Date(),
) {
  actor = { ...actor };
  const parsed = parse(itemMutation.extend({ folderId: z.uuid().nullable() }).strict(), input);
  validNow(now);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    if (parsed.folderId)
      await existingFolder(tx, actor, { mailboxId: parsed.mailboxId, id: parsed.folderId });
    const item = await mutableItem(tx, actor, parsed);
    if (item.folderId === parsed.folderId) return itemDto(item, false);
    const [updated] = await tx
      .update(schema.mailboxItems)
      // Filing an archived message takes it out of the archive, into that folder.
      .set({
        folderId: parsed.folderId,
        archivedAt: null,
        revision: item.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.mailboxItems.id, item.id),
          eq(schema.mailboxItems.teamId, actor.teamId),
          eq(schema.mailboxItems.mailboxId, parsed.mailboxId),
          eq(schema.mailboxItems.revision, parsed.expectedRevision),
        ),
      )
      .returning();
    if (!updated) throw new MailboxContentError("conflict");
    return itemDto(updated, true);
  });
}

/**
 * Archiving takes a message out of the inbox (or out of a named folder) into
 * the Archive view; un-archiving returns it to its ordinary folder. Drafts are
 * not archived: they live in Drafts until sent or discarded.
 */
export async function setMailboxItemArchive(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; archived: boolean },
  now = new Date(),
) {
  actor = { ...actor };
  const parsed = parse(itemMutation.extend({ archived: z.boolean() }).strict(), input);
  validNow(now);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    const item = await mutableItem(tx, actor, parsed);
    if (item.kind === "draft") throw new MailboxContentError("forbidden");
    if ((item.archivedAt !== null) === parsed.archived) return itemDto(item, false);
    const [updated] = await tx
      .update(schema.mailboxItems)
      .set({
        archivedAt: parsed.archived ? now : null,
        ...(parsed.archived ? { folderId: null } : {}),
        revision: item.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.mailboxItems.id, item.id),
          eq(schema.mailboxItems.teamId, actor.teamId),
          eq(schema.mailboxItems.mailboxId, parsed.mailboxId),
          eq(schema.mailboxItems.revision, parsed.expectedRevision),
        ),
      )
      .returning();
    if (!updated) throw new MailboxContentError("conflict");
    return itemDto(updated, true);
  });
}

/**
 * Read state is the owner's view of a received message, not its content: it
 * never bumps revision or updatedAt, so open editors, pending approvals and
 * list order stay untouched. Quarantined bytes are never "read".
 */
export async function setMailboxItemSeen(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; seen: boolean },
  now = new Date(),
) {
  actor = { ...actor };
  const parsed = parse(
    z.object({ mailboxId: z.uuid(), id: z.uuid(), seen: z.boolean() }).strict(),
    input,
  );
  validNow(now);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    const where = and(
      eq(schema.mailboxItems.id, parsed.id),
      eq(schema.mailboxItems.teamId, actor.teamId),
      eq(schema.mailboxItems.mailboxId, parsed.mailboxId),
    );
    const [item] = await tx.select().from(schema.mailboxItems).where(where).for("update");
    if (!item) throw new MailboxContentError("not_found");
    if (
      item.kind !== "inbox" ||
      item.deliveryFolder === "quarantine" ||
      item.inboundAssessment?.decision === "quarantine"
    )
      throw new MailboxContentError("forbidden");
    if ((item.seenAt !== null) === parsed.seen) return itemDto(item, false);
    const [updated] = await tx
      .update(schema.mailboxItems)
      .set({ seenAt: parsed.seen ? now : null })
      .where(where)
      .returning();
    if (!updated) throw new MailboxContentError("conflict");
    return itemDto(updated, true);
  });
}

/** Archive returns messages to their original ordinary folders; no message/folder is deleted. */
export async function archiveMailboxFolder(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number },
  now = new Date(),
) {
  actor = { ...actor };
  const parsed = parse(folderMutation, input);
  validNow(now);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    const folder = await existingFolder(tx, actor, parsed);
    if (folder.revision !== parsed.expectedRevision) throw new MailboxContentError("conflict");
    const match = and(
      eq(schema.mailboxItems.teamId, actor.teamId),
      eq(schema.mailboxItems.mailboxId, parsed.mailboxId),
      eq(schema.mailboxItems.folderId, folder.id),
    );
    const [overflow] = await tx
      .select({ id: schema.mailboxItems.id })
      .from(schema.mailboxItems)
      .where(and(match, sql`${schema.mailboxItems.revision} >= 2147483647`))
      .limit(1);
    const [pending] = await tx
      .select({ id: schema.mailboxOutbox.id })
      .from(schema.mailboxOutbox)
      .innerJoin(
        schema.mailboxItems,
        and(
          eq(schema.mailboxOutbox.draftId, schema.mailboxItems.id),
          eq(schema.mailboxOutbox.mailboxId, schema.mailboxItems.mailboxId),
          eq(schema.mailboxOutbox.teamId, schema.mailboxItems.teamId),
        ),
      )
      .where(and(match, ne(schema.mailboxOutbox.status, "failed")))
      .limit(1);
    if (overflow || pending) throw new MailboxContentError("conflict");
    await tx
      .update(schema.mailboxItems)
      .set({ folderId: null, revision: sql`${schema.mailboxItems.revision} + 1`, updatedAt: now })
      .where(match);
    const [updated] = await tx
      .update(schema.mailboxFolders)
      .set({ archivedAt: now, revision: folder.revision + 1, updatedAt: now })
      .where(
        and(
          eq(schema.mailboxFolders.id, folder.id),
          eq(schema.mailboxFolders.teamId, actor.teamId),
          eq(schema.mailboxFolders.mailboxId, parsed.mailboxId),
          eq(schema.mailboxFolders.revision, parsed.expectedRevision),
        ),
      )
      .returning();
    if (!updated) throw new MailboxContentError("conflict");
    return { ...folderDto(updated), changed: true };
  });
}
