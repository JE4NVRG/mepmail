import type { Db } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { mailboxRecipientBlocks } from "../../db/src/schema/mailbox-transport.js";
import { recordAudit } from "./audit.js";
import { MailboxContentError } from "./mailbox-private-store.js";
import { type MailboxRegistryActor, withMailboxRegistryAdmin } from "./mailbox-registry.js";
import { mailboxRecipientHash } from "./mailbox-transport.js";

/**
 * A recipient the team's Correio sends no longer reach: after a hard bounce (the address
 * did not exist or its server refused it) or a complaint (the person marked the mail as
 * spam). Blocks are kept by a keyed hash of the address, never the address, so they are
 * looked up and lifted by the address the person names (the one a refused send reported).
 */
export interface MailboxRecipientBlockState {
  address: string;
  blocked: boolean;
  reason: "hard_bounce" | "complaint" | null;
  blockedAt: Date | null;
}

function normalize(address: unknown): string {
  const value = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!value || value.length > 254 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value))
    throw new MailboxContentError("invalid");
  return value;
}

/** Whether the team's sends to this address are blocked, and why (team owners and admins). */
export async function getMailboxRecipientBlock(
  db: Db,
  actor: MailboxRegistryActor,
  input: { address: string },
): Promise<MailboxRecipientBlockState> {
  const address = normalize(input.address);
  return withMailboxRegistryAdmin(db, actor, async (tx) => {
    const [row] = await tx
      .select()
      .from(mailboxRecipientBlocks)
      .where(
        and(
          eq(mailboxRecipientBlocks.teamId, actor.teamId),
          eq(mailboxRecipientBlocks.recipientHash, mailboxRecipientHash(actor.teamId, address)),
        ),
      );
    return {
      address,
      blocked: !!row,
      reason: row?.reason ?? null,
      blockedAt: row?.blockedAt ?? null,
    };
  });
}

/**
 * Lifts a hard-bounce block so the team can send to the address again, e.g. after the
 * mailbox behind it was fixed. A complaint block stays: the person asked not to get this
 * mail, and sending again harms the sending reputation (MailboxContentError "forbidden").
 * Team owners and admins only; audited without the address (its block hash prefix only).
 */
export async function unblockMailboxRecipient(
  db: Db,
  actor: MailboxRegistryActor,
  input: { address: string },
): Promise<MailboxRecipientBlockState & { unblocked: boolean }> {
  const address = normalize(input.address);
  return withMailboxRegistryAdmin(db, actor, async (tx) => {
    const hash = mailboxRecipientHash(actor.teamId, address);
    const mine = and(
      eq(mailboxRecipientBlocks.teamId, actor.teamId),
      eq(mailboxRecipientBlocks.recipientHash, hash),
    );
    const [row] = await tx.select().from(mailboxRecipientBlocks).where(mine).for("update");
    if (!row) return { address, blocked: false, reason: null, blockedAt: null, unblocked: false };
    if (row.reason !== "hard_bounce") throw new MailboxContentError("forbidden");
    await tx.delete(mailboxRecipientBlocks).where(mine);
    await recordAudit(tx, {
      teamId: actor.teamId,
      actor: { userId: actor.userId },
      action: "mailbox.recipient_unblocked",
      target: { type: "mailbox_recipient_block", id: hash.slice(0, 16) },
      metadata: { reason: row.reason, blockedAt: row.blockedAt.toISOString() },
    });
    return { address, blocked: false, reason: null, blockedAt: null, unblocked: true };
  });
}
