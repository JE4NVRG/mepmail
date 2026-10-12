"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useTRPC } from "@/lib/trpc";
import own from "./mailbox-clients.module.css";
import styles from "./mailboxes.module.css";

/**
 * "Usar em outro app de e-mail": the mailbox owner's app passwords and what to type into
 * Outlook, Apple Mail, Thunderbird or the Gmail app (IMAP to read, SMTP to send). A new
 * password is shown once, to copy into the mail app; the list shows each one's name,
 * last use and the last four letters, with Revogar.
 */
export function MailboxClientsDialog({
  mailbox,
  close,
}: {
  mailbox: { id: string; address: string };
  close: () => void;
}) {
  const t = useTranslations("mailboxes-clients");
  const locale = useLocale();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<{ label: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState("");
  const settings = useQuery(trpc.mailboxClients.settings.queryOptions());
  const passwords = useQuery(
    trpc.mailboxClients.appPasswords.queryOptions(
      { mailboxId: mailbox.id },
      { enabled: !!settings.data?.open },
    ),
  );
  const create = useMutation(trpc.mailboxClients.createAppPassword.mutationOptions());
  const revoke = useMutation(trpc.mailboxClients.revokeAppPassword.mutationOptions());
  const busy = create.isPending || revoke.isPending;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const date = (value: Date | string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));
  const refresh = () =>
    queries.invalidateQueries({
      queryKey: trpc.mailboxClients.appPasswords.queryKey({ mailboxId: mailbox.id }),
    });
  const failed = (cause: unknown) => {
    const message = (cause as { message?: string })?.message;
    const code = (cause as { data?: { code?: string } })?.data?.code;
    setError(
      t(
        message === "quota"
          ? "errors.quota"
          : message === "invalid"
            ? "errors.agent"
            : code === "FORBIDDEN"
              ? "errors.owner"
              : "errors.generic",
        { limit: settings.data?.limit ?? 10 },
      ),
    );
  };
  const s = settings.data;
  const list = passwords.data ?? [];

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="mailbox-clients-title"
      onClose={close}
    >
      <header className={styles.dialogHeader}>
        <h2 id="mailbox-clients-title">{t("title")}</h2>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          aria-label={t("close")}
          onClick={close}
        >
          ×
        </button>
      </header>
      {!s ? (
        <p className={styles.hint}>{t("loading")}</p>
      ) : !s.open ? (
        <p className={styles.hint}>{t("soon")}</p>
      ) : (
        <>
          <p className={own.intro}>{t("intro", { address: mailbox.address })}</p>
          <table className={own.settings}>
            <tbody>
              <tr>
                <th scope="row">{t("settings.imap")}</th>
                <td>
                  <code>{s.imap.host}</code> · {t("settings.port", { port: s.imap.port })} · SSL/TLS
                </td>
              </tr>
              <tr>
                <th scope="row">{t("settings.smtp")}</th>
                <td>
                  <code>{s.smtp.host}</code> · {t("settings.port", { port: s.smtp.port })} · SSL/TLS
                  <span className={own.alt}>
                    {t("settings.alternate", { port: s.smtp.alternatePort })}
                  </span>
                </td>
              </tr>
              <tr>
                <th scope="row">{t("settings.user")}</th>
                <td>
                  <code>{mailbox.address}</code>
                </td>
              </tr>
              <tr>
                <th scope="row">{t("settings.password")}</th>
                <td>{t("settings.passwordValue")}</td>
              </tr>
            </tbody>
          </table>
          <p className={styles.hint}>{t("gmail")}</p>

          {made ? (
            <section className={own.made} aria-live="polite">
              <h3>{t("made.title", { label: made.label })}</h3>
              <p className={own.password}>
                <code>{made.password}</code>
                <button
                  type="button"
                  className="ms-btn ms-btn-sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(made.password);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  {t(copied ? "made.copied" : "made.copy")}
                </button>
              </p>
              <p className={styles.hint}>{t("made.once")}</p>
            </section>
          ) : null}

          <form
            className={own.create}
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              try {
                const result = await create.mutateAsync({
                  mailboxId: mailbox.id,
                  label: label.trim(),
                });
                setMade({ label: result.label, password: result.password });
                setCopied(false);
                setLabel("");
                await refresh();
              } catch (cause) {
                failed(cause);
              }
            }}
          >
            <label>
              {t("create.label")}
              <input
                className="ms-input"
                required
                maxLength={80}
                value={label}
                placeholder={t("create.placeholder")}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={busy || !label.trim() || list.length >= s.limit}
            >
              {t(create.isPending ? "create.creating" : "create.submit")}
            </button>
          </form>
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}

          <section className={own.list} aria-label={t("list.title")}>
            <h3>{t("list.title")}</h3>
            {passwords.isPending ? (
              <p className={styles.hint}>{t("loading")}</p>
            ) : !list.length ? (
              <p className={styles.hint}>{t("list.empty")}</p>
            ) : (
              <ul>
                {list.map((item) => (
                  <li key={item.id}>
                    <span>
                      <strong>{item.label}</strong>
                      <small>
                        {t("list.meta", {
                          created: date(item.createdAt),
                          hint: item.hint,
                        })}{" "}
                        ·{" "}
                        {item.lastUsedAt
                          ? t("list.used", { date: date(item.lastUsedAt) })
                          : t("list.unused")}
                      </small>
                    </span>
                    {confirming === item.id ? (
                      <span className={own.confirm}>
                        <span>{t("list.confirm")}</span>
                        <button
                          type="button"
                          className="ms-btn ms-btn-sm"
                          disabled={busy}
                          onClick={() => setConfirming(null)}
                        >
                          {t("list.keep")}
                        </button>
                        <button
                          type="button"
                          className={own.revoke}
                          disabled={busy}
                          onClick={async () => {
                            setError("");
                            try {
                              await revoke.mutateAsync({ mailboxId: mailbox.id, id: item.id });
                              setConfirming(null);
                              await refresh();
                            } catch (cause) {
                              failed(cause);
                            }
                          }}
                        >
                          {t("list.revoke")}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="ms-btn ms-btn-ghost ms-btn-sm"
                        disabled={busy}
                        onClick={() => setConfirming(item.id)}
                      >
                        {t("list.revoke")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </dialog>
  );
}
