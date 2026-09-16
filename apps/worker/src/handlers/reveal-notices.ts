import {
  accountMailPhrase,
  buildAccountMail,
  CONTENT_REVEAL_FIELDS,
  CONTENT_REVEAL_NOTICE_DAYS,
  formatMailDateTime,
  type MailLocale,
  recordAudit,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, lte } from "drizzle-orm";
import { mailOwners, type SystemMailer } from "../system-mail.js";

export interface RevealNoticeDeps {
  mailer?: SystemMailer | undefined;
  appBaseUrl?: string | undefined;
  now?: Date | undefined;
}

/**
 * The disclosure side of break-glass content access: seven days after a
 * grant, the team's own audit gains a `content.accessed` row dated at the
 * access and its owners are told, in their own language.
 *
 * Withheld for a team suspended for phishing after the grant — telling the
 * account under investigation what was read, and when, is the one case where
 * disclosure works against the reason the content was read at all. The grant
 * is stamped either way so a withheld notice is not retried every night.
 */
export async function runRevealNotices(
  db: Db,
  deps: RevealNoticeDeps = {},
): Promise<{ disclosed: number; withheld: number }> {
  const now = deps.now ?? new Date();
  const due = new Date(now.getTime() - CONTENT_REVEAL_NOTICE_DAYS * 86_400_000);
  const g = schema.contentAccessGrants;
  const grants = await db
    .select({
      id: g.id,
      teamId: g.teamId,
      reason: g.reason,
      emailIds: g.emailIds,
      createdAt: g.createdAt,
      teamName: schema.teams.name,
      suspendedAt: schema.teams.suspendedAt,
      suspensionReason: schema.teams.suspensionReason,
    })
    .from(g)
    .innerJoin(schema.teams, eq(schema.teams.id, g.teamId))
    .where(and(isNull(g.noticeSentAt), lte(g.createdAt, due)))
    .orderBy(g.createdAt)
    .limit(200);

  let disclosed = 0;
  let withheld = 0;
  for (const grant of grants) {
    const underInvestigation =
      grant.suspensionReason === "phishing" &&
      grant.suspendedAt !== null &&
      grant.suspendedAt > grant.createdAt;
    try {
      if (!underInvestigation) {
        await recordAudit(db, {
          teamId: grant.teamId,
          actor: "system",
          action: "content.accessed",
          target: { type: "content_access_grant", id: grant.id },
          metadata: {
            reason: grant.reason,
            emails: grant.emailIds.length,
            fields: CONTENT_REVEAL_FIELDS,
          },
          at: grant.createdAt,
        });
        await sendNotice(db, deps, grant);
      }
      await db
        .update(g)
        .set({
          noticeSentAt: now,
          ...(underInvestigation ? {} : { teamVisibleAt: now }),
        })
        .where(and(eq(g.id, grant.id), isNull(g.noticeSentAt)));
      if (underInvestigation) withheld += 1;
      else disclosed += 1;
    } catch (err) {
      console.error(`safety.reveal_notices: grant ${grant.id} failed`, err);
    }
  }
  return { disclosed, withheld };
}

function sendNotice(
  db: Db,
  deps: RevealNoticeDeps,
  grant: { teamId: string; teamName: string; reason: string; emailIds: string[]; createdAt: Date },
): Promise<unknown> {
  if (!deps.mailer) return Promise.resolve();
  const count = grant.emailIds.length;
  const values = (locale: MailLocale) => ({
    team: grant.teamName,
    when: formatMailDateTime(locale, grant.createdAt),
    emails: accountMailPhrase({
      locale,
      kind: "content.access_notice",
      key: count === 1 ? "one" : "many",
      values: { n: count.toLocaleString(locale) },
    }),
    reason: accountMailPhrase({
      locale,
      kind: "content.access_notice",
      key: grant.reason,
    }),
  });
  return mailOwners(db, deps.mailer, grant.teamId, "content.access_notice", (locale) =>
    buildAccountMail({
      kind: "content.access_notice",
      locale,
      url: `${deps.appBaseUrl ?? ""}/settings/audit`,
      values: values(locale),
    }),
  );
}
