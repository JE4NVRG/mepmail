"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailbox-connect-account.module.css";

/**
 * Configurações → Caixas, under an external mailbox: how its sync stands, and the three
 * things its owner can do — replace the app password (after "senha recusada") or, for an
 * account connected with the Microsoft or Google sign-in, sign in again; sync now;
 * disconnect (the copies here go; the provider keeps everything).
 */
export function MailboxExternalStatus({
  mailboxId,
  address,
}: {
  mailboxId: string;
  address: string;
}) {
  const t = useTranslations("mailboxes-external.status");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const trpc = useTRPC();
  const queries = useQueryClient();
  const status = useQuery(
    trpc.mailboxExternal.status.queryOptions({ mailboxId }, { refetchInterval: 60_000 }),
  );
  const replace = useMutation(
    trpc.mailboxExternal.replacePassword.mutationOptions({ retry: false }),
  );
  const syncNow = useMutation(trpc.mailboxExternal.syncNow.mutationOptions({ retry: false }));
  const disconnect = useMutation(trpc.mailboxExternal.disconnect.mutationOptions({ retry: false }));
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const data = status.data;
  if (!data) return status.isPending ? <p className={styles.hint}>{t("loading")}</p> : null;
  const oauth =
    data.auth === "oauth_microsoft" ? "microsoft" : data.auth === "oauth_google" ? "google" : null;
  // "Entrar de novo": the same provider's sign-in, back to this account (same address).
  const signInAgain = oauth
    ? `/api/mailboxes/external/oauth/${oauth}/start?${new URLSearchParams({
        mailbox: mailboxId,
        hint: data.username,
        return: "/mail",
      })}`
    : null;

  const state =
    data.status === "auth_failed"
      ? oauth
        ? t(`oauthRefused.${oauth}`)
        : t("authFailed")
      : data.status === "error"
        ? data.lastError === "storage_full"
          ? t("storageFull")
          : t("syncError")
        : data.lastSyncedAt
          ? t("syncedAt", { when: format.relativeTime(new Date(data.lastSyncedAt), now) })
          : t("firstSync");

  return (
    <div className={styles.status}>
      <p className={data.status === "active" ? styles.hint : styles.notice} role="status">
        {state}
      </p>
      {oauth ? <p className={styles.hint}>{t(`oauthConnected.${oauth}`)}</p> : null}
      {signInAgain && data.status === "auth_failed" ? (
        <div className={styles.inline}>
          <a className="ms-btn ms-btn-primary" href={signInAgain}>
            {t(`signInAgain.${oauth}`)}
          </a>
        </div>
      ) : null}
      {!oauth && (replacing || data.status === "auth_failed") ? (
        <form
          className={styles.inline}
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              await replace.mutateAsync({ mailboxId, password: password.replace(/\s+/g, "") });
              setPassword("");
              setReplacing(false);
              toast(t("replaced"), "success");
              await status.refetch();
            } catch (cause) {
              const reason = (cause as { message?: string })?.message ?? "";
              setError(reason);
            }
          }}
        >
          <input
            className="ms-input"
            type="password"
            autoComplete="off"
            aria-label={t("newPassword", { address })}
            placeholder={t("newPassword", { address })}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={!password || replace.isPending}
          >
            {replace.isPending ? t("checking") : t("save")}
          </button>
        </form>
      ) : null}
      {error ? (
        <p className={styles.notice} role="alert">
          {t(
            `errors.${["imap_login", "smtp_login", "imap_network", "smtp_network"].includes(error) ? error : "generic"}`,
          )}
        </p>
      ) : null}
      <div className={styles.inline}>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          disabled={syncNow.isPending || data.status !== "active"}
          onClick={async () => {
            await syncNow.mutateAsync({ mailboxId }).catch(() => undefined);
            toast(t("syncRequested"));
          }}
        >
          {t("syncNow")}
        </button>
        {!oauth && data.status !== "auth_failed" ? (
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            onClick={() => setReplacing((v) => !v)}
          >
            {t("replace")}
          </button>
        ) : null}
        {confirming ? (
          <>
            <span className={styles.hint}>{t("disconnectConfirm", { address })}</span>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              onClick={() => setConfirming(false)}
            >
              {t("keep")}
            </button>
            <button
              type="button"
              className="ms-btn"
              disabled={disconnect.isPending}
              onClick={async () => {
                await disconnect.mutateAsync({ mailboxId });
                toast(t("disconnected", { address }), "success");
                await queries.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() });
              }}
            >
              {t("disconnect")}
            </button>
          </>
        ) : (
          <button type="button" className="ms-btn ms-btn-ghost" onClick={() => setConfirming(true)}>
            {t("disconnect")}
          </button>
        )}
      </div>
    </div>
  );
}
