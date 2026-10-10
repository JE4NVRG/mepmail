import {
  listMailboxRegistry,
  MailboxContentError,
  mailboxServiceEntitlement,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

/** Uses the same physical bytes and recipient reservations as admission checks; no message opens. */
export async function getMailboxUsage(
  db: Db,
  actor: { teamId: string; userId: string },
  input: { mailboxId: string | null },
) {
  const registry = await listMailboxRegistry(db, actor);
  const readable = registry.mailboxes.filter(
    (box) =>
      box.canRead && box.status === "planned" && (!input.mailboxId || box.id === input.mailboxId),
  );
  if (input.mailboxId && !readable.length) throw new MailboxContentError("not_found");
  if (!readable.length) return { mailboxes: [] };
  const entitlement = await mailboxServiceEntitlement(db, actor.teamId);
  const plan = entitlement.plan;
  const ids = readable.map((box) => box.id);
  const stored = await db
    .select({
      mailboxId: schema.mailboxItems.mailboxId,
      bytes: sql<string>`coalesce(sum(${schema.mailboxItems.rawBytes}),0)::text`,
    })
    .from(schema.mailboxItems)
    .where(
      and(
        eq(schema.mailboxItems.teamId, actor.teamId),
        inArray(schema.mailboxItems.mailboxId, ids),
      ),
    )
    .groupBy(schema.mailboxItems.mailboxId);
  const queued = await db
    .select({
      mailboxId: schema.mailboxOutbox.mailboxId,
      bytes: sql<string>`coalesce(sum(${schema.mailboxOutbox.rawBytes}),0)::text`,
    })
    .from(schema.mailboxOutbox)
    .where(
      and(
        eq(schema.mailboxOutbox.teamId, actor.teamId),
        inArray(schema.mailboxOutbox.mailboxId, ids),
        isNotNull(schema.mailboxOutbox.ciphertext),
      ),
    )
    .groupBy(schema.mailboxOutbox.mailboxId);
  const outbound = await db
    .select({
      mailboxId: schema.mailboxOutbox.mailboxId,
      recipients: sql<string>`coalesce(sum(${schema.mailboxOutbox.recipientCount}),0)::text`,
    })
    .from(schema.mailboxOutbox)
    .where(
      and(
        eq(schema.mailboxOutbox.teamId, actor.teamId),
        inArray(schema.mailboxOutbox.mailboxId, ids),
        ne(schema.mailboxOutbox.status, "failed"),
        entitlement.unlimitedOutbound
          ? undefined
          : entitlement.usagePeriod
            ? eq(schema.mailboxOutbox.periodStart, entitlement.usagePeriod.start)
            : sql`false`,
      ),
    )
    .groupBy(schema.mailboxOutbox.mailboxId);
  const storage = new Map(stored.map((row) => [row.mailboxId, Number(row.bytes)]));
  const queue = new Map(queued.map((row) => [row.mailboxId, Number(row.bytes)]));
  const recipients = new Map(outbound.map((row) => [row.mailboxId, Number(row.recipients)]));
  // A "team" quota is one allowance for every mailbox of the team, readable or not.
  const team =
    plan?.quotaScope === "team"
      ? await teamUsage(db, actor.teamId, entitlement.usagePeriod?.start ?? null)
      : null;
  return {
    quotaScope: plan?.quotaScope ?? ("mailbox" as const),
    team: team && {
      ...team,
      storageLimitBytes: plan?.storageBytesPerMailbox ?? 0,
      outboundLimitRecipients: entitlement.unlimitedOutbound
        ? null
        : (plan?.includedOutboundPerMailbox ?? 0),
    },
    mailboxes: readable.map((box) => ({
      mailboxId: box.id,
      address: box.address,
      label: box.label,
      kind: box.kind,
      storageUsedBytes: (storage.get(box.id) ?? 0) + (queue.get(box.id) ?? 0),
      storageLimitBytes: plan?.storageBytesPerMailbox ?? 0,
      outboundUsedRecipients: recipients.get(box.id) ?? 0,
      outboundLimitRecipients: entitlement.unlimitedOutbound
        ? null
        : (plan?.includedOutboundPerMailbox ?? 0),
      periodStart: entitlement.usagePeriod?.start ?? null,
      periodEnd: entitlement.usagePeriod?.end ?? null,
    })),
  };
}

/** The whole team's storage and this period's recipients, for a shared ("team") quota. */
async function teamUsage(db: Db, teamId: string, periodStart: Date | null) {
  const [items] = await db
    .select({ bytes: sql<string>`coalesce(sum(${schema.mailboxItems.rawBytes}),0)::text` })
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.teamId, teamId));
  const [outbox] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${schema.mailboxOutbox.rawBytes}) filter (where ${schema.mailboxOutbox.ciphertext} is not null),0)::text`,
      recipients: periodStart
        ? sql<string>`coalesce(sum(${schema.mailboxOutbox.recipientCount}) filter (where ${schema.mailboxOutbox.periodStart} = ${periodStart} and ${schema.mailboxOutbox.status} <> 'failed'),0)::text`
        : sql<string>`'0'`,
    })
    .from(schema.mailboxOutbox)
    .where(eq(schema.mailboxOutbox.teamId, teamId));
  return {
    storageUsedBytes: Number(items?.bytes ?? 0) + Number(outbox?.bytes ?? 0),
    outboundUsedRecipients: Number(outbox?.recipients ?? 0),
  };
}
