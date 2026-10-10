import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
import { mailboxThreadKeys } from "./mailbox-thread.js";

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
/**
 * Received and imported mail is kept up to 25 MiB (Gmail's limit, under SES's
 * 40 MB): a message from outside cannot be held to what our composer writes.
 * Drafts keep the composer's 1 MiB.
 */
const MAX_STORED_MIME_BYTES = 25 * 1024 * 1024;
const MAX_DRAFT_MIME_BYTES = 1024 * 1024;

function bytes(raw: Buffer, max = MAX_STORED_MIME_BYTES) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > max)
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
    seenAt: item.seenAt,
    archivedAt: item.archivedAt,
    folderId: item.folderId,
    snoozedUntil: item.snoozedUntil,
    resurfacedAt: item.resurfacedAt,
    pinnedAt: item.pinnedAt,
    sendAt: item.sendAt,
    sendFailure: item.sendFailure,
    remindAt: item.remindAt,
    remindedAt: item.remindedAt,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
/** The list summary's own row namespace: it never opens as the body, nor the body as it. */
function summaryBinding(item: { teamId: string; mailboxId: string; id: string }) {
  return {
    teamId: item.teamId,
    rowId: `mailbox-list-summary-v1:${item.mailboxId}:${item.id}`,
    kind: "email_body" as const,
  };
}
/** Sealed summaries stay small: a list row is a few short fields. */
export const MAILBOX_LIST_SUMMARY_MAX_BYTES = 8 * 1024;
/** The stored list summary, or null when there is none or it does not open
 * (the caller then rebuilds it from the message). */
async function openListSummary(item: Item, keyring: Keyring): Promise<Buffer | null> {
  if (
    !item.summaryCiphertext ||
    !item.summaryIv ||
    !item.summaryWrappedDek ||
    item.summaryKeyVersion === null
  )
    return null;
  try {
    const plain = await decryptPayload(
      {
        ciphertext: item.summaryCiphertext,
        iv: item.summaryIv,
        wrappedDek: item.summaryWrappedDek,
        keyVersion: item.summaryKeyVersion,
      },
      keyring,
      summaryBinding(item),
    );
    return plain.length <= MAILBOX_LIST_SUMMARY_MAX_BYTES ? plain : null;
  } catch {
    return null;
  }
}
/** Columns that drop a stored summary (a draft whose content changed). */
const NO_LIST_SUMMARY = {
  summaryCiphertext: null,
  summaryIv: null,
  summaryWrappedDek: null,
  summaryKeyVersion: null,
} as const;
async function open(item: Item, keyring: Keyring) {
  if (item.keyVersion < BOUND_ENVELOPE_VERSION_OFFSET)
    throw new Error("Private mailbox requires a bound envelope");
  const raw = await decryptPayload(item, keyring, binding(item));
  if (raw.length !== item.rawBytes || raw.length > MAX_STORED_MIME_BYTES)
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
/**
 * How an imported message sat in its old mailbox (IMAP history import): its
 * kind, when it arrived (INTERNALDATE), whether it was read, archived or in
 * a named folder. The row keeps that time and state, so old mail sorts into
 * place and is never presented as new.
 */
export interface MailboxImportHistory {
  kind: "inbox" | "sent";
  receivedAt: Date;
  seen: boolean;
  archived: boolean;
  folderId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Received times from 1970 up to a day ahead (clock skew); anything else is refused. */
function historyTime(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new MailboxContentError("invalid");
  if (value.getTime() < 0 || value.getTime() > Date.now() + 86_400_000)
    throw new MailboxContentError("invalid");
  return new Date(value.getTime());
}

export async function importMailboxMime(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string; sourceId: string; raw: Buffer; history?: MailboxImportHistory },
) {
  actor = { ...actor };
  input = { ...input };
  const raw = bytes(input.raw);
  if (typeof input.sourceId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.sourceId))
    throw new MailboxContentError("invalid");
  const history = input.history
    ? {
        kind: input.history.kind,
        receivedAt: historyTime(input.history.receivedAt),
        seen: input.history.seen === true,
        archived: input.history.archived === true,
        folderId: input.history.folderId ?? null,
      }
    : null;
  if (history && history.kind !== "inbox" && history.kind !== "sent")
    throw new MailboxContentError("invalid");
  if (history?.folderId !== null && history?.folderId !== undefined && !UUID.test(history.folderId))
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
    // A named folder must be one of this mailbox's own, still in use.
    if (history?.folderId) {
      const [folder] = await tx
        .select({ id: schema.mailboxFolders.id })
        .from(schema.mailboxFolders)
        .where(
          and(
            eq(schema.mailboxFolders.id, history.folderId),
            eq(schema.mailboxFolders.mailboxId, input.mailboxId),
            eq(schema.mailboxFolders.teamId, actor.teamId),
            isNull(schema.mailboxFolders.archivedAt),
          ),
        );
      if (!folder) throw new MailboxContentError("invalid");
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
        kind: history?.kind ?? "inbox",
        sourceId: input.sourceId,
        rawBytes: raw.length,
        ...(history
          ? {
              createdAt: history.receivedAt,
              seenAt: history.seen ? history.receivedAt : null,
              archivedAt: history.archived ? history.receivedAt : null,
              folderId: history.folderId,
            }
          : {}),
        ...mailboxThreadKeys(raw),
        ...sealed,
      })
      .returning();
    if (!item) throw new Error("Private mailbox import returned no item");
    return summary(item);
  });
}

