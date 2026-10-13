"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
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
  | "generic";

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
}: {
  close: () => void;
  connect: (input: MailboxConnectAccountInput) => Promise<MailboxConnectAccountError | null>;
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
  const [error, setError] = useState<MailboxConnectAccountError | null>(null);

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
          <p className={styles.notice}>{t("outlookSoon")}</p>
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
