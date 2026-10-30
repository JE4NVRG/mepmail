import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { type CampaignSendWindow, campaignSendWindowOpen } from "./campaign-send-window.js";

class AzureCampaignWindowClosed extends Error {}

/** Shared ACS resource: rolling recipient quotas, not per process or tenant. */
export async function claimAzureSend(
  db: Db,
  input: {
    emailId: string;
    teamId: string;
    recipients: number;
    now?: (() => Date) | undefined;
    campaignSnapshot?: {
      sendWindow: CampaignSendWindow;
      createdAt: string;
      from: string;
      to: string[];
    };
  },
): Promise<"claimed" | "skipped" | "quota"> {
  const snapshot = input.campaignSnapshot;
  const windowOpen = () => !snapshot || campaignSendWindowOpen(snapshot.sendWindow, input.now?.());
  if (!windowOpen()) return "skipped";
  if (!Number.isSafeInteger(input.recipients) || input.recipients < 1 || input.recipients > 30)
    return "quota";
  try {
    return await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      // Only uncommitted writes from THIS attempt may be rolled back on expiry.
      const requireFreshWindow = async () => {
        if (!snapshot) return;
        if (!windowOpen()) throw new AzureCampaignWindowClosed();
        const result = await tx.execute(sql`select (
        clock_timestamp() >= ${snapshot.sendWindow.startsAt}::timestamptz
        and clock_timestamp() < ${snapshot.sendWindow.endsAt}::timestamptz
      ) as campaign_window_open`);
        const rows = Array.isArray(result)
          ? result
          : (result as unknown as { rows?: { campaign_window_open: boolean }[] }).rows;
        if (rows?.[0]?.campaign_window_open !== true || !windowOpen())
          throw new AzureCampaignWindowClosed();
      };
      await tx.execute(sql`select pg_advisory_xact_lock(18475923, 1)`);
      if (!windowOpen()) return "skipped";
      const result = await tx.execute(sql`
      select coalesce(sum((data->>'units')::int) filter (where created_at > clock_timestamp() - interval '1 minute'), 0)::int as minute,
             coalesce(sum((data->>'units')::int), 0)::int as hour
      from ${schema.auditLog}
      where action = 'sending.azure_quota_reserved' and created_at > clock_timestamp() - interval '1 hour'
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
      if (!windowOpen()) return "skipped";
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
                  // Initial SQL fence; the post-RETURNING check also closes row-lock waits.
                  sql`clock_timestamp() >= ${snapshot.sendWindow.startsAt}::timestamptz`,
                  sql`clock_timestamp() < ${snapshot.sendWindow.endsAt}::timestamptz`,
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
      await requireFreshWindow();
      await tx.insert(schema.auditLog).values({
        teamId: input.teamId,
        actorId: "system",
        action: "sending.azure_quota_reserved",
        createdAt: sql`clock_timestamp()`,
        data: { units: input.recipients },
      });
      await requireFreshWindow();
      if (snapshot)
        await tx.insert(schema.auditLog).values({
          teamId: input.teamId,
          actorId: "system",
          action: "sending.restoration_campaign_claimed",
          createdAt: sql`clock_timestamp()`,
          data: { emailId: input.emailId, purpose: "campaign", units: 1 },
        });
      await requireFreshWindow();
      return "claimed";
    });
  } catch (error) {
    if (error instanceof AzureCampaignWindowClosed) return "skipped";
    throw error;
  }
}
