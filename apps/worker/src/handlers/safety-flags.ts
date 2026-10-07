import {
  computeTeamStandings,
  holdReputationRuns,
  markSendReviewNotified,
  pruneTeamStandings,
  recordAudit,
  recordProbes,
  saveTeamStandings,
  syncTeamFlags,
  unnotifiedSendReviews,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { mailOperator, type SystemMailer } from "../system-mail.js";

/**
 * Refresh every active team's standing (score, guardrail, 7-day rates) and
 * open or clear the automatic trust & safety flags from it. The unsubscribed
 * contact count rides along: it is a scan of the contacts table, too heavy
 * for the minute probe and cheap enough every quarter hour.
 */
export async function runSafetyFlags(
  db: Db,
  opts: {
    now?: Date;
    monitorFlagRisk?: number | undefined;
    mailer?: SystemMailer | undefined;
    appBaseUrl?: string | undefined;
  } = {},
): Promise<{ teams: number; opened: number; cleared: number; reviews: number }> {
  const now = opts.now ?? new Date();
  const previous = await db.select().from(schema.teamStandings);
  const standings = await computeTeamStandings(db, now);
  const flags = await syncTeamFlags(db, standings, now, previous, {
    monitorFlagRisk: opts.monitorFlagRisk,
  });
  await saveTeamStandings(db, standings, now);
  await pruneTeamStandings(db, now);
  // A paused guardrail holds the team's transactional mail too; the notice
  // below tells the operator about each new hold.
  await holdReputationRuns(db, standings, now);
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.contacts)
      .where(eq(schema.contacts.unsubscribed, true));
    await recordProbes(db, [{ probe: "contacts_unsubscribed", value: row?.n ?? 0, ok: true }], now);
  } catch (err) {
    console.warn("safety.flags: contacts_unsubscribed probe failed", err);
  }
  const reviews = await notifySendReviews(db, { ...opts, now });
  return { teams: standings.length, ...flags, reviews };
}

/**
 * Tell the operator about every new send-review hold, once per hold: the
 * audit row and the notice are written here, after the hold committed,
 * whichever surface (accept, fan-out, Stripe webhook) opened it.
 */
export async function notifySendReviews(
  db: Db,
  opts: { now: Date; mailer?: SystemMailer | undefined; appBaseUrl?: string | undefined },
): Promise<number> {
  let told = 0;
  for (const hold of await unnotifiedSendReviews(db)) {
    if (!(await markSendReviewNotified(db, hold.id, opts.now))) continue;
    told += 1;
    await recordAudit(db, {
      teamId: hold.id,
      actor: hold.reason === "payment_risk" ? "stripe" : "system",
      action: "team.send_review_held",
      target: { type: "team", id: hold.id },
      metadata: { reason: hold.reason },
    });
    if (!opts.mailer) continue;
    try {
      await mailOperator(
        db,
        opts.mailer,
        "review.held",
        `/console/safety/${hold.id}`,
        { team: hold.name, note: hold.note ?? hold.reason ?? "" },
        opts.appBaseUrl,
      );
    } catch (err) {
      console.error(`safety.flags: review notice for ${hold.id} failed`, err);
    }
  }
  return told;
}
