import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  type MailboxContentActor,
  MailboxContentError,
  withMailboxContentAccess,
  withMailboxOrganizationAccess,
  withMailboxWriteAccess,
} from "./mailbox-private-store.js";
import { MailboxServiceError } from "./mailbox-service.js";

/**
 * Snooze, pin, send later and follow-up reminders: the owner's own timing on
 * retained messages. Each change is organization metadata with the same
 * revision guard as starring or filing; nothing here reads or changes content.
 * A scheduled send is admitted later by the worker through queueMailboxDraft,
 * which checks ownership, license, plan and seat again at that moment.
 */

/** A time has to be at least a minute ahead and at most a year ahead. */
export const MAILBOX_SCHEDULE_MIN_MS = 60_000;
export const MAILBOX_SCHEDULE_MAX_MS = 366 * 24 * 60 * 60_000;
/** A claimed send that never finished is tried again after this long. */
export const MAILBOX_SEND_CLAIM_STALE_MS = 10 * 60_000;

const revision = z.number().int().min(1).max(2147483646);
const mutation = z.object({ mailboxId: z.uuid(), id: z.uuid(), expectedRevision: revision });
type Item = typeof schema.mailboxItems.$inferSelect;
/** Why a scheduled send did not go out when it came due (the draft stays a draft). */
export type MailboxScheduledSendFailure = NonNullable<Item["sendFailure"]>;
const items = schema.mailboxItems;

function parse<T>(validator: z.ZodType<T>, value: unknown): T {
  const result = validator.safeParse(value);
  if (!result.success) throw new MailboxContentError("invalid");
  return result.data;
}
function validNow(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new MailboxContentError("invalid");
}
/** null clears; any other time must fall inside the scheduling window. */
function scheduledTime(value: Date | null, now: Date): Date | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new MailboxContentError("invalid");
  const ahead = value.getTime() - now.getTime();
  if (ahead < MAILBOX_SCHEDULE_MIN_MS || ahead > MAILBOX_SCHEDULE_MAX_MS)
    throw new MailboxContentError("invalid");
  return value;
}

export function mailboxScheduleDto(item: Item, changed: boolean) {
  return {
    id: item.id,
    mailboxId: item.mailboxId,
    revision: item.revision,
    seenAt: item.seenAt,
    archivedAt: item.archivedAt,
    folderId: item.folderId,
    snoozedUntil: item.snoozedUntil,
    pinnedAt: item.pinnedAt,
    sendAt: item.sendAt,
    sendFailure: item.sendFailure,
    remindAt: item.remindAt,
    remindedAt: item.remindedAt,
    changed,
  };
}

/** The item, locked, at the revision the person saw; trashed items take no timing. */
async function lockedItem(
  tx: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number },
) {
  const [item] = await tx
    .select()
    .from(items)
    .where(
      and(
        eq(items.id, input.id),
        eq(items.teamId, actor.teamId),
        eq(items.mailboxId, input.mailboxId),
      ),
    )
    .for("update");
  if (!item) throw new MailboxContentError("not_found");
  if (item.revision !== input.expectedRevision) throw new MailboxContentError("conflict");
  if (item.trashedAt !== null) throw new MailboxContentError("forbidden");
  return item;
}
/** Received, safe mail: what snooze and pin apply to. */
function assertReceived(item: Item) {
  if (
    item.kind !== "inbox" ||
    item.deliveryFolder !== "inbox" ||
    item.inboundAssessment?.decision === "quarantine"
  )
    throw new MailboxContentError("forbidden");
}
async function update(
  tx: Db,
  actor: MailboxContentActor,
  item: Item,
  values: Partial<typeof items.$inferInsert>,
  now: Date,
) {
  const [updated] = await tx
    .update(items)
    .set({ ...values, revision: item.revision + 1, updatedAt: now })
    .where(
      and(
        eq(items.id, item.id),
        eq(items.teamId, actor.teamId),
        eq(items.mailboxId, item.mailboxId),
        eq(items.revision, item.revision),
      ),
    )
    .returning();
  if (!updated) throw new MailboxContentError("conflict");
  return mailboxScheduleDto(updated, true);
}