const THREAD_KEY = /^[a-f0-9]{32}$/;
/** The live messages of a conversation: received (outside spam/quarantine) and sent. */
const conversationMember = (mailboxId: string, teamId: string) => [
  eq(schema.mailboxItems.mailboxId, mailboxId),
  eq(schema.mailboxItems.teamId, teamId),
  isNull(schema.mailboxItems.trashedAt),
  inArray(schema.mailboxItems.kind, ["inbox", "sent"]),
  eq(schema.mailboxItems.deliveryFolder, "inbox"),
];

/**
 * Each listed conversation in one mailbox: its live messages and how many of the
 * received ones the owner has not opened yet (for the list's count and unread mark).
 */
export function summarizeMailboxThreads(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  threadKeys: (string | null)[],
): Promise<Map<string, { count: number; unread: number }>> {
  return threadSummary(db, actor, mailboxId, threadKeys, 101);
}
async function threadSummary(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  threadKeys: (string | null)[],
  cap: number,
): Promise<Map<string, { count: number; unread: number }>> {
  actor = { ...actor };
  const keys = [
    ...new Set(threadKeys.filter((key): key is string => !!key && THREAD_KEY.test(key))),
  ].slice(0, cap);
  if (!keys.length) return new Map();
  return scoped(db, actor, mailboxId, "read", false, async (tx) => {
    const rows = await tx
      .select({
        threadKey: schema.mailboxItems.threadKey,
        count: sql<number>`count(*)::int`,
        unread: sql<number>`(count(*) filter (where ${schema.mailboxItems.kind} = 'inbox' and ${schema.mailboxItems.seenAt} is null))::int`,
      })
      .from(schema.mailboxItems)
      .where(
        and(
          ...conversationMember(mailboxId, actor.teamId),
          inArray(schema.mailboxItems.threadKey, keys),
        ),
      )
      .groupBy(schema.mailboxItems.threadKey);
    return new Map(
      rows.map((row) => [
        row.threadKey as string,
        { count: Number(row.count), unread: Number(row.unread) },
      ]),
    );
  });
}

/** How many live messages each listed conversation has in one mailbox (for the list's count). */
export async function countMailboxThreads(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  threadKeys: (string | null)[],
): Promise<Map<string, number>> {
  const summary = await threadSummary(db, actor, mailboxId, threadKeys, 100);
  return new Map([...summary].map(([key, value]) => [key, value.count]));
}

