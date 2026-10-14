"use client";

import { useTranslations } from "next-intl";
import styles from "./mailbox-connect-account.module.css";
import {
  type MailboxConnectOAuth,
  MailboxOAuthMark,
  mailboxConnectOAuthHref,
} from "./mailbox-connect-account-dialog";

/**
 * The Correio's first run, before any mailbox: start from the address the person already
 * has (free, no DNS) — Microsoft or Google sign-in when the server offers it, any other
 * provider with an app password — and only then, if they want, a mailbox on their own
 * domain. Onboarding links here and reuses the same dialog.
 */
export function MailboxFirstRun({
  oauth,
  connect,
  create,
}: {
  oauth?: MailboxConnectOAuth | undefined;
  /** Opens "Conectar uma conta de e-mail" (app passwords, any provider). */
  connect: () => void;
  /** Opens "Criar caixa" on a team domain, for those who manage the team. */
  create?: (() => void) | undefined;
}) {
  const t = useTranslations("mailboxes-external.welcome");
  const external = useTranslations("mailboxes-external");
  return (
    <section className={styles.welcome} aria-labelledby="mailbox-first-run-title">
      <h2 id="mailbox-first-run-title">{t("title")}</h2>
      <p>{t("body")}</p>
      <div className={styles.welcomeActions}>
        {oauth?.microsoft ? (
          <a className={`ms-btn ${styles.oauthButton}`} href={mailboxConnectOAuthHref("microsoft")}>
            <MailboxOAuthMark provider="microsoft" />
            {external("oauth.microsoft")}
          </a>
        ) : null}
        {oauth?.google ? (
          <a className={`ms-btn ${styles.oauthButton}`} href={mailboxConnectOAuthHref("google")}>
            <MailboxOAuthMark provider="google" />
            {external("oauth.google")}
          </a>
        ) : null}
        <button type="button" className={`ms-btn ${styles.oauthButton}`} onClick={connect}>
          {t("appPassword")}
        </button>
      </div>
      <ul className={styles.welcomePoints}>
        <li>{t("pointFree")}</li>
        <li>{t("pointPrivate")}</li>
        <li>{t("pointProvider")}</li>
      </ul>
      {create ? (
        <p className={styles.welcomeDomain}>
          {t("domain")}{" "}
          <button type="button" className="ms-btn ms-btn-ghost ms-btn-sm" onClick={create}>
            {t("createDomain")}
          </button>
        </p>
      ) : null}
    </section>
  );
}
