import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { mailboxOutbox } from "../../db/src/schema/mailbox-transport.js";

/** Same ACS resource lock + rolling recipient ledger as claimAzureSend (API/SMTP).
 * An outbox claim already exists; this atomically binds ONE lifetime provider attempt
 * to it. Never refund Azure permits on errors/ambiguity or clear this lifetime fence.
 */
export async function reserveMailboxAzureBudget(
  db: Db,
  input: {
    outboxId: string;
    attemptId: string;
    teamId: string;
    mailboxId: string;
    recipients: number;
  },
): Promise<"reserved" | "quota" | "skipped"> {
  if (!Number.isSafeInteger(input.recipients) || input.recipients < 1 || input.recipients > 20)
    return "quota";
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(18475923, 1)`);
    const [row] = await tx
      .select()
      .from(mailboxOutbox)
      .where(
        and(
          eq(mailboxOutbox.id, input.outboxId),
          eq(mailboxOutbox.teamId, input.teamId),
          eq(mailboxOutbox.mailboxId, input.mailboxId),
          eq(mailboxOutbox.attemptId, input.attemptId),
          eq(mailboxOutbox.status, "sending"),
        ),
      )
      .for("update");
    if (
      !row ||
      row.recipientCount !== input.recipients ||
      row.providerMessageId ||
      !row.attemptedAt ||
      row.attemptedAt.getTime() < Date.now() - 15 * 60_000
    )
      return "skipped";
    const previous = await tx.execute(sql`select id from ${schema.auditLog}
      where action = 'sending.mailbox_azure_claimed' and team_id = ${input.teamId}
      and data->>'outboxId' = ${input.outboxId} limit 1`);
    const previousRows = Array.isArray(previous)
      ? previous
      : (previous as unknown as { rows: unknown[] }).rows;
    if (!previousRows || previousRows.length) return "skipped";
    const result = await tx.execute(sql`
      select coalesce(sum((data->>'units')::int) filter (where created_at > clock_timestamp() - interval '1 minute'), 0)::int as minute,
             coalesce(sum((data->>'units')::int), 0)::int as hour
      from ${schema.auditLog}
      where action = 'sending.azure_quota_reserved' and created_at > clock_timestamp() - interval '1 hour'
    `);
    const units = (
      Array.isArray(result)
        ? result
        : (result as unknown as { rows: { minute: number; hour: number }[] }).rows
    )[0] as { minute: number; hour: number } | undefined;
    if (
      !units ||
      !Number.isFinite(Number(units.minute)) ||
      !Number.isFinite(Number(units.hour)) ||
      Number(units.minute) + input.recipients > 30 ||
      Number(units.hour) + input.recipients > 100
    )
      return "quota";
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: "system",
      action: "sending.azure_quota_reserved",
      createdAt: sql`clock_timestamp()`,
      data: { units: input.recipients },
    });
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: "system",
      action: "sending.mailbox_azure_claimed",
      createdAt: sql`clock_timestamp()`,
      data: { outboxId: input.outboxId, attemptId: input.attemptId },
    });
    return "reserved";
  });
}
