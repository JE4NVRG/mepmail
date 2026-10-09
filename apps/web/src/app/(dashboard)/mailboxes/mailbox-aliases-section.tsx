"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailboxes.module.css";

/**
 * Extra addresses that deliver into this mailbox (support@ into jean@). Each
 * one starts receiving when the domain's receiving is confirmed again.
 */
export function MailboxAliasesSection({ mailbox }: { mailbox: { id: string; address: string } }) {
  const t = useTranslations("mailboxes.aliases");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const id = useId();
  const domain = mailbox.address.split("@")[1] ?? "";
  const [local, setLocal] = useState("");
  const [notice, setNotice] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const listing = useQuery(trpc.mailboxes.aliases.queryOptions({ mailboxId: mailbox.id }));
  const add = useMutation(trpc.mailboxes.addAlias.mutationOptions());
  const remove = useMutation(trpc.mailboxes.removeAlias.mutationOptions());
  const busy = add.isPending || remove.isPending;

  async function refresh() {
    await queries.invalidateQueries({
      queryKey: trpc.mailboxes.aliases.queryKey({ mailboxId: mailbox.id }),
    });
  }
  function failure(cause: unknown) {
    const code = (cause as { data?: { code?: string } })?.data?.code;
    setNotice({
      tone: "alert",
      text: t(code === "CONFLICT" ? "taken" : code === "BAD_REQUEST" ? "invalid" : "error"),
    });
  }

  return (
    <section className={styles.access} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t("title")}</h3>
      <p className={styles.hint}>{t("hint", { address: mailbox.address })}</p>
      {listing.isError ? (
        <div role="alert">
          <p>{t("loadError")}</p>
          <button type="button" className="ms-btn" onClick={() => void listing.refetch()}>
            {t("retry")}
          </button>
        </div>
      ) : listing.isPending ? (
        <p>{t("loading")}</p>
      ) : listing.data.length ? (
        <ul>
          {listing.data.map((alias) => (
            <li key={alias.id}>
              <span>
                {alias.address}
                <small>{t("delivers", { address: mailbox.address })}</small>
              </span>
              <button
                type="button"
                className="ms-btn ms-btn-ghost"
                disabled={busy}
                aria-label={t("removeLabel", { address: alias.address })}
                onClick={async () => {
                  setNotice(null);
                  try {
                    await remove.mutateAsync({ id: alias.id });
                    await refresh();
                    setNotice({ tone: "status", text: t("removed", { address: alias.address }) });
                  } catch (cause) {
                    failure(cause);
                  }
                }}
              >
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.hint}>{t("empty")}</p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setNotice(null);
          try {
            const created = await add.mutateAsync({ mailboxId: mailbox.id, localPart: local });
            setLocal("");
            await refresh();
            setNotice({
              tone: "status",
              text: t(created.receiving === "confirmed" ? "addedLive" : "addedPending", {
                address: created.address,
              }),
            });
          } catch (cause) {
            failure(cause);
          }
        }}
      >
        <fieldset disabled={busy || !listing.isSuccess} className={styles.fields}>
          <label htmlFor={`${id}-local`}>
            {t("add")}
            <div className={styles.aliasFields}>
              <input
                id={`${id}-local`}
                className="ms-input"
                value={local}
                onChange={(event) => setLocal(event.target.value)}
                placeholder={t("placeholder")}
                autoComplete="off"
                spellCheck={false}
                required
              />
              <span>@{domain}</span>
            </div>
          </label>
          <button type="submit" className="ms-btn" disabled={busy || !local.trim()}>
            {add.isPending ? t("adding") : t("submit")}
          </button>
        </fieldset>
      </form>
      {notice ? (
        <p className={styles.hint} role={notice.tone}>
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