/** The conversation an item belongs to, oldest first and bounded; content stays sealed here. */
export async function listMailboxThread(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string },
) {
  actor = { ...actor };
  input = { ...input };
  return scoped(db, actor, input.mailboxId, "read", false, async (tx) => {
    const [anchor] = await tx
      .select({ threadKey: schema.mailboxItems.threadKey })
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.id, input.id),
          eq(schema.mailboxItems.mailboxId, input.mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
        ),
      );
    if (!anchor) throw new MailboxContentError("not_found");
    if (!anchor.threadKey) return [];
    return tx
      .select({
        id: schema.mailboxItems.id,
        mailboxId: schema.mailboxItems.mailboxId,
        kind: schema.mailboxItems.kind,
        createdAt: schema.mailboxItems.createdAt,
      })
      .from(schema.mailboxItems)
      .where(
        and(
          ...conversationMember(input.mailboxId, actor.teamId),
          eq(schema.mailboxItems.threadKey, anchor.threadKey),
        ),
      )
      .orderBy(asc(schema.mailboxItems.createdAt), asc(schema.mailboxItems.id))
      .limit(25);
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

/**
 * Several items of one mailbox under one authorization: what a list page needs.
 * Envelopes open a few at a time instead of one transaction per row. Items
 * withMailboxItem would refuse (quarantined; for agents, trashed or unsafe)
 * are left out. The operation runs inside the same locks, like withMailboxItem.
 */
export async function withMailboxItems<T>(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string; ids: string[] },
  operation: (items: (ReturnType<typeof summary> & { raw: Buffer })[]) => Promise<T>,
  concurrency = 8,
): Promise<T> {
  actor = { ...actor };
  const ids = [...new Set(input.ids)];
  if (ids.length > 101) throw new MailboxContentError("invalid");
  return scoped(db, actor, input.mailboxId, "read", false, async (tx) => {
    const found = ids.length
      ? await tx
          .select()
          .from(schema.mailboxItems)
          .where(
            and(
              inArray(schema.mailboxItems.id, ids),
              eq(schema.mailboxItems.mailboxId, input.mailboxId),
              eq(schema.mailboxItems.teamId, actor.teamId),
            ),
          )
      : [];
    const allowed = found.filter(
      (item) =>
        item.deliveryFolder !== "quarantine" &&
        item.inboundAssessment?.decision !== "quarantine" &&
        !(actor.agentAccess && item.trashedAt !== null) &&
        !(actor.agentAccess && item.kind === "inbox" && item.deliveryFolder !== "inbox"),
    );
    const opened: (ReturnType<typeof summary> & { raw: Buffer })[] = new Array(allowed.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, concurrency), allowed.length) }, async () => {
        while (next < allowed.length) {
          const index = next++;
          const item = allowed[index]!;
          opened[index] = { ...summary(item), raw: await open(item, keyring) };
        }
      }),
    );
    return operation(opened);
  });
}

export type MailboxListContent = ReturnType<typeof summary> &
  (
    | { listSummary: Buffer; raw: null; unreadableSummary: false }
    /** `unreadableSummary`: one is stored but does not open; storing a new one replaces it. */
    | { listSummary: null; raw: Buffer; unreadableSummary: boolean }
  );

/**
 * What a list page needs from several items of one mailbox, under one
 * authorization (the same exclusions as withMailboxItems): the sealed list
 * summary when one is stored, a few hundred bytes, and otherwise the message
 * itself so the caller can project the row and store a summary for next time.
 */
export async function withMailboxListContents<T>(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string; ids: string[] },
  operation: (items: MailboxListContent[]) => Promise<T>,
  concurrency = 8,
): Promise<T> {
  actor = { ...actor };
  const ids = [...new Set(input.ids)];
  if (ids.length > 101) throw new MailboxContentError("invalid");
  return scoped(db, actor, input.mailboxId, "read", false, async (tx) => {
    const found = ids.length
      ? await tx
          .select()
          .from(schema.mailboxItems)
          .where(
            and(
              inArray(schema.mailboxItems.id, ids),
              eq(schema.mailboxItems.mailboxId, input.mailboxId),
              eq(schema.mailboxItems.teamId, actor.teamId),
            ),
          )
      : [];
    const allowed = found.filter(
      (item) =>
        item.deliveryFolder !== "quarantine" &&
        item.inboundAssessment?.decision !== "quarantine" &&
        !(actor.agentAccess && item.trashedAt !== null) &&
        !(actor.agentAccess && item.kind === "inbox" && item.deliveryFolder !== "inbox"),
    );
    const opened: MailboxListContent[] = new Array(allowed.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, concurrency), allowed.length) }, async () => {
        while (next < allowed.length) {
          const index = next++;
          const item = allowed[index]!;
          const listSummary = await openListSummary(item, keyring);
          opened[index] = listSummary
            ? { ...summary(item), listSummary, raw: null, unreadableSummary: false }
            : {
                ...summary(item),
                listSummary: null,
                raw: await open(item, keyring),
                unreadableSummary: item.summaryCiphertext !== null,
              };
        }
      }),
    );
    return operation(opened);
  });
}

