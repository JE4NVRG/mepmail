"use client";

import { useTranslations } from "next-intl";
import { type PileCounts, SMART_PILES, type SmartPile } from "@/lib/mailbox-smart-inbox";
import styles from "./mailbox-smart-tabs.module.css";

/**
 * Caixa inteligente: Pessoas · Notificações · Newsletters · Tudo above the
 * Inbox list. Each pile shows its unread count on the pages loaded so far.
 */
export function MailboxSmartTabs({
  value,
  counts,
  onChange,
}: {
  value: SmartPile;
  counts: PileCounts;
  onChange: (pile: SmartPile) => void;
}) {
  const t = useTranslations("mailboxes.smart");
  return (
    <fieldset aria-label={t("label")} className={styles.tabs}>
      {SMART_PILES.map((pile) => {
        const unread = pile === "all" ? 0 : counts[pile].unread;
        return (
          <button
            key={pile}
            type="button"
            className={styles.tab}
            aria-pressed={value === pile}
            aria-label={unread ? `${t(pile)}, ${t("unread", { count: unread })}` : t(pile)}
            onClick={() => onChange(pile)}
          >
            <span>{t(pile)}</span>
            {unread ? (
              <span className={styles.count} aria-hidden="true">
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </button>
        );
      })}
    </fieldset>
  );
}
