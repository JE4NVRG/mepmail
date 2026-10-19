"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { externalOAuthWorks } from "@/lib/desktop-bridge";
import { mailboxOAuthLoginHint } from "@/lib/mailbox-oauth-hint";
import {
  MAILBOX_EXTERNAL_PRESETS,
  type MailboxExternalPresetId,
  mailboxExternalPresetFor,
} from "../../../../../../packages/core/src/mailbox-external-providers";
import styles from "./mailbox-connect-account.module.css";
import shell from "./mailboxes.module.css";

export interface MailboxConnectAccountInput {
  provider: MailboxExternalPresetId;
  address: string;
  password: string;
  label: string;
  username?: string;
  imapHost?: string;
  smtpHost?: string;
  smtpPort?: 465 | 587;
}

export type MailboxConnectAccountError =
  | "provider_unavailable"
  | "invalid_server"
  | "imap_login"
  | "imap_network"
  | "smtp_login"
  | "smtp_network"
  | "conflict"
  | "limit"
  | "forbidden"
  | "generic"
  // From the Microsoft/Google sign-in, when it comes back to the Correio with an error.
  | "cancelled"
  | "expired"
  | "unavailable"
  | "oauth_failed"
  | "oauth_incomplete"
  | "other_account"
  | "smtp_login_microsoft"
  | "imap_login_microsoft";

export type MailboxConnectOAuth = { microsoft: boolean; google: boolean };

/** The sign-in that connects an account without an app password (server route). */
export function mailboxConnectOAuthHref(
  provider: "microsoft" | "google",
  options: { returnTo?: "/mail" | "/onboarding"; hint?: string } = {},
) {
  const params = new URLSearchParams({ return: options.returnTo ?? "/mail" });
  const hint = mailboxOAuthLoginHint(provider, options.hint);
  if (hint) params.set("hint", hint);
  return `/api/mailboxes/external/oauth/${provider}/start?${params}`;
}

function MicrosoftMark() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 21 21">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 48 48">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

/** The provider's mark on its sign-in button (brand colours, as each provider asks). */
export function MailboxOAuthMark({ provider }: { provider: "microsoft" | "google" }) {
  return provider === "microsoft" ? <MicrosoftMark /> : <GoogleMark />;
}

