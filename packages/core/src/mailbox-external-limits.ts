import { type Db, schema } from "@millionsend/db";
import { and, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { MailboxServiceError } from "./mailbox-service.js";

/**
 * Contas externas are free (Jean 2026-10-13): no Correio plan or seat, bounded instead,
 * and the bounds come down by env if their cost shows. A connected account's copies,
 * sends and syncs are counted per account; domain mailboxes never pass through here.
 */
export function mailboxExternalLimits() {
  const read = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    /** Accounts one person may connect on a team. */
    accountsPerUser: read("MAILBOX_EXTERNAL_MAX_PER_USER", 3),
    /** Accounts one team may hold (the worker syncs them all, plan or not). */
    accountsPerTeam: read("MAILBOX_EXTERNAL_MAX_PER_TEAM", 25),
    /** Sealed copies kept per account (received, drafts and sent). */
    storageBytes: read("MAILBOX_EXTERNAL_STORAGE_BYTES", 1024 ** 3),
    /** Recipients one account may send to through its own SMTP, per hour and per day. */
    recipientsPerHour: read("MAILBOX_EXTERNAL_RECIPIENTS_PER_HOUR", 100),
    recipientsPerDay: read("MAILBOX_EXTERNAL_RECIPIENTS_PER_DAY", 400),
  };
}

/** Whether a mailbox is a connected external account (no team domain, no plan seat). */
export async function mailboxIsExternal(db: Db, mailboxId: string): Promise<boolean> {
  const [box] = await db
    .select({ origin: schema.mailboxes.origin })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId));
  return box?.origin === "external";
}

/** The account's sealed copies, plus what waits in its outbox, stay under its own cap. */
export async function assertMailboxExternalStorage(db: Db, mailboxId: string, delta: number) {
  if (!Number.isSafeInteger(delta)) throw new MailboxServiceError("invalid");
  const [items] = await db
    .select({ bytes: sql<string>`coalesce(sum(${schema.mailboxItems.rawBytes}),0)::text` })
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.mailboxId, mailboxId));
  const [outbox] = await db
    .select({ bytes: sql<string>`coalesce(sum(${schema.mailboxOutbox.rawBytes}),0)::text` })
    .from(schema.mailboxOutbox)
    .where(
      and(
        eq(schema.mailboxOutbox.mailboxId, mailboxId),
        isNotNull(schema.mailboxOutbox.ciphertext),
      ),
    );
  const stored = BigInt(items?.bytes ?? "0") + BigInt(outbox?.bytes ?? "0") + BigInt(delta);
  if (stored > BigInt(mailboxExternalLimits().storageBytes))
    throw new MailboxServiceError("external_storage");
}

/**
 * Sending through the person's own SMTP still relays third-party mail from our servers:
 * each account sends to at most so many recipients an hour and a day.
 */
export async function assertMailboxExternalSendRate(
  db: Db,
  mailboxId: string,
  recipients: number,
  now = new Date(),
) {
  const limits = mailboxExternalLimits();
  const since = async (ms: number) => {
    const [row] = await db
      .select({ count: sql<string>`coalesce(sum(${schema.mailboxOutbox.recipientCount}),0)::text` })
      .from(schema.mailboxOutbox)
      .where(
        and(
          eq(schema.mailboxOutbox.mailboxId, mailboxId),
          ne(schema.mailboxOutbox.status, "failed"),
          gte(schema.mailboxOutbox.createdAt, new Date(now.getTime() - ms)),
        ),
      );
    return Number(row?.count ?? "0");
  };
  if (
    (await since(3_600_000)) + recipients > limits.recipientsPerHour ||
    (await since(86_400_000)) + recipients > limits.recipientsPerDay
  )
    throw new MailboxServiceError("external_send_rate");
}

/** The counter period an external send is filed under (calendar month, UTC): no plan term. */
export function mailboxExternalUsagePeriod(now = new Date()) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}
