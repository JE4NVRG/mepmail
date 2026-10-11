"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { BtnSpinner } from "@/components/spinner";
import { CLOUDFLARE_TOKEN, CLOUDFLARE_TOKEN_URL } from "@/lib/cloudflare";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import styles from "./cloudflare-setup.module.css";

type Outcome = "created" | "updated" | "unchanged" | "conflict" | "failed";

/**
 * "Configurar na Cloudflare": the person creates a DNS-only token from a
 * pre-filled Cloudflare link, pastes it, and the server writes this domain's
 * records. The token lives in this input until submit and is cleared right
 * after; the server never stores it. `records="receiving"` writes only the
 * Correio MX, and only where the name has no MX yet.
 */
export function CloudflareSetup({
  id,
  domainName,
  records = "sending",
  onOpen,
  onConfigured,
}: {
  id: string;
  domainName: string;
  /** The sending records (default) or the receiving MX of a Correio domain. */
  records?: "sending" | "receiving";
  /** Called when the person opens the token form. */
  onOpen?: () => void;
  /** Called after records were written and the server ran a DNS check. */
  onConfigured?: () => void;
}) {
  const t = useTranslations("domains.cloudflare");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const setup = useMutation(
    trpc.domains.cloudflareSetup.mutationOptions({
      onSuccess: (data) => {
        if (!data.ok) return;
        void queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id }) });
        void queryClient.invalidateQueries({ queryKey: trpc.domains.records.queryKey({ id }) });
        void queryClient.invalidateQueries({ queryKey: trpc.domains.list.queryKey() });
        onConfigured?.();
      },
    }),
  );
  const trimmed = token.trim();
  const valid = CLOUDFLARE_TOKEN.test(trimmed);
  const receiving = records === "receiving";
  // The receiving card says what it writes in its own words; the rest is shared.
  const text = (key: "title" | "body" | "submit" | "submitting" | "doneBody" | "conflictHelp") =>
    receiving ? t(`receiving.${key}`) : t(key);
  const result = setup.data;
  const errorKey = setup.error
    ? trpcErrorCode(setup.error) === "TOO_MANY_REQUESTS"
      ? "errors.rate"
      : "errors.unexpected"
    : result && !result.ok
      ? (`errors.${result.reason}` as const)
      : null;
  const conflicts = result?.ok
    ? result.records.filter(
        (record) => record.outcome === "conflict" || record.outcome === "failed",
      ).length
    : 0;

  const submit = () => {
    if (!valid || setup.isPending) return;
    setup.mutate({ id, token: trimmed, records });
    // The token is not needed after this request: drop it from the page.
    setToken("");
  };

  return (
    <section className={styles.card} aria-labelledby={`${inputId}-title`}>
      <div className={styles.head}>
        <span className={styles.logo} aria-hidden="true">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 18h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.4 9.1 4.5 4.5 0 0 0 7 18Z" />
            <path d="m9.5 13.5 2 2 3.5-3.5" />
          </svg>
        </span>
        <div className={styles.headText}>
          <h3 id={`${inputId}-title`}>{text("title")}</h3>
          <p>{text("body")}</p>
        </div>
        {!open && !result?.ok ? (
          <button
            type="button"
            className={`ms-btn ms-btn-primary ${styles.openButton}`}
            onClick={() => {
              setOpen(true);
              onOpen?.();
            }}
          >
            {t("open")}
          </button>
        ) : null}
      </div>

      {/* A div, not a form: the card also sits inside the new-mailbox dialog's
          form, and a nested form would submit that one instead. */}
      {open && !result?.ok ? (
        <div className={styles.form}>
          <ol className={styles.steps}>
            <li>
              <span className={styles.stepTitle}>{t("step1")}</span>
              <span className={styles.hint}>{t("step1Hint", { domain: domainName })}</span>
              <a
                className="ms-btn ms-btn-secondary"
                href={CLOUDFLARE_TOKEN_URL}
                target="_blank"
                rel="noreferrer"
              >
                {t("createToken")} ↗
              </a>
            </li>
            <li>
              <label className={styles.stepTitle} htmlFor={inputId}>
                {t("step2")}
              </label>
              <div className={styles.tokenRow}>
                <input
                  id={inputId}
                  className="ms-input mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("tokenPlaceholder")}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    submit();
                  }}
                  aria-invalid={trimmed !== "" && !valid}
                />
                <button
                  type="button"
                  className="ms-btn ms-btn-primary"
                  disabled={!valid || setup.isPending}
                  onClick={submit}
                >
                  <BtnSpinner on={setup.isPending} />
                  {setup.isPending ? text("submitting") : text("submit")}
                </button>
              </div>
              {trimmed !== "" && !valid ? (
                <span className={styles.error}>{t("errors.invalid")}</span>
              ) : null}
            </li>
          </ol>
          <p className={styles.privacy}>{t("privacy")}</p>
          {errorKey ? (
            <p className={styles.error} role="alert">
              {t(errorKey, { domain: domainName })}
            </p>
          ) : null}
          <button type="button" className={styles.cancel} onClick={() => setOpen(false)}>
            {t("cancel")}
          </button>
        </div>
      ) : null}

      {result?.ok ? (
        <div className={styles.done} role="status">
          <p className={styles.doneTitle}>{t("doneTitle", { zone: result.zone })}</p>
          <ul className={styles.results}>
            {result.records.map((record) => (
              <li key={`${record.type}-${record.name}`}>
                <span className={styles.recordType}>{record.type}</span>
                <span className={styles.recordName}>{record.name}</span>
                <span className={styles.outcome} data-outcome={record.outcome}>
                  {t(`outcome.${record.outcome as Outcome}`)}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.hint}>{conflicts > 0 ? text("conflictHelp") : text("doneBody")}</p>
        </div>
      ) : null}
    </section>
  );
}
