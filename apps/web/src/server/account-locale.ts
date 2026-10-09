import { accountEmailFrom } from "@millionsend/config";
import { findSenderDomainOwner, syncSystemContactLocale } from "@millionsend/core";
import type { Db } from "@millionsend/db";

/** Accounts younger than this have their mail language checked on each dashboard visit. */
const SYNC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Aligns the account-mail language (welcome, getting-started reminders,
 * notices) with the language this person's dashboard renders in. The sign-up
 * request is a poor witness: an OAuth callback or an older opt-in contact can
 * leave English on a Portuguese reader. Best-effort, a no-op without an
 * account-mail team, and only for young accounts so a settled dashboard does
 * not write on every navigation.
 */
export async function syncAccountMailLocale(
  db: Db,
  user: { email: string; createdAt: Date | string },
  locale: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    if (now.getTime() - new Date(user.createdAt).getTime() > SYNC_WINDOW_MS) return;
    const from = accountEmailFrom();
    const owner = from ? await findSenderDomainOwner(db, from) : null;
    if (!owner) return;
    await syncSystemContactLocale(db, owner.teamId, user.email, locale);
  } catch (error) {
    console.error("Account-mail locale sync failed", error);
  }
}
