import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { MAILBOX_ACTIVITY_ACTIONS, type MailboxActivityAction } from "./audit-actions.js";
import {
  type MailboxContentActor,
  MailboxContentError,
  withMailboxContentAccess,
} from "./mailbox-private-store.js";

export { MAILBOX_ACTIVITY_ACTIONS, type MailboxActivityAction };

const userId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const actorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mailbox_agent"), keyId: z.uuid() }).strict(),
  z.object({ kind: z.literal("user"), userId }).strict(),
]);
const contextSchema = z
  .object({ teamId: z.uuid(), mailboxId: z.uuid(), actor: actorSchema })
  .strict();
const revision = z.number().int().min(1).max(2147483647);
const eventSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("mailbox.items_listed"),
      folder: z.enum(["inbox", "drafts", "sent"]),
      count: z.number().int().min(0).max(50),
    })
    .strict(),
  z.object({ action: z.literal("mailbox.item_read"), itemId: z.uuid(), revision }).strict(),
  z.object({ action: z.literal("mailbox.draft_saved"), itemId: z.uuid(), revision }).strict(),
  z.object({ action: z.literal("mailbox.item_trashed"), itemId: z.uuid(), revision }).strict(),
  z.object({ action: z.literal("mailbox.item_restored"), itemId: z.uuid(), revision }).strict(),
  z.object({ action: z.literal("mailbox.item_starred"), itemId: z.uuid(), revision }).strict(),
  z.object({ action: z.literal("mailbox.item_unstarred"), itemId: z.uuid(), revision }).strict(),
  z.object({ action: z.literal("mailbox.item_archived"), itemId: z.uuid(), revision }).strict(),
  z.object({ action: z.literal("mailbox.item_unarchived"), itemId: z.uuid(), revision }).strict(),
  z
    .object({
      action: z.literal("mailbox.item_folder_changed"),
      itemId: z.uuid(),
      revision,
      folderId: z.uuid().nullable(),
    })
    .strict(),
  z.object({ action: z.literal("mailbox.folder_created"), folderId: z.uuid(), revision }).strict(),
  z.object({ action: z.literal("mailbox.folder_renamed"), folderId: z.uuid(), revision }).strict(),
  z.object({ action: z.literal("mailbox.folder_archived"), folderId: z.uuid(), revision }).strict(),
  // A key without the send permission asked the mailbox owner to send this revision.
  z.object({ action: z.literal("mailbox.send_requested"), itemId: z.uuid(), revision }).strict(),
  z
    .object({
      action: z.literal("mailbox.send_approved"),
      itemId: z.uuid(),
      revision,
      outboxId: z.uuid(),
    })
    .strict(),
]);

export type MailboxActivityContext = z.infer<typeof contextSchema>;
export type MailboxActivityEvent = z.infer<typeof eventSchema>;
export interface MailboxActivityCursor {
  createdAt: string;
  id: string;
}
export interface MailboxActivityItem {
  id: string;
  action: MailboxActivityAction;
  createdAt: Date;
  actor: { kind: "agent" | "person"; label: string | null };
  itemId?: string;
  revision?: number;
  folderId?: string | null;
  folder?: "inbox" | "drafts" | "sent";
  count?: number;
}

/** Call with the current authorized operation's transaction, never a global connection.
 * The caller keeps its mailbox/key/member locks through operation, append, and DTO creation.
 * There is no independent commit, best-effort catch, content, or request metadata here.
 */
export async function appendMailboxActivity(
  transaction: Db,
  context: MailboxActivityContext,
  event: MailboxActivityEvent,
): Promise<void> {
  const ctx = contextSchema.safeParse(context);
  const facts = eventSchema.safeParse(event);
  if (!ctx.success || !facts.success) throw new MailboxContentError("invalid");
  const { action, ...metadata } = facts.data;
  const actor = ctx.data.actor;
  await transaction.insert(schema.auditLog).values({
    teamId: ctx.data.teamId,
    target: `mailbox:${ctx.data.mailboxId}`,
    actorId:
      actor.kind === "mailbox_agent" ? `mailbox_agent:${actor.keyId}` : `user:${actor.userId}`,
    action,
    data: {
      mailboxId: ctx.data.mailboxId,
      ...(actor.kind === "mailbox_agent" ? { keyId: actor.keyId } : {}),
      ...metadata,
    },
  });
}

const readSchema = z
  .object({
    mailboxId: z.uuid(),
    limit: z.number().int().min(1).max(50).default(25),
    cursor: z
      .object({ createdAt: z.iso.datetime({ precision: 6 }), id: z.uuid() })
      .strict()
      .optional(),
  })
  .strict();

function decodeRow(
  row: Pick<typeof schema.auditLog.$inferSelect, "data" | "action" | "actorId">,
  mailboxId: string,
) {
  const metadata = row.data;
  if (!metadata || metadata.mailboxId !== mailboxId) return null;
  const { mailboxId: _mailboxId, keyId, ...fields } = metadata;
  const parsed = eventSchema.safeParse({ ...fields, action: row.action });
  if (!parsed.success) return null;
  if (row.actorId?.startsWith("mailbox_agent:")) {
    const id = row.actorId.slice("mailbox_agent:".length);
    if (!z.uuid().safeParse(id).success || id !== keyId) return null;
    return { event: parsed.data, actor: { kind: "agent" as const, id } };
  }
  if (row.actorId?.startsWith("user:") && keyId === undefined) {
    const id = row.actorId.slice("user:".length);
    if (!userId.safeParse(id).success) return null;
    return { event: parsed.data, actor: { kind: "person" as const, id } };
  }
  return null;
}

