import { createHmac, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { mailboxSenderDecisions } from "../../db/src/schema/mailbox-sender-decisions.js";
import { decryptPayload, encryptPayload } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import {
  type MailboxContentActor,
  MailboxContentError,
  withMailboxOrganizationAccess,
} from "./mailbox-private-store.js";

/**
 * Aprovação de remetentes: the owner's allow/block answer per sender of one
 * mailbox. Lookups use an HMAC of the normalized address scoped to the mailbox
 * (the "sender key", derived from the deployment's master key), so the table
 * never holds an address in the clear; the address is also sealed, bound to its
 * row, so the owner can review and undo decisions. A blocked sender's new mail
 * belongs in Spam (receipt applies it); an allowed one skips the new-sender
 * screen.
 */
export type MailboxSenderDecision = "allow" | "block";

/** Decisions kept per mailbox. */
export const MAILBOX_SENDER_DECISIONS_MAX = 5000;
const MAX_ADDRESS = 320;

/** The sender-key HMAC key, kept apart from every other key derived from the master key. */
export function deriveMailboxSenderKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("mepmail/mailbox-sender/v1").digest();
}

/** Trimmed and lower-cased, or null when it is not one plausible address. */
export function normalizeMailboxSender(address: string): string | null {
  const value = address.trim().toLowerCase();
  if (!value || value.length > MAX_ADDRESS || /\s/.test(value)) return null;
  const at = value.lastIndexOf("@");
  return at > 0 && at < value.length - 1 ? value : null;
}

/** The lookup key of one sender in one mailbox (32 bytes). */
export function mailboxSenderKey(key: Buffer, mailboxId: string, address: string): Buffer {
  return createHmac("sha256", key).update(`${mailboxId}\n${address}`).digest();
}

const binding = (teamId: string, mailboxId: string, id: string) => ({
  teamId,
  kind: "email_body" as const,
  rowId: `mailbox-sender-v1:${mailboxId}:${id}`,
});

/**
 * The decisions for these senders of one mailbox, by normalized address.
 * Internal: the caller has already checked read access to the mailbox.
 */
export async function mailboxSenderDecisionsFor(
  db: Db,
  key: Buffer,
  input: { teamId: string; mailboxId: string; addresses: readonly string[] },
): Promise<Map<string, MailboxSenderDecision>> {
  const byKey = new Map<string, string>();
  for (const address of input.addresses) {
    const normalized = normalizeMailboxSender(address);
    if (normalized)
      byKey.set(mailboxSenderKey(key, input.mailboxId, normalized).toString("hex"), normalized);
  }
  const result = new Map<string, MailboxSenderDecision>();
  if (!byKey.size) return result;
  const rows = await db
    .select({
      senderKey: mailboxSenderDecisions.senderKey,
      decision: mailboxSenderDecisions.decision,
    })
    .from(mailboxSenderDecisions)
    .where(
      and(
        eq(mailboxSenderDecisions.teamId, input.teamId),
        eq(mailboxSenderDecisions.mailboxId, input.mailboxId),
        inArray(
          mailboxSenderDecisions.senderKey,
          [...byKey.keys()].map((hex) => Buffer.from(hex, "hex")),
        ),
      ),
    );
  for (const row of rows) {
    const address = byKey.get(Buffer.from(row.senderKey).toString("hex"));
    if (address) result.set(address, row.decision);
  }
  return result;
}

/** For receipt: whether this mailbox's owner blocked the sender. */
export async function isMailboxSenderBlocked(
  db: Db,
  key: Buffer,
  input: { teamId: string; mailboxId: string; address: string },
): Promise<boolean> {
  const decisions = await mailboxSenderDecisionsFor(db, key, {
    teamId: input.teamId,
    mailboxId: input.mailboxId,
    addresses: [input.address],
  });
  return [...decisions.values()][0] === "block";
}

/**
 * The owner allows or blocks a sender, or clears the answer (null). Changing
 * an existing answer keeps its sealed address; a new one seals it.
 */
