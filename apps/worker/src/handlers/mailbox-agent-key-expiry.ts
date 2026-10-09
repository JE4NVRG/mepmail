import { accountEmailFrom } from "@millionsend/config";
import {
  accountLocale,
  buildAccountMail,
  claimNotification,
  DAY_MS,
  type ExpiringMailboxAgentCredential,
  formatMailDate,
  listExpiringMailboxAgentCredentials,
  type MailLocale,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import type { SystemMailer } from "../system-mail.js";

/** How far ahead of an agent key's expiry its owner hears about it. */
export const MAILBOX_AGENT_KEY_WARN_MS = 7 * DAY_MS;
const KIND = "mailbox.agent_key_expiring" as const;
/** Mailbox addresses named in the notice before the rest are counted. */
const NAMED = 3;

export interface MailboxAgentKeyExpiryDeps {
  mailer: SystemMailer;
  appBaseUrl?: string | undefined;
  now?: Date | undefined;
  /** Tests hand in the credentials instead of reading the mailbox tables. */
  list?: (
    db: Db,
    params: { now: Date; within: number },
  ) => Promise<ExpiringMailboxAgentCredential[]>;
}

function mailboxPhrase(locale: MailLocale, addresses: string[]): string {
  const named = addresses.slice(0, NAMED).join(", ");
  const rest = addresses.length - NAMED;
  if (rest <= 0) return named;
  return locale === "pt-BR"
    ? `${named} e mais ${rest} ${rest === 1 ? "caixa" : "caixas"}`
    : `${named} and ${rest} more ${rest === 1 ? "mailbox" : "mailboxes"}`;
}

/**
 * One notice to the person who minted a Correio agent key (single or team
 * credential), about a week before it expires: an agent whose key lapses just
 * stops working, so the owner gets the chance to mint a new one first. The
 * claim is per credential, so each key warns at most once; the mail goes out
 * after the claim (at-most-once, like the rest of the sweep).
 */
export async function warnExpiringMailboxAgentKeys(
  db: Db,
  deps: MailboxAgentKeyExpiryDeps,
): Promise<{ sent: number }> {
  const now = deps.now ?? new Date();
  const credentials = await (deps.list ?? listExpiringMailboxAgentCredentials)(db, {
    now,
    within: MAILBOX_AGENT_KEY_WARN_MS,
  });
  let sent = 0;
  for (const credential of credentials) {
    if (
      !(await claimNotification(db, {
        teamId: credential.teamId,
        kind: KIND,
        periodKey: credential.credentialId,
      }))
    )
      continue;
    try {
      const locale = await accountLocale(db, accountEmailFrom(), credential.email);
      await deps.mailer.send(credential.email, {
        ...buildAccountMail({
          kind: KIND,
          locale,
          url: `${deps.appBaseUrl ?? ""}/mail/settings#agents`,
          values: {
            label: credential.label,
            mailbox: mailboxPhrase(locale, credential.addresses),
            date: formatMailDate(locale, credential.expiresAt),
          },
        }),
        kind: KIND,
      });
      sent += 1;
    } catch (err) {
      console.error(`notifications.sweep: ${KIND} for team ${credential.teamId} failed`, err);
    }
  }
  return { sent };
}
