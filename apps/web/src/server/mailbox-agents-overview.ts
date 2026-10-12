import {
  listMailboxActivity,
  listMailboxAgentKeys,
  listMailboxRegistry,
  listMailboxTeamAgentKeys,
  type MailboxActivityItem,
  type MailboxContentActor,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getMailboxContent } from "./mailbox-content";

/**
 * The Correio's agents panel (Jean, 2026-10-11): for the mailboxes this person owns,
 * what waits for their approval, which agents can reach them and what the agents did
 * lately. Every read goes through the same owner checks as the mailbox's own dialogs
 * (agent keys, activity, message content); nothing here grants anything.
 */

/** Mailboxes looked at, per person (the panel is for an owner's own mailboxes). */
const MAX_BOXES = 20;
const MAX_APPROVALS = 20;
const ACTIVITY_PER_BOX = 25;
const MAX_ACTIVITY = 40;

export interface MailboxAgentCredential {
  /** What revocation takes: the key id (mailbox) or the credential id (team, OAuth). */
  credentialId: string;
  kind: "mailbox" | "team" | "oauth";
  label: string;
  scopes: string[];
  mailboxes: { mailboxId: string; address: string }[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastSentAt: Date | null;
}

export interface MailboxAgentApproval {
  mailboxId: string;
  address: string;
  itemId: string;
  revision: number;
  agentLabel: string | null;
  requestedAt: Date;
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  preview: string;
}

export interface MailboxAgentActivity
  extends Pick<MailboxActivityItem, "id" | "action" | "createdAt" | "itemId" | "count" | "folder"> {
  mailboxId: string;
  address: string;
  agentLabel: string | null;
}

const active = (row: { revokedAt: Date | null; expiresAt: Date | null }, now: Date) =>
  !row.revokedAt && (!row.expiresAt || row.expiresAt > now);

export async function getMailboxAgentsOverview(
  db: Db,
  actor: MailboxContentActor,
  now = new Date(),
) {
  const registry = await listMailboxRegistry(db, actor);
  const owned = registry.mailboxes
    .filter(
      (box) =>
        box.ownerUserId === actor.userId &&
        box.ownerActive &&
        box.status === "planned" &&
        box.canRead,
    )
    .slice(0, MAX_BOXES);
  const address = new Map(owned.map((box) => [box.id, box.address]));
  if (!owned.length) return { mailboxes: [], credentials: [], approvals: [], activity: [] };

  // Credentials: each mailbox's own keys, plus team credentials and OAuth apps whole.
  const credentials: MailboxAgentCredential[] = [];
  for (const box of owned) {
    const keys = await listMailboxAgentKeys(db, actor, box.id);
    for (const key of keys)
      if (key.kind === "mailbox" && active(key, now))
        credentials.push({
          credentialId: key.id,
          kind: "mailbox",
          label: key.label,
          scopes: [...key.scopes],
          mailboxes: [{ mailboxId: box.id, address: box.address }],
          createdAt: key.createdAt,
          expiresAt: key.expiresAt,
          lastUsedAt: key.lastUsedAt,
          lastSentAt: key.lastSentAt,
        });
  }
  for (const group of await listMailboxTeamAgentKeys(db, actor))
    if (active(group, now))
      credentials.push({
        credentialId: group.id,
        kind: group.oauthClientId ? "oauth" : "team",
        label: group.label,
        scopes: [...group.scopes],
        mailboxes: group.mailboxes
          .filter((m) => !m.revoked)
          .map((m) => ({ mailboxId: m.mailboxId, address: m.address })),
        createdAt: group.createdAt,
        expiresAt: group.expiresAt,
        lastUsedAt: group.lastUsedAt,
        lastSentAt: group.lastSentAt,
      });
  credentials.sort(
    (a, b) =>
      (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0) ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  );

  // Approvals: the agent asked to send this exact revision, and it is still that draft,
  // not trashed and not sent since (any send of the revision is in the outbox).
  const t = schema.auditLog;
  const items = schema.mailboxItems;
  const requests = await db
    .select({
      mailboxId: items.mailboxId,
      itemId: items.id,
      revision: items.revision,
      requestedAt: t.createdAt,
      agentLabel: schema.mailboxAgentKeys.label,
    })
    .from(t)
    .innerJoin(
      items,
      and(
        sql`${items.id}::text = ${t.data}->>'itemId'`,
        sql`${items.revision}::text = ${t.data}->>'revision'`,
        eq(items.teamId, t.teamId),
        eq(items.kind, "draft"),
        isNull(items.trashedAt),
      ),
    )
    .leftJoin(
      schema.mailboxAgentKeys,
      sql`${schema.mailboxAgentKeys.id}::text = ${t.data}->>'keyId'`,
    )
    .where(
      and(
        eq(t.teamId, actor.teamId),
        eq(t.action, "mailbox.send_requested"),
        inArray(
          items.mailboxId,
          owned.map((box) => box.id),
        ),
        sql`not exists (select 1 from ${schema.mailboxOutbox} where ${schema.mailboxOutbox.draftId} = ${items.id} and ${schema.mailboxOutbox.draftRevision} = ${items.revision})`,
      ),
    )
    .orderBy(desc(t.createdAt))
    .limit(MAX_APPROVALS);
  const approvals: MailboxAgentApproval[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.itemId)) continue;
    seen.add(request.itemId);
    // The draft as the owner would open it (same access check as the reader).
    const content = await getMailboxContent(db, actor, {
      mailboxId: request.mailboxId,
      id: request.itemId,
    }).catch(() => null);
    if (!content) continue;
    approvals.push({
      mailboxId: request.mailboxId,
      address: address.get(request.mailboxId) ?? "",
      itemId: request.itemId,
      revision: request.revision,
      agentLabel: request.agentLabel ?? null,
      requestedAt: request.requestedAt,
      subject: content.subject ?? "",
      to: content.to ?? [],
      cc: content.cc ?? [],
      bcc: content.bcc ?? [],
      preview: (content.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    });
  }