/** Human owner only, under live private-content ACL + current membership/ownership locks.
 * Revoked agent keys remain historical actors; only their current label is resolved.
 * Returned DTOs never include raw metadata, key/owner/outbox IDs, or recipient facts.
 */
export async function listMailboxActivity(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; limit?: number; cursor?: MailboxActivityCursor },
): Promise<{ items: MailboxActivityItem[]; nextCursor: MailboxActivityCursor | null }> {
  actor = { ...actor };
  if (actor.supportView || actor.agentAccess) throw new MailboxContentError("forbidden");
  const parsed = readSchema.safeParse(input);
  if (
    !parsed.success ||
    !z.uuid().safeParse(actor.teamId).success ||
    !userId.safeParse(actor.userId).success
  )
    throw new MailboxContentError("invalid");
  const { mailboxId, cursor, limit } = parsed.data;
  return db.transaction(async (transaction) => {
    const transactionDb = transaction as unknown as Db;
    return withMailboxContentAccess(transactionDb, actor, [mailboxId], async (tx) => {
      // Content delegates/admins do not gain the owner's activity history.
      const [owned] = await tx
        .select({ id: schema.mailboxes.id })
        .from(schema.mailboxes)
        .innerJoin(
          schema.teamMembers,
          and(
            eq(schema.teamMembers.id, schema.mailboxes.ownerMembershipId),
            eq(schema.teamMembers.teamId, schema.mailboxes.teamId),
          ),
        )
        .where(
          and(
            eq(schema.mailboxes.id, mailboxId),
            eq(schema.mailboxes.teamId, actor.teamId),
            eq(schema.mailboxes.ownerUserId, actor.userId),
            eq(schema.teamMembers.userId, actor.userId),
          ),
        );
      if (!owned) throw new MailboxContentError("forbidden");
      const t = schema.auditLog;
      const rows = await tx
        .select({
          id: t.id,
          action: t.action,
          actorId: t.actorId,
          data: t.data,
          createdAt: t.createdAt,
          cursorCreatedAt: sql<string>`to_char(${t.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(t)
        .where(
          and(
            eq(t.teamId, actor.teamId),
            eq(t.target, `mailbox:${mailboxId}`),
            inArray(t.action, [...MAILBOX_ACTIVITY_ACTIONS]),
            cursor
              ? or(
                  sql`${t.createdAt} < ${cursor.createdAt}::timestamptz`,
                  and(sql`${t.createdAt} = ${cursor.createdAt}::timestamptz`, lt(t.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const decoded = page.map((row) => ({ row, decoded: decodeRow(row, mailboxId) }));
      const agentIds = decoded.flatMap(({ decoded: entry }) =>
        entry?.actor.kind === "agent" ? [entry.actor.id] : [],
      );
      const personIds = decoded.flatMap(({ decoded: entry }) =>
        entry?.actor.kind === "person" ? [entry.actor.id] : [],
      );
      const keys = agentIds.length
        ? await tx
            .select({ id: schema.mailboxAgentKeys.id, label: schema.mailboxAgentKeys.label })
            .from(schema.mailboxAgentKeys)
            .where(
              and(
                eq(schema.mailboxAgentKeys.teamId, actor.teamId),
                eq(schema.mailboxAgentKeys.mailboxId, mailboxId),
                inArray(schema.mailboxAgentKeys.id, agentIds),
              ),
            )
        : [];
      const people = personIds.length
        ? await tx
            .select({ id: schema.user.id, label: schema.user.name })
            .from(schema.teamMembers)
            .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
            .where(
              and(
                eq(schema.teamMembers.teamId, actor.teamId),
                inArray(schema.teamMembers.userId, personIds),
              ),
            )
        : [];
      const keyLabels = new Map(keys.map((key) => [key.id, key.label]));
      const personLabels = new Map(people.map((person) => [person.id, person.label]));
      const items: MailboxActivityItem[] = decoded.flatMap(({ row, decoded: entry }) => {
        if (!entry) return [];
        const event = entry.event;
        return [
          {
            id: row.id,
            action: event.action,
            createdAt: row.createdAt,
            actor: {
              kind: entry.actor.kind,
              label:
                (entry.actor.kind === "agent" ? keyLabels : personLabels).get(entry.actor.id) ??
                null,
            },
            ...(event.action === "mailbox.items_listed"
              ? { folder: event.folder, count: event.count }
              : "itemId" in event
                ? {
                    itemId: event.itemId,
                    revision: event.revision,
                    ...("folderId" in event ? { folderId: event.folderId } : {}),
                  }
                : { folderId: event.folderId, revision: event.revision }),
          },
        ];
      });
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > limit && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null,
      };
    });
  });
}
