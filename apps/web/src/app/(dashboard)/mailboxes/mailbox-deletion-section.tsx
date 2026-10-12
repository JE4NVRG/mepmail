"use client";

import { useMutation } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailboxes.module.css";

/** Long date of a deletion deadline, in the page's language. */
export function deletionDate(value: Date | string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(value));
}

/**
 * Excluir caixa, at the foot of the mailbox's registry dialog (team admins only). Deleting
 * asks for the address typed out and says what happens: mail stops now, the seat frees,
 * and 30 days later everything is erased. A mailbox being deleted shows its date and
 * "Restaurar caixa" instead.
 */
export function MailboxDeletionSection({
  mailbox,
  changed,
  close,
}: {
  mailbox: { id: string; address: string; deleteAfter: Date | string | null };
  changed: (id: string) => Promise<void>;
  close: () => void;
}) {
  const t = useTranslations("mailboxes.deletion");
  const locale = useLocale();
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const remove = useMutation(trpc.mailboxes.requestDelete.mutationOptions());
  const restore = useMutation(trpc.mailboxes.restoreDelete.mutationOptions());
  const busy = remove.isPending || restore.isPending;
  const matches = typed.trim().toLowerCase() === mailbox.address;

  if (mailbox.deleteAfter) {
    const date = deletionDate(mailbox.deleteAfter, locale);
    return (
      <section className={styles.deletion}>
        <h3>{t("pendingTitle")}</h3>
        <p>{t("pending", { date })}</p>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={busy}
          onClick={async () => {
            setError("");
            try {
              await restore.mutateAsync({ id: mailbox.id });
              await changed(mailbox.id);
              toast(t("restored"));
              close();
            } catch (cause) {
              const message = (cause as { message?: string })?.message;
              const code = (cause as { data?: { code?: string } })?.data?.code;
              setError(
                t(message === "quota" ? "quota" : code === "CONFLICT" ? "expired" : "error"),
              );
            }
          }}
        >
          {t(restore.isPending ? "restoring" : "restore")}
        </button>
      </section>
    );
  }

  return (
    <section className={styles.deletion}>
      {open ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!matches) {
              setError(t("mismatch"));
              return;
            }
            setError("");
            try {
              const result = await remove.mutateAsync({ id: mailbox.id, address: typed });
              await changed(mailbox.id);
              toast(t("requested", { date: deletionDate(result.deleteAfter, locale) }));
              close();
            } catch (cause) {
              const code = (cause as { data?: { code?: string } })?.data?.code;
              setError(t(code === "BAD_REQUEST" ? "mismatch" : "error"));
            }
          }}
        >
          <h3>{t("title")}</h3>
          <p>{t("explain", { address: mailbox.address })}</p>
          <p>{t("grace")}</p>
          <p className={styles.hint}>{t("seats")}</p>
          <fieldset disabled={busy} className={styles.fields}>
            <label>
              {t("confirmLabel", { address: mailbox.address })}
              <input
                className="ms-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                placeholder={mailbox.address}
              />
            </label>
          </fieldset>
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          <div className={styles.deletionActions}>
            <button
              type="button"
              className="ms-btn"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setTyped("");
                setError("");
              }}
            >
              {t("cancel")}
            </button>
            <button type="submit" className={styles.deleteButton} disabled={busy || !matches}>
              {t(remove.isPending ? "deleting" : "confirm")}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className={styles.deleteLink} onClick={() => setOpen(true)}>
          {t("open")}
        </button>
      )}
    </section>
  );
}
