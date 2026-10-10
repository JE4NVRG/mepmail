"use client";

import { useTranslations } from "next-intl";
import styles from "./mailbox-senders.module.css";

/**
 * Aprovação de remetentes: above a message from someone this mailbox has no
 * answer for yet (and never written to). Aprovar keeps the sender and hides
 * the bar for good; Bloquear sends this message, and the sender's next ones,
 * to Spam.
 */
export function MailboxSenderBar({
  sender,
  busy,
  onAllow,
  onBlock,
}: {
  sender: string;
  busy: boolean;
  onAllow: () => void;
  onBlock: () => void;
}) {
  const t = useTranslations("mailboxes.senders");
  return (
    <section className={styles.bar} aria-label={t("barLabel")}>
      <p>
        <strong>{t("newSender")}</strong> <span>{t("newSenderBody", { sender })}</span>
      </p>
      <div className={styles.barActions}>
        <button type="button" className="ms-btn ms-btn-primary" disabled={busy} onClick={onAllow}>
          {t("allow")}
        </button>
        <button type="button" className="ms-btn ms-btn-ghost" disabled={busy} onClick={onBlock}>
          {t("block")}
        </button>
      </div>
    </section>
  );
}

/**
 * Preferências: the answers kept for one mailbox, newest first, each one
 * removable (the sender goes back to unanswered).
 */
export function MailboxSenderList({
  entries,
  loading,
  busyAddress,
  onClear,
}: {
  entries: { address: string; decision: "allow" | "block" }[];
  loading: boolean;
  busyAddress: string | null;
  onClear: (address: string) => void;
}) {
  const t = useTranslations("mailboxes.senders");
  if (loading) return <p className={styles.listHint}>{t("loading")}</p>;
  if (!entries.length) return <p className={styles.listHint}>{t("empty")}</p>;
  return (
    <ul className={styles.list}>
      {entries.map((entry) => (
        <li key={entry.address}>
          <span className={styles.address}>{entry.address}</span>
          <span className={styles.decision} data-decision={entry.decision}>
            {t(entry.decision === "block" ? "blocked" : "allowed")}
          </span>
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            disabled={busyAddress === entry.address}
            aria-label={t("clear", { address: entry.address })}
            title={t("clear", { address: entry.address })}
            onClick={() => onClear(entry.address)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