/**
 * Stores list summaries the caller projected from each item's own message
 * (never from request input), for rows that have none yet, or replacing one in
 * an older format or that no longer opens (`replace`). A draft is skipped
 * when its revision moved since it was read, so a summary never describes an
 * older version; received and sent messages never change content. A cache:
 * nothing else changes on the row (no revision, no updatedAt).
 */
export async function storeMailboxListSummaries(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: {
    mailboxId: string;
    /** `replace`: the row's summary is from an older format and is rewritten. */
    entries: { id: string; revision: number; summary: Buffer; replace?: boolean }[];
  },
): Promise<number> {
  actor = { ...actor };
  const entries = input.entries.filter(
    (entry) =>
      Buffer.isBuffer(entry.summary) &&
      entry.summary.length > 0 &&
      entry.summary.length <= MAILBOX_LIST_SUMMARY_MAX_BYTES,
  );
  if (!entries.length) return 0;
  if (entries.length > 101) throw new MailboxContentError("invalid");
  return scoped(db, actor, input.mailboxId, "read", false, async (tx) => {
    let stored = 0;
    for (const entry of entries) {
      const sealed = await encryptPayload(
        Buffer.from(entry.summary),
        keyring,
        summaryBinding({ teamId: actor.teamId, mailboxId: input.mailboxId, id: entry.id }),
      );
      const updated = await tx
        .update(schema.mailboxItems)
        .set({
          summaryCiphertext: sealed.ciphertext,
          summaryIv: sealed.iv,
          summaryWrappedDek: sealed.wrappedDek,
          summaryKeyVersion: sealed.keyVersion,
        })
        .where(
          and(
            eq(schema.mailboxItems.id, entry.id),
            eq(schema.mailboxItems.mailboxId, input.mailboxId),
            eq(schema.mailboxItems.teamId, actor.teamId),
            // A message never changes, so rewriting an outdated summary from it is
            // safe; a draft must still be at the revision that was read.
            entry.replace ? undefined : isNull(schema.mailboxItems.summaryCiphertext),
            or(
              ne(schema.mailboxItems.kind, "draft"),
              eq(schema.mailboxItems.revision, entry.revision),
            ),
          ),
        )
        .returning({ id: schema.mailboxItems.id });
      stored += updated.length;
    }
    return stored;
  });
}

export interface MailboxListFilter {
  kind?: "inbox" | "draft" | "sent";
  deliveryFolder?: "inbox" | "spam" | "quarantine";
  trashed?: boolean;
  starred?: boolean;
  folderId?: string | null;
  safeOnly?: boolean;
  /** true: the Archive view; false: views that archived items leave. */
  archived?: boolean;
  /** true: the Snoozed view (still snoozed now); false: views a snoozed item leaves. */
  snoozed?: boolean;
  /** true: pinned items only. */
  pinned?: boolean;
  /** true: drafts waiting to be sent later. */
  scheduled?: boolean;
  /** true: sent messages whose follow-up came due with no reply in their conversation. */
  followUp?: boolean;
}
/** A position in a listing: the row's order time in epoch microseconds, then its id. */
export interface MailboxListPosition {
  at: string;
  id: string;
}
const LIST_POSITION_AT = /^[0-9]{1,17}$/;
const LIST_POSITION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type ItemColumns = typeof schema.mailboxItems;

/**
 * Arrival time (or when a snoozed message came back); a draft by its last edit.
 * The order every listing shows, its cursor and the conversation grouping all
 * read this one expression.
 */
function listOrder(items: ItemColumns, kind: MailboxListFilter["kind"]) {
  const arrival = sql`coalesce(${items.resurfacedAt}, ${items.createdAt})`;
  if (kind === "draft") return sql`${items.updatedAt}`;
  if (kind) return arrival;
  return sql`(case when ${items.kind} = 'draft' then ${items.updatedAt} else ${arrival} end)`;
}
/** Snoozed right now: it counts again on its own once the time passes. */
const snoozedNow = (items: ItemColumns) =>
  sql`(${items.snoozedUntil} is not null and ${items.snoozedUntil} > now())`;