/**
 * Snoozes a received message until `until` (null wakes it now): it leaves every
 * view but Snoozed, then comes back to the inbox, unread and on top.
 */
export async function snoozeMailboxItem(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; until: Date | null },
  now = new Date(),
) {
  actor = { ...actor };
  const parsed = parse(mutation.extend({ until: z.date().nullable() }).strict(), input);
  validNow(now);
  const until = scheduledTime(parsed.until, now);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    const item = await lockedItem(tx, actor, parsed);
    assertReceived(item);
    if (until === null) {
      if (item.snoozedUntil === null) return mailboxScheduleDto(item, false);
      // Woken by hand: back where it was, unchanged.
      return update(tx, actor, item, { snoozedUntil: null }, now);
    }
    return update(tx, actor, item, { snoozedUntil: until }, now);
  });
}

/** Pins a received message to the top of the inbox, or unpins it. */
export async function pinMailboxItem(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; pinned: boolean },
  now = new Date(),
) {
  actor = { ...actor };
  const parsed = parse(mutation.extend({ pinned: z.boolean() }).strict(), input);
  validNow(now);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    const item = await lockedItem(tx, actor, parsed);
    assertReceived(item);
    if ((item.pinnedAt !== null) === parsed.pinned) return mailboxScheduleDto(item, false);
    return update(tx, actor, item, { pinnedAt: parsed.pinned ? now : null }, now);
  });
}

/**
 * Schedules a draft to be sent at `sendAt`, or cancels the schedule (null).
 * Scheduling needs what sending needs now (owner, license, plan, seat); the
 * worker checks all of it again when the time comes. Cancelling only needs
 * the owner, so a lapsed plan never traps a scheduled draft.
 */
export async function scheduleMailboxSend(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; sendAt: Date | null },
  now = new Date(),
) {
  actor = { ...actor };
  const parsed = parse(mutation.extend({ sendAt: z.date().nullable() }).strict(), input);
  validNow(now);
  const sendAt = scheduledTime(parsed.sendAt, now);
  const access = sendAt === null ? withMailboxOrganizationAccess : withMailboxWriteAccess;
  if (actor.agentAccess) throw new MailboxContentError("forbidden");
  return access(db, actor, parsed.mailboxId, async (tx) => {
    const item = await lockedItem(tx, actor, parsed);
    if (item.kind !== "draft") throw new MailboxContentError("forbidden");
    if (sendAt === null) {
      if (item.sendAt === null && item.sendFailure === null) return mailboxScheduleDto(item, false);
      return update(
        tx,
        actor,
        item,
        { sendAt: null, sendClaimedAt: null, sendFailure: null, sendScheduledBy: null },
        now,
      );
    }
    // A draft already handed to the outbox is sending; it cannot be rescheduled.
    const [pending] = await tx
      .select({ id: schema.mailboxOutbox.id })
      .from(schema.mailboxOutbox)
      .where(
        and(
          eq(schema.mailboxOutbox.teamId, actor.teamId),
          eq(schema.mailboxOutbox.mailboxId, parsed.mailboxId),
          eq(schema.mailboxOutbox.draftId, item.id),
          ne(schema.mailboxOutbox.status, "failed"),
        ),
      )
      .limit(1);
    if (pending) throw new MailboxContentError("conflict");
    return update(
      tx,
      actor,
      item,
      { sendAt, sendScheduledBy: actor.userId, sendClaimedAt: null, sendFailure: null },
      now,
    );
  });
}

/**
 * Follow-up on a sent message: at `remindAt` the worker looks for a reply in its
 * conversation; with none, the message waits in Follow-ups. null clears it (also
 * "done" on a reminder that came due).
 */
