import { type Db, schema } from "@millionsend/db";
import { and, asc, count, eq, gt, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { mailboxAliasAddresses } from "./mailbox-aliases.js";
import {
  type MailboxRegistryActor,
  MailboxRegistryError,
  withMailboxRegistryAdmin,
} from "./mailbox-registry.js";
import {
  MailboxServiceError,
  mailboxHoldsSeat,
  mailboxServiceEntitlement,
  mailboxSubscriptionUsagePeriod,
} from "./mailbox-service.js";

/**
 * Excluir caixa (Jean 2026-10-11). A team admin types the mailbox's address to delete it:
 * the mailbox is suspended at once (no mail in or out, no reading, no agents), stops
 * holding a seat, and its addresses leave the SES receipt rules (the caller does that,
 * and the purge makes sure). For MAILBOX_DELETION_GRACE_MS it can be restored as it was,
 * if the plan has a free seat for it. Past that the worker erases it: send records,
 * messages (and their search index), folders and finally the row, whose cascade takes
 * grants, agent keys, aliases, import jobs and sender decisions, and frees the address.
 *
 * The deadline is read on the database clock on both sides, so a restore and the purge
 * never both see it open.
 */
export const MAILBOX_DELETION_GRACE_MS = 30 * 86_400_000;

const mine = (actor: MailboxRegistryActor, id: string) =>
  and(eq(schema.mailboxes.id, id), eq(schema.mailboxes.teamId, actor.teamId));
const due = () =>
  and(isNotNull(schema.mailboxes.deleteAfter), lte(schema.mailboxes.deleteAfter, sql`now()`));

export async function requestMailboxDeletion(
  db: Db,
  actor: MailboxRegistryActor,
  input: { id: string; address: string },
  now = new Date(),
): Promise<{ id: string; address: string; deleteAfter: Date; addresses: string[] }> {
  const typed = typeof input.address === "string" ? input.address.trim().toLowerCase() : "";
  return withMailboxRegistryAdmin(db, actor, async (tx) => {
    const [box] = await tx
      .select()
      .from(schema.mailboxes)
      .where(mine(actor, input.id))
      .for("update");
    if (!box) throw new MailboxRegistryError("not_found");
    if (box.deleteAfter) throw new MailboxRegistryError("conflict");
    // The typed address is the confirmation: nothing is deleted by a stray click.
    if (typed !== box.address) throw new MailboxRegistryError("invalid");
    const deleteAfter = new Date(now.getTime() + MAILBOX_DELETION_GRACE_MS);
    const [row] = await tx
      .update(schema.mailboxes)
      .set({
        status: "suspended",
        statusBeforeDeletion: box.status,
        deletionRequestedAt: now,
        deletionRequestedBy: actor.userId,
        deleteAfter,
        updatedAt: now,
      })
      .where(and(mine(actor, input.id), isNull(schema.mailboxes.deleteAfter)))
      .returning();
    if (!row) throw new MailboxRegistryError("conflict");
    const aliases = await mailboxAliasAddresses(tx, actor.teamId, [row.id]);
    return {
      id: row.id,
      address: row.address,
      deleteAfter,
      // Every address SES may route to it: these leave the receipt rules now.
      addresses: [row.address, ...aliases.map((alias) => alias.address)],
    };
  });
}

/** Undo a deletion before its deadline; the plan must have a seat for the mailbox again. */
export async function restoreMailboxDeletion(
  db: Db,
  actor: MailboxRegistryActor,
  id: string,
): Promise<{ id: string; domainId: string | null; status: "planned" | "suspended" }> {
  return withMailboxRegistryAdmin(db, actor, async (tx) => {
    // Lock order as in creation: membership (above), service, then the mailbox.
    const service = await mailboxServiceEntitlement(tx, actor.teamId, true);
    const [box] = await tx.select().from(schema.mailboxes).where(mine(actor, id)).for("update");
    if (!box) throw new MailboxRegistryError("not_found");
    if (!box.deleteAfter || !box.statusBeforeDeletion) throw new MailboxRegistryError("conflict");
    // Restoring must not push a newer mailbox out of its seat: refuse when the plan is full.
    if (service.active && !service.unlimitedSeats && service.plan) {
      const [held] = await tx
        .select({ boxes: count() })
        .from(schema.mailboxes)
        .where(and(eq(schema.mailboxes.teamId, actor.teamId), mailboxHoldsSeat()));
      if ((held?.boxes ?? 0) >= service.plan.seats) throw new MailboxServiceError("quota");
    }
    const [row] = await tx
      .update(schema.mailboxes)
      .set({
        status: box.statusBeforeDeletion,
        statusBeforeDeletion: null,
        deletionRequestedAt: null,
        deletionRequestedBy: null,
        deleteAfter: null,
        updatedAt: new Date(),
      })
      .where(and(mine(actor, id), gt(schema.mailboxes.deleteAfter, sql`now()`)))
      .returning();
    // Past the deadline the mailbox belongs to the purge.
    if (!row) throw new MailboxRegistryError("conflict");
    return { id: row.id, domainId: row.domainId, status: row.status };
  });
}

export interface MailboxDeletionDue {
  id: string;
  teamId: string;
  /** Its address and its aliases: all must be out of SES before the row goes. */
  addresses: string[];
}

/**
 * Mailboxes past their deadline, oldest first. One with a send record from the last 32
 * days is left out: it may be waiting for its billing period to turn (see the purge),
 * and must not hold back the mailboxes behind it. It comes back once the record ages.
 */
export async function dueMailboxDeletions(db: Db, limit = 10): Promise<MailboxDeletionDue[]> {
  const boxes = await db
    .select({
      id: schema.mailboxes.id,
      teamId: schema.mailboxes.teamId,
      address: schema.mailboxes.address,
    })
    .from(schema.mailboxes)
    .where(
      and(
        due(),
        sql`not exists (select 1 from ${schema.mailboxOutbox} where ${schema.mailboxOutbox.mailboxId} = ${schema.mailboxes.id} and ${schema.mailboxOutbox.teamId} = ${schema.mailboxes.teamId} and ${schema.mailboxOutbox.periodStart} > now() - interval '32 days')`,
      ),
    )
    .orderBy(asc(schema.mailboxes.deleteAfter), asc(schema.mailboxes.id))
    .limit(limit);
  const out: MailboxDeletionDue[] = [];
  for (const box of boxes) {
    const aliases = await mailboxAliasAddresses(db, box.teamId, [box.id]);
    out.push({
      id: box.id,
      teamId: box.teamId,
      addresses: [box.address, ...aliases.map((alias) => alias.address)],
    });
  }
  return out;
}

export type MailboxPurgeOutcome = "erased" | "partial" | "waiting" | "gone";

/**
 * Erase one due mailbox, a batch of messages per transaction until `deadline` (ms epoch);
 * "partial" means call again. The caller has already taken its addresses out of SES.
 * "waiting": it sent mail in the team's current billing period, and those send records
 * are the period's outbound usage, so it is erased once the period has turned.
 */
export async function purgeMailboxDeletion(
  db: Db,
  target: { id: string; teamId: string },
  options: { batch?: number; deadline?: number } = {},
): Promise<MailboxPurgeOutcome> {
  const batch = options.batch ?? 500;
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const actor = { teamId: target.teamId, userId: "" };
  const lockDue = async (tx: Db) => {
    const [box] = await tx
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(and(mine(actor, target.id), due()))
      .for("update");
    return !!box;
  };

  const [plan] = await db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, target.teamId));
  if (plan) {
    // As the receiving holds read it: the usage period, or the billing period itself.
    const period = mailboxSubscriptionUsagePeriod(plan, new Date()) ?? { start: plan.periodStart };
    const [recent] = await db
      .select({ id: schema.mailboxOutbox.id })
      .from(schema.mailboxOutbox)
      .where(
        and(
          eq(schema.mailboxOutbox.mailboxId, target.id),
          eq(schema.mailboxOutbox.teamId, target.teamId),
          gte(schema.mailboxOutbox.periodStart, period.start),
        ),
      )
      .limit(1);
    if (recent) {
      const [box] = await db
        .select({ id: schema.mailboxes.id })
        .from(schema.mailboxes)
        .where(and(mine(actor, target.id), due()));
      return box ? "waiting" : "gone";
    }
  }

  // Send records first: an outbox row holds its draft (ON DELETE RESTRICT).
  const started = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    if (!(await lockDue(tx))) return false;
    await tx
      .delete(schema.mailboxOutbox)
      .where(
        and(
          eq(schema.mailboxOutbox.mailboxId, target.id),
          eq(schema.mailboxOutbox.teamId, target.teamId),
        ),
      );
    return true;
  });
  if (!started) return "gone";

  for (;;) {
    const removed = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      if (!(await lockDue(tx))) return null;
      const ids = await tx
        .select({ id: schema.mailboxItems.id })
        .from(schema.mailboxItems)
        .where(
          and(
            eq(schema.mailboxItems.mailboxId, target.id),
            eq(schema.mailboxItems.teamId, target.teamId),
          ),
        )
        .limit(batch);
      if (!ids.length) return 0;
      await tx.delete(schema.mailboxItems).where(
        and(
          eq(schema.mailboxItems.teamId, target.teamId),
          inArray(
            schema.mailboxItems.id,
            ids.map((row) => row.id),
          ),
        ),
      );
      return ids.length;
    });
    if (removed === null) return "gone";
    if (removed === 0) break;
    if (Date.now() >= deadline) return "partial";
  }

  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    if (!(await lockDue(tx))) return "gone" as const;
    const [left] = await tx
      .select({ items: count() })
      .from(schema.mailboxItems)
      .where(
        and(
          eq(schema.mailboxItems.mailboxId, target.id),
          eq(schema.mailboxItems.teamId, target.teamId),
        ),
      );
    if ((left?.items ?? 0) > 0) return "partial" as const;
    await tx
      .delete(schema.mailboxFolders)
      .where(
        and(
          eq(schema.mailboxFolders.mailboxId, target.id),
          eq(schema.mailboxFolders.teamId, target.teamId),
        ),
      );
    await tx.delete(schema.mailboxes).where(mine(actor, target.id));
    return "erased" as const;
  });
}
