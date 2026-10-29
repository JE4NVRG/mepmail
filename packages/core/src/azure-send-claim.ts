import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";

/** Shared ACS resource: rolling recipient quotas, not per process or tenant. */
export async function claimAzureSend(
  db: Db,
  input: {
    emailId: string;
    teamId: string;
    recipients: number;
    campaignSnapshot?: {
      createdAt: string;
      from: string;
      to: string[];
    };
  },
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
    const snapshot = input.campaignSnapshot;
    // One lifetime attempt per closed-cohort ID, even if a proven refusal releases sentAt.
    if (snapshot) {
      if (input.recipients !== 1 || snapshot.to.length !== 1) return "skipped";
      const previous = await tx.execute(sql`select id from ${schema.auditLog}
        where team_id = ${input.teamId} and action = 'sending.restoration_campaign_claimed'
        and data->>'emailId' = ${input.emailId} limit 1`);
      const rows = Array.isArray(previous)
        ? previous
        : (previous as unknown as { rows: unknown[] }).rows;
      if (!rows || rows.length !== 0) return "skipped";
    }
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
          ...(snapshot
            ? [
                sql`${schema.emails.createdAt} = ${snapshot.createdAt}::timestamptz`,
                eq(schema.emails.from, snapshot.from),
                sql`jsonb_array_length(${schema.emails.to}) = 1`,
                sql`${schema.emails.to}->>0 = ${snapshot.to[0]}`,
                sql`coalesce(jsonb_array_length(${schema.emails.cc}), 0) = 0`,
                sql`coalesce(jsonb_array_length(${schema.emails.bcc}), 0) = 0`,
              ]
            : []),
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
    if (snapshot)
      await tx.insert(schema.auditLog).values({
        teamId: input.teamId,
        actorId: "system",
        action: "sending.restoration_campaign_claimed",
        data: { emailId: input.emailId, purpose: "campaign", units: 1 },
      });
    return "claimed";
  });
}
