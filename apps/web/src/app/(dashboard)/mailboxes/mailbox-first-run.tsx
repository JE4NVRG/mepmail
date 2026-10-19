"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { externalOAuthWorks } from "@/lib/desktop-bridge";
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
  // An older desktop app would end the sign-in in another browser: not offered there.
  const [oauthHere, setOauthHere] = useState(true);
  useEffect(() => setOauthHere(externalOAuthWorks()), []);
  const offered = oauthHere ? oauth : undefined;
  return (
    <section className={styles.welcome} aria-labelledby="mailbox-first-run-title">
      <h2 id="mailbox-first-run-title">{t("title")}</h2>
      {/* Outlook and Hotmail are named only where "Entrar com a Microsoft" is offered. */}
      <p>{t(offered?.microsoft ? "body" : "bodyNoMicrosoft")}</p>
      <div className={styles.welcomeActions}>
        {offered?.microsoft ? (
          <a className={`ms-btn ${styles.oauthButton}`} href={mailboxConnectOAuthHref("microsoft")}>
            <MailboxOAuthMark provider="microsoft" />
            {external("oauth.microsoft")}
          </a>
        ) : null}
        {offered?.google ? (
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