export async function setMailboxFollowUp(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string; expectedRevision: number; remindAt: Date | null },
  now = new Date(),
) {
  actor = { ...actor };
  const parsed = parse(mutation.extend({ remindAt: z.date().nullable() }).strict(), input);
  validNow(now);
  const remindAt = scheduledTime(parsed.remindAt, now);
  return withMailboxOrganizationAccess(db, actor, parsed.mailboxId, async (tx) => {
    const item = await lockedItem(tx, actor, parsed);
    if (item.kind !== "sent") throw new MailboxContentError("forbidden");
    if (remindAt === null && item.remindAt === null && item.remindedAt === null)
      return mailboxScheduleDto(item, false);
    return update(tx, actor, item, { remindAt, remindedAt: null }, now);
  });
}

/** A received message in the same conversation, after the sent one. */
function replied(sent: typeof items) {
  const reply = alias(schema.mailboxItems, "schedule_reply");
  return sql`exists (select 1 from ${schema.mailboxItems} ${reply} where ${reply.mailboxId} = ${sent.mailboxId} and ${reply.teamId} = ${sent.teamId} and ${reply.kind} = 'inbox' and ${reply.trashedAt} is null and ${sent.threadKey} is not null and ${reply.threadKey} = ${sent.threadKey} and ${reply.createdAt} > ${sent.createdAt})`;
}

export interface MailboxScheduleCounts {
  snoozed: number;
  scheduled: number;
  followUps: number;
}
/** How many messages wait in Snoozed, Scheduled and Follow-ups, for the rail. */
export async function countMailboxSchedules(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
): Promise<MailboxScheduleCounts> {
  actor = { ...actor };
  if (actor.agentAccess) throw new MailboxContentError("forbidden");
  return withMailboxContentAccess(db, actor, [mailboxId], async (tx) => {
    const [row] = await tx
      .select({
        snoozed: sql<number>`(count(*) filter (where ${items.snoozedUntil} > now()))::int`,
        scheduled: sql<number>`(count(*) filter (where ${items.sendAt} is not null))::int`,
        followUps: sql<number>`(count(*) filter (where ${items.remindedAt} is not null and not ${replied(items)}))::int`,
      })
      .from(items)
      .where(
        and(
          eq(items.mailboxId, mailboxId),
          eq(items.teamId, actor.teamId),
          isNull(items.trashedAt),
          or(isNotNull(items.snoozedUntil), isNotNull(items.sendAt), isNotNull(items.remindedAt)),
        ),
      );
    return {
      snoozed: Number(row?.snoozed ?? 0),
      scheduled: Number(row?.scheduled ?? 0),
      followUps: Number(row?.followUps ?? 0),
    };
  });
}

/* ---------------------------------------------------------------- worker side */

/**
 * Snoozed messages whose time came: back to the inbox (out of the archive or a
 * folder), unread, ordered by when they came back. A snoozed message that was
 * trashed or reclassified meanwhile just loses its snooze.
 */
export async function wakeSnoozedMailboxItems(db: Db, now = new Date(), limit = 500) {
  validNow(now);
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const due = await tx
      .select({ id: items.id, trashedAt: items.trashedAt, deliveryFolder: items.deliveryFolder })
      .from(items)
      .where(and(isNotNull(items.snoozedUntil), lte(items.snoozedUntil, now)))
      .orderBy(asc(items.snoozedUntil))
      .limit(limit)
      .for("update", { skipLocked: true });
    let woken = 0;
    for (const row of due) {
      const back = row.trashedAt === null && row.deliveryFolder === "inbox";
      const [updated] = await tx
        .update(items)
        .set(
          back
            ? {
                snoozedUntil: null,
                resurfacedAt: sql`${items.snoozedUntil}`,
                archivedAt: null,
                folderId: null,
                seenAt: null,
                revision: sql`${items.revision} + 1`,
                updatedAt: now,
              }
            : { snoozedUntil: null, revision: sql`${items.revision} + 1`, updatedAt: now },
        )
        .where(and(eq(items.id, row.id), isNotNull(items.snoozedUntil)))
        .returning({ id: items.id });
      if (updated && back) woken += 1;
    }
    return woken;
  });
}

/**
 * Follow-ups that came due: with a reply in the conversation the reminder is
 * simply done; without one it waits in Follow-ups.
 */