/** A received message in the same conversation, after this one was sent. */
function replyAfter(items: ItemColumns) {
  const reply = alias(schema.mailboxItems, "follow_up_reply");
  return sql`exists (select 1 from ${schema.mailboxItems} ${reply} where ${reply.mailboxId} = ${items.mailboxId} and ${reply.teamId} = ${items.teamId} and ${reply.kind} = 'inbox' and ${reply.trashedAt} is null and ${items.threadKey} is not null and ${reply.threadKey} = ${items.threadKey} and ${reply.createdAt} > ${items.createdAt})`;
}
function listConditions(
  items: ItemColumns,
  actor: MailboxContentActor,
  mailboxId: string,
  filter: MailboxListFilter | undefined,
) {
  return [
    eq(items.mailboxId, mailboxId),
    eq(items.teamId, actor.teamId),
    ...(filter?.kind ? [eq(items.kind, filter.kind)] : []),
    filter?.trashed === true && !actor.agentAccess
      ? isNotNull(items.trashedAt)
      : isNull(items.trashedAt),
    ...(filter?.deliveryFolder ? [eq(items.deliveryFolder, filter.deliveryFolder)] : []),
    ...(filter?.starred ? [isNotNull(items.starredAt)] : []),
    ...(filter?.archived === true
      ? [isNotNull(items.archivedAt)]
      : filter?.archived === false
        ? [isNull(items.archivedAt)]
        : []),
    ...(filter?.folderId === null
      ? [isNull(items.folderId)]
      : filter?.folderId
        ? [eq(items.folderId, filter.folderId)]
        : []),
    ...(filter?.safeOnly ? [eq(items.deliveryFolder, "inbox")] : []),
    ...(actor.agentAccess ? [eq(items.deliveryFolder, "inbox")] : []),
    ...(filter?.snoozed === true
      ? [snoozedNow(items)]
      : filter?.snoozed === false
        ? [sql`not ${snoozedNow(items)}`]
        : []),
    ...(filter?.pinned ? [isNotNull(items.pinnedAt)] : []),
    ...(filter?.scheduled ? [isNotNull(items.sendAt)] : []),
    ...(filter?.followUp ? [isNotNull(items.remindedAt), sql`not ${replyAfter(items)}`] : []),
  ];
}
/** Exact to the microsecond: integer arithmetic, no float round trip. */
const positionTime = (at: string) =>
  sql`(timestamptz 'epoch' + ${at}::bigint * interval '1 microsecond')`;

/**
 * Bounded metadata listing, newest first. Content is decrypted only by a separate
 * authorized read. `before` continues after a row the caller already showed;
 * `latestPerThread` keeps only the newest row of each conversation in this view.
 */
export async function listMailboxItems(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  filter?: MailboxListFilter,
  page?: { before?: MailboxListPosition; limit?: number; latestPerThread?: boolean },
) {
  actor = { ...actor };
  filter = filter ? { ...filter } : undefined;
  page = page ? { ...page, ...(page.before ? { before: { ...page.before } } : {}) } : undefined;
  if (actor.agentAccess && filter?.trashed) throw new MailboxContentError("forbidden");
  const limit = page?.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 101)
    throw new MailboxContentError("invalid");
  const before = page?.before;
  if (before && (!LIST_POSITION_AT.test(before.at) || !LIST_POSITION_ID.test(before.id)))
    throw new MailboxContentError("invalid");
  const items = schema.mailboxItems;
  const order = listOrder(items, filter?.kind);
  return scoped(db, actor, mailboxId, "read", false, async (tx) => {
    const newer = alias(schema.mailboxItems, "newer_in_thread");
    const latest = page?.latestPerThread
      ? [
          or(
            isNull(items.threadKey),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(newer)
                .where(
                  and(
                    ...listConditions(newer as unknown as ItemColumns, actor, mailboxId, filter),
                    eq(newer.threadKey, items.threadKey),
                    sql`(${listOrder(newer as unknown as ItemColumns, filter?.kind)}, ${newer.id}) > (${order}, ${items.id})`,
                  ),
                ),
            ),
          ),
        ]
      : [];
    return tx
      .select({
        id: items.id,
        mailboxId: items.mailboxId,
        kind: items.kind,
        deliveryFolder: items.deliveryFolder,
        inboundAssessment: items.inboundAssessment,
        trashedAt: items.trashedAt,
        starredAt: items.starredAt,
        seenAt: items.seenAt,
        archivedAt: items.archivedAt,
        folderId: items.folderId,
        snoozedUntil: items.snoozedUntil,
        pinnedAt: items.pinnedAt,
        sendAt: items.sendAt,
        sendFailure: items.sendFailure,
        remindAt: items.remindAt,
        remindedAt: items.remindedAt,
        threadKey: items.threadKey,
        revision: items.revision,
        createdAt: items.createdAt,
        updatedAt: items.updatedAt,
        orderAt: sql<string>`(extract(epoch from ${order}) * 1000000)::bigint::text`,
      })
      .from(items)
      .where(
        and(
          ...listConditions(items, actor, mailboxId, filter),
          ...(before
            ? [sql`(${order}, ${items.id}) < (${positionTime(before.at)}, ${before.id}::uuid)`]
            : []),
          ...latest,
        ),
      )
      .orderBy(desc(order), desc(items.id))
      .limit(limit);
  });
}

