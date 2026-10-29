import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";

/** Shared ACS resource: rolling recipient quotas, not per process or tenant. */
export async function claimAzureSend(
  db: Db,
  input: { emailId: string; teamId: string; recipients: number },
): Promise<"claimed" | "skipped" | "quota"> {
  if (!Number.isSafeInteger(input.recipients) || input.recipients < 1 || input.recipients > 30)
    return "quota";
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(18475923, 1)`);
    const result = await tx.execute(sql`
      select coalesce(sum((data->>'units')::int) filter (where created_at > now() - interval '1 minute'), 0)::int as minute,
             coalesce(sum((data->>'units')::int), 0)::int as hour
      from ${schema.auditLog}
      where action = 'sending.azure_quota_reserved' and created_at > now() - interval '1 hour'
    `);
    const row = (
      Array.isArray(result)
        ? result
        : (result as unknown as { rows: { minute: number; hour: number }[] }).rows
    )[0] as { minute: number; hour: number } | undefined;
    if (
      !row ||
      Number(row.minute) + input.recipients > 30 ||
      Number(row.hour) + input.recipients > 100
    )
      return "quota";
    const [claimed] = await tx
      .update(schema.emails)
      .set({ sentAt: new Date() })
      .where(
        and(
          eq(schema.emails.id, input.emailId),
          eq(schema.emails.teamId, input.teamId),
          eq(schema.emails.latestStatus, "queued"),
          isNull(schema.emails.sentAt),
          isNull(schema.emails.sesMessageId),
        ),
      )
      .returning({ id: schema.emails.id });
    if (!claimed) return "skipped";
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: "system",
      action: "sending.azure_quota_reserved",
      data: { units: input.recipients },
    });
    return "claimed";
  });
}
