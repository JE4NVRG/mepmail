import { buildAccountMail, claimNotification, DAY_MS, formatMailDate } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, gt, lte } from "drizzle-orm";
import { mailOwners, type SystemMailer } from "../system-mail.js";

/** How far ahead of a Correio free trial's end its owners hear about it. */
export const MAILBOX_TRIAL_WARN_MS = 2 * DAY_MS;
const KIND = "mailbox.trial_ending" as const;

/**
 * Every 10 minutes with notifications.sweep: a team whose Correio free trial
 * ends within two days is told once (claimed on the trial's end, so a trial
 * that is extended or restarted would warn again), with the date and how to
 * cancel before the first charge.
 */
export async function warnEndingMailboxTrials(
  db: Db,
  deps: { mailer: SystemMailer; appBaseUrl?: string | undefined; now?: Date | undefined },
): Promise<{ sent: number }> {
  const now = deps.now ?? new Date();
  const plans = await db
    .select({
      teamId: schema.mailboxSubscriptions.teamId,
      periodEnd: schema.mailboxSubscriptions.periodEnd,
      seats: schema.mailboxSubscriptions.seats,
      team: schema.teams.name,
    })
    .from(schema.mailboxSubscriptions)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.mailboxSubscriptions.teamId))
    .where(
      and(
        eq(schema.mailboxSubscriptions.status, "trialing"),
        gt(schema.mailboxSubscriptions.periodEnd, now),
        lte(schema.mailboxSubscriptions.periodEnd, new Date(now.getTime() + MAILBOX_TRIAL_WARN_MS)),
      ),
    );
  let sent = 0;
  for (const plan of plans) {
    if (
      !(await claimNotification(db, {
        teamId: plan.teamId,
        kind: KIND,
        periodKey: plan.periodEnd.toISOString(),
      }))
    )
      continue;
    try {
      await mailOwners(db, deps.mailer, plan.teamId, KIND, (locale) =>
        buildAccountMail({
          kind: KIND,
          locale,
          url: `${deps.appBaseUrl ?? ""}/settings/billing`,
          values: {
            team: plan.team,
            date: formatMailDate(locale, plan.periodEnd),
            mailboxes: String(plan.seats),
          },
        }),
      );
      sent += 1;
    } catch (err) {
      console.error(`notifications.sweep: ${KIND} for team ${plan.teamId} failed`, err);
    }
  }
  return { sent };
}