/**
 * Unread messages in a mailbox's Inbox view: received, not opened by the
 * owner, and not archived, filed in a folder, trashed, spam or quarantined.
 */
export async function countUnreadMailboxItems(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
): Promise<number> {
  actor = { ...actor };
  return scoped(db, actor, mailboxId, "read", false, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.mailboxId, mailboxId),
          eq(schema.mailboxItems.teamId, actor.teamId),
          eq(schema.mailboxItems.kind, "inbox"),
          eq(schema.mailboxItems.deliveryFolder, "inbox"),
          isNull(schema.mailboxItems.seenAt),
          isNull(schema.mailboxItems.trashedAt),
          isNull(schema.mailboxItems.archivedAt),
          isNull(schema.mailboxItems.folderId),
          sql`not ${snoozedNow(schema.mailboxItems)}`,
        ),
      );
    return row?.count ?? 0;
  });
}

export interface MailboxViewCount {
  unread: number;
  total: number;
}
/**
 * Totals for the folder rail: the Inbox and Spam views and each named folder, with
 * how many received messages the owner has not opened. Same rules as the views:
 * nothing trashed; Inbox leaves out archived and filed messages; folders hold only
 * safe messages of any kind. Agents have no rail.
 */
export async function countMailboxViews(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
): Promise<{
  inbox: MailboxViewCount;
  spam: MailboxViewCount;
  folders: Map<string, MailboxViewCount>;
}> {
  actor = { ...actor };
  if (actor.agentAccess) throw new MailboxContentError("forbidden");
  return scoped(db, actor, mailboxId, "read", false, async (tx) => {
    const items = schema.mailboxItems;
    const rows = await tx
      .select({
        folderId: items.folderId,
        deliveryFolder: items.deliveryFolder,
        kind: items.kind,
        archived: sql<boolean>`${items.archivedAt} is not null`,
        total: sql<number>`count(*)::int`,
        unread: sql<number>`(count(*) filter (where ${items.seenAt} is null))::int`,
      })
      .from(items)
      .where(
        and(
          eq(items.mailboxId, mailboxId),
          eq(items.teamId, actor.teamId),
          isNull(items.trashedAt),
          // Snoozed messages leave every view until they come back.
          sql`not ${snoozedNow(items)}`,
        ),
      )
      .groupBy(
        items.folderId,
        items.deliveryFolder,
        items.kind,
        sql`${items.archivedAt} is not null`,
      );
    const inbox = { unread: 0, total: 0 };
    const spam = { unread: 0, total: 0 };
    const folders = new Map<string, MailboxViewCount>();
    for (const row of rows) {
      const total = Number(row.total);
      const unread = row.kind === "inbox" ? Number(row.unread) : 0;
      if (row.folderId) {
        if (row.deliveryFolder !== "inbox") continue;
        const folder = folders.get(row.folderId) ?? { unread: 0, total: 0 };
        folder.total += total;
        folder.unread += unread;
        folders.set(row.folderId, folder);
      } else if (row.kind === "inbox" && row.deliveryFolder === "inbox" && !row.archived) {
        inbox.total += total;
        inbox.unread += unread;
      } else if (row.kind === "inbox" && row.deliveryFolder === "spam") {
        spam.total += total;
        spam.unread += unread;
      }
    }
    return { inbox, spam, folders };
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
  const raw = bytes(input.raw, MAX_DRAFT_MIME_BYTES);
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
      ...mailboxThreadKeys(raw),
      ...sealed,
      // New content: the old list summary no longer describes it.
      ...NO_LIST_SUMMARY,
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