const ORDER: MailboxExternalPresetId[] = ["gmail", "icloud", "yahoo", "zoho", "outlook", "imap"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "Conectar outra conta" (specs/correio-external-accounts.md): the address picks the
 * provider, the provider says how to create an app password, and the server tests IMAP
 * and SMTP with it before anything is saved. `connect` does the server call and answers
 * the error to show, or null when the account is connected.
 */
export function MailboxConnectAccountDialog({
  close,
  connect,
  oauth,
  returnTo = "/mail",
  initialError = null,
}: {
  close: () => void;
  connect: (input: MailboxConnectAccountInput) => Promise<MailboxConnectAccountError | null>;
  /** Which "Entrar com…" sign-ins the server offers (none: app passwords only). */
  oauth?: MailboxConnectOAuth | undefined;
  /** Where the sign-in comes back to (onboarding reuses this dialog). */
  returnTo?: "/mail" | "/onboarding";
  /** A sign-in that came back with an error opens the dialog showing it. */
  initialError?: MailboxConnectAccountError | null;
}) {
  const t = useTranslations("mailboxes-external");
  const common = useTranslations("mailboxes");
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState("");
  const [provider, setProvider] = useState<MailboxExternalPresetId>("gmail");
  const [chosen, setChosen] = useState(false);
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [username, setUsername] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState<465 | 587>(465);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MailboxConnectAccountError | null>(initialError);
  // An older desktop app would end the sign-in in another browser: offer it there.
  const [oauthHere, setOauthHere] = useState(true);
  useEffect(() => setOauthHere(externalOAuthWorks()), []);
  const offered = oauthHere ? oauth : undefined;
  const oauthElsewhere = !oauthHere && (oauth?.microsoft || oauth?.google);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // The address picks the provider until the person picks one themselves.
  useEffect(() => {
    if (!chosen && EMAIL.test(address.trim())) setProvider(mailboxExternalPresetFor(address));
  }, [address, chosen]);

  const preset = MAILBOX_EXTERNAL_PRESETS[provider];
  const custom = provider === "imap";
  const ready =
    EMAIL.test(address.trim()) &&
    password.trim().length > 0 &&
    preset.available &&
    (!custom || (imapHost.trim() && smtpHost.trim()));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const trimmed = address.trim().toLowerCase();
    const failure = await connect({
      provider,
      address: trimmed,
      // App passwords are often shown in groups ("abcd efgh ijkl mnop"): spaces are not part of them.
      password: password.replace(/\s+/g, ""),
      label: label.trim() || trimmed,
      ...(username.trim() ? { username: username.trim() } : {}),
      ...(custom ? { imapHost: imapHost.trim(), smtpHost: smtpHost.trim(), smtpPort } : {}),
    }).catch(() => "generic" as const);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setPassword("");
    close();
  }

  return (
    <dialog
      ref={dialog}
      className={shell.dialog}
      aria-labelledby={`${id}-title`}
      onClose={close}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <header className={shell.dialogHeader}>
        <h2 id={`${id}-title`}>{t("title")}</h2>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          aria-label={common("close")}
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <p className={styles.hint}>{t("intro")}</p>
        {oauthElsewhere ? <p className={styles.notice}>{t("oauth.updateApp")}</p> : null}
        {offered?.microsoft || offered?.google ? (
          <div className={styles.oauth}>
            {offered.microsoft ? (
              <a
                className={`ms-btn ${styles.oauthButton}`}
                href={mailboxConnectOAuthHref("microsoft", { returnTo, hint: address })}
              >
                <MicrosoftMark />
                {t("oauth.microsoft")}
              </a>
            ) : null}
            {offered.google ? (
              <a
                className={`ms-btn ${styles.oauthButton}`}
                href={mailboxConnectOAuthHref("google", { returnTo, hint: address })}
              >
                <GoogleMark />
                {t("oauth.google")}
              </a>
            ) : null}
            <p className={styles.hint}>{t("oauth.hint")}</p>
            <p className={styles.oauthOr}>
              <span>{t("oauth.or")}</span>
            </p>
          </div>
        ) : null}
        <label className={styles.field}>
          <span>{t("address")}</span>
          <input
            className="ms-input"
            type="email"
            autoComplete="email"
            placeholder={t("addressPlaceholder")}
            value={address}
            maxLength={254}
            disabled={busy}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>

        <fieldset className={styles.providers} disabled={busy}>
          <legend>{t("provider")}</legend>
          {ORDER.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={provider === option}
              onClick={() => {
                setProvider(option);
                setChosen(true);
                setError(null);
              }}
            >
              {t(`providers.${option}`)}
            </button>
          ))}
        </fieldset>

        {!preset.available ? (
          provider === "outlook" && offered?.microsoft ? (
            <div className={styles.steps}>
              <p>{t("oauth.outlook")}</p>
              <a
                className={`ms-btn ${styles.oauthButton}`}
                href={mailboxConnectOAuthHref("microsoft", { returnTo, hint: address })}
              >
                <MicrosoftMark />
                {t("oauth.microsoft")}
              </a>
            </div>
          ) : (
            <p className={styles.notice}>{t("outlookSoon")}</p>
          )
        ) : (
          <>
            <div className={styles.steps}>
              <p>{t(`steps.${provider as Exclude<MailboxExternalPresetId, "outlook">}`)}</p>
              {preset.appPasswordUrl ? (
                <a href={preset.appPasswordUrl} target="_blank" rel="noopener noreferrer">
                  {t("openSecurity")} ↗
                </a>
              ) : null}
            </div>
            <label className={styles.field}>
              <span>{t("password")}</span>
              <input
                className="ms-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={password}
                maxLength={256}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
              <small>{t("passwordHint")}</small>
            </label>
            {custom ? (
              <div className={styles.servers}>
                <label className={styles.field}>
                  <span>{t("imapHost")}</span>
                  <input
                    className="ms-input"
                    placeholder="imap.exemplo.com"
                    value={imapHost}
                    disabled={busy}
                    onChange={(event) => setImapHost(event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t("smtpHost")}</span>
                  <input
                    className="ms-input"
                    placeholder="smtp.exemplo.com"
                    value={smtpHost}
                    disabled={busy}
                    onChange={(event) => setSmtpHost(event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t("smtpPort")}</span>
                  <select
                    className="ms-input"
                    value={smtpPort}
                    disabled={busy}
                    onChange={(event) => setSmtpPort(event.target.value === "587" ? 587 : 465)}
                  >
                    <option value={465}>465 (TLS)</option>
                    <option value={587}>587 (STARTTLS)</option>
                  </select>
                </label>
              </div>
            ) : null}
            <button
              type="button"
              className={`ms-btn ms-btn-ghost ${styles.advancedToggle}`}
              aria-expanded={advanced}
              onClick={() => setAdvanced((value) => !value)}
            >
              {t("advanced")}
            </button>
            {advanced ? (
              <>
                <label className={styles.field}>
                  <span>{t("username")}</span>
                  <input
                    className="ms-input"
                    autoComplete="off"
                    value={username}
                    maxLength={254}
                    disabled={busy}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t("label")}</span>
                  <input
                    className="ms-input"
                    value={label}
                    maxLength={80}
                    disabled={busy}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            <p className={styles.hint}>{t("privacy")}</p>
          </>
        )}

        {busy ? (
          <p className={styles.hint} role="status">
            {t("checking")}
          </p>
        ) : null}
        {error ? (
          <p className={shell.error} role="alert">
            {t(`errors.${error}`)}
          </p>
        ) : null}
        <footer className={shell.dialogFooter}>
          <button type="button" className="ms-btn" disabled={busy} onClick={close}>
            {common("cancel")}
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={!ready || busy}>
            {busy ? t("checking") : t("connect")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