export async function decideMailboxSender(
  db: Db,
  keyring: Keyring,
  key: Buffer,
  actor: MailboxContentActor,
  input: { mailboxId: string; address: string; decision: MailboxSenderDecision | null },
): Promise<{ address: string; decision: "allow" | "block" | null }> {
  actor = { ...actor };
  const address = normalizeMailboxSender(input.address);
  if (!address || (input.decision !== null && !["allow", "block"].includes(input.decision)))
    throw new MailboxContentError("invalid");
  const senderKey = mailboxSenderKey(key, input.mailboxId, address);
  return withMailboxOrganizationAccess(db, actor, input.mailboxId, async (tx) => {
    const scope = and(
      eq(mailboxSenderDecisions.teamId, actor.teamId),
      eq(mailboxSenderDecisions.mailboxId, input.mailboxId),
    );
    const [existing] = await tx
      .select({ id: mailboxSenderDecisions.id })
      .from(mailboxSenderDecisions)
      .where(and(scope, eq(mailboxSenderDecisions.senderKey, senderKey)))
      .for("update");
    if (input.decision === null) {
      if (existing)
        await tx.delete(mailboxSenderDecisions).where(eq(mailboxSenderDecisions.id, existing.id));
      return { address, decision: null };
    }
    if (existing) {
      await tx
        .update(mailboxSenderDecisions)
        .set({ decision: input.decision, decidedBy: actor.userId, updatedAt: new Date() })
        .where(eq(mailboxSenderDecisions.id, existing.id));
      return { address, decision: input.decision };
    }
    const [total] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(mailboxSenderDecisions)
      .where(scope);
    if ((total?.count ?? 0) >= MAILBOX_SENDER_DECISIONS_MAX)
      throw new MailboxContentError("conflict");
    const id = randomUUID();
    const sealed = await encryptPayload(
      Buffer.from(address, "utf8"),
      keyring,
      binding(actor.teamId, input.mailboxId, id),
    );
    await tx.insert(mailboxSenderDecisions).values({
      id,
      teamId: actor.teamId,
      mailboxId: input.mailboxId,
      senderKey,
      decision: input.decision,
      addressCiphertext: sealed.ciphertext,
      addressIv: sealed.iv,
      addressWrappedDek: sealed.wrappedDek,
      addressKeyVersion: sealed.keyVersion,
      decidedBy: actor.userId,
    });
    return { address, decision: input.decision };
  });
}

/** The owner's decisions for one mailbox, newest first, with the addresses opened. */
export async function listMailboxSenderDecisions(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string },
): Promise<{ address: string; decision: "allow" | "block"; updatedAt: Date }[]> {
  actor = { ...actor };
  const rows = await withMailboxOrganizationAccess(db, actor, input.mailboxId, (tx) =>
    tx
      .select()
      .from(mailboxSenderDecisions)
      .where(
        and(
          eq(mailboxSenderDecisions.teamId, actor.teamId),
          eq(mailboxSenderDecisions.mailboxId, input.mailboxId),
        ),
      )
      .orderBy(desc(mailboxSenderDecisions.updatedAt), desc(mailboxSenderDecisions.id)),
  );
  const opened = await Promise.all(
    rows.map(async (row) => {
      try {
        const address = await decryptPayload(
          {
            ciphertext: Buffer.from(row.addressCiphertext),
            iv: Buffer.from(row.addressIv),
            wrappedDek: Buffer.from(row.addressWrappedDek),
            keyVersion: row.addressKeyVersion,
          },
          keyring,
          binding(row.teamId, row.mailboxId, row.id),
        );
        return {
          address: address.toString("utf8"),
          decision: row.decision,
          updatedAt: row.updatedAt,
        };
      } catch {
        // A row that no longer opens is left out rather than shown wrong.
        return null;
      }
    }),
  );
  return opened.filter((row): row is NonNullable<typeof row> => row !== null);
}