  // Activity: what agents did lately, across the owner's mailboxes, newest first.
  const activity: MailboxAgentActivity[] = [];
  for (const box of owned) {
    const page = await listMailboxActivity(db, actor, {
      mailboxId: box.id,
      limit: ACTIVITY_PER_BOX,
    });
    for (const item of page.items)
      if (item.actor.kind === "agent")
        activity.push({
          id: item.id,
          action: item.action,
          createdAt: item.createdAt,
          ...(item.itemId ? { itemId: item.itemId } : {}),
          ...(item.count !== undefined ? { count: item.count } : {}),
          ...(item.folder ? { folder: item.folder } : {}),
          mailboxId: box.id,
          address: box.address,
          agentLabel: item.actor.label,
        });
  }
  activity.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return {
    mailboxes: owned.map((box) => ({
      id: box.id,
      address: box.address,
      label: box.label,
      kind: box.kind,
    })),
    credentials,
    approvals,
    activity: activity.slice(0, MAX_ACTIVITY),
  };
}

/**
 * How many agent requests wait for this person (the rail's "Aguardando aprovação"): the
 * same rule as the panel's list, counted only, so it can be asked every minute.
 */
export async function countMailboxAgentApprovals(db: Db, actor: MailboxContentActor) {
  const registry = await listMailboxRegistry(db, actor);
  const owned = registry.mailboxes
    .filter(
      (box) =>
        box.ownerUserId === actor.userId &&
        box.ownerActive &&
        box.status === "planned" &&
        box.canRead,
    )
    .map((box) => box.id);
  if (!owned.length) return 0;
  const t = schema.auditLog;
  const items = schema.mailboxItems;
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${items.id})::int` })
    .from(t)
    .innerJoin(
      items,
      and(
        sql`${items.id}::text = ${t.data}->>'itemId'`,
        sql`${items.revision}::text = ${t.data}->>'revision'`,
        eq(items.teamId, t.teamId),
        eq(items.kind, "draft"),
        isNull(items.trashedAt),
      ),
    )
    .where(
      and(
        eq(t.teamId, actor.teamId),
        eq(t.action, "mailbox.send_requested"),
        inArray(items.mailboxId, owned),
        sql`not exists (select 1 from ${schema.mailboxOutbox} where ${schema.mailboxOutbox.draftId} = ${items.id} and ${schema.mailboxOutbox.draftRevision} = ${items.revision})`,
      ),
    );
  return row?.count ?? 0;
}