export async function markDueMailboxFollowUps(db: Db, now = new Date(), limit = 500) {
  validNow(now);
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const due = await tx
      .select({ id: items.id, replied: sql<boolean>`${replied(items)}` })
      .from(items)
      .where(
        and(
          eq(items.kind, "sent"),
          isNotNull(items.remindAt),
          lte(items.remindAt, now),
          isNull(items.remindedAt),
        ),
      )
      .orderBy(asc(items.remindAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    let reminded = 0;
    for (const row of due) {
      await tx
        .update(items)
        .set(
          row.replied
            ? { remindAt: null, revision: sql`${items.revision} + 1`, updatedAt: now }
            : { remindedAt: now, revision: sql`${items.revision} + 1`, updatedAt: now },
        )
        .where(eq(items.id, row.id));
      if (!row.replied) reminded += 1;
    }
    return reminded;
  });
}

export interface MailboxDueSend {
  id: string;
  mailboxId: string;
  teamId: string;
  revision: number;
  scheduledBy: string | null;
  claimedAt: Date;
}
/**
 * Claims drafts whose send time came, so one worker admits each at most once
 * at a time. A claim that never finished is tried again after a while. Trashed
 * drafts lose their schedule.
 */
export async function claimDueMailboxSends(
  db: Db,
  now = new Date(),
  limit = 20,
): Promise<MailboxDueSend[]> {
  validNow(now);
  const stale = new Date(now.getTime() - MAILBOX_SEND_CLAIM_STALE_MS);
  await db
    .update(items)
    .set({ sendAt: null, sendClaimedAt: null, sendScheduledBy: null })
    .where(and(isNotNull(items.sendAt), isNotNull(items.trashedAt)));
  const due = await db
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        eq(items.kind, "draft"),
        isNotNull(items.sendAt),
        lte(items.sendAt, now),
        isNull(items.trashedAt),
        or(isNull(items.sendClaimedAt), lt(items.sendClaimedAt, stale)),
      ),
    )
    .orderBy(asc(items.sendAt))
    .limit(limit);
  const claimed: MailboxDueSend[] = [];
  for (const row of due) {
    const [won] = await db
      .update(items)
      .set({ sendClaimedAt: now })
      .where(
        and(
          eq(items.id, row.id),
          isNotNull(items.sendAt),
          lte(items.sendAt, now),
          or(isNull(items.sendClaimedAt), lt(items.sendClaimedAt, stale)),
        ),
      )
      .returning({
        id: items.id,
        mailboxId: items.mailboxId,
        teamId: items.teamId,
        revision: items.revision,
        scheduledBy: items.sendScheduledBy,
      });
    if (won) claimed.push({ ...won, claimedAt: now });
  }
  return claimed;
}

/** The admitted draft leaves the schedule; its revision stays the one the outbox froze. */
export async function completeMailboxSend(db: Db, due: MailboxDueSend) {
  await db
    .update(items)
    .set({ sendAt: null, sendClaimedAt: null, sendFailure: null, sendScheduledBy: null })
    .where(and(eq(items.id, due.id), eq(items.sendClaimedAt, due.claimedAt)));
}

/** A send that cannot go out: the draft stays a draft, with the reason to show. */
export async function failMailboxSend(
  db: Db,
  due: MailboxDueSend,
  failure: MailboxScheduledSendFailure,
) {
  await db
    .update(items)
    .set({ sendAt: null, sendClaimedAt: null, sendFailure: failure, sendScheduledBy: null })
    .where(and(eq(items.id, due.id), eq(items.sendClaimedAt, due.claimedAt)));
}

/**
 * What a failed admission means for the schedule: a reason to show (the send
 * stops), or null for a passing problem (the claim lapses and it is tried again).
 */
export function mailboxScheduledSendFailure(error: unknown): MailboxScheduledSendFailure | null {
  if (error instanceof MailboxContentError) return error.code;
  if (error instanceof MailboxServiceError)
    return error.code === "invalid" ? "invalid" : "not_entitled";
  return null;
}
