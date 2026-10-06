"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailboxes.module.css";

const bytes = (value: number, locale: string) => {
  const unit =
    value >= 1024 ** 3 ? "GiB" : value >= 1024 ** 2 ? "MiB" : value >= 1024 ? "KiB" : "B";
  const divisor =
    unit === "GiB" ? 1024 ** 3 : unit === "MiB" ? 1024 ** 2 : unit === "KiB" ? 1024 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / divisor)} ${unit}`;
};
export function MailboxUsagePanel({ mailboxId }: { mailboxId: string | null }) {
  const t = useTranslations("mailboxes.usage");
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(
    trpc.mailboxes.usage.queryOptions({ mailboxId }, { retry: false, refetchInterval: 30000 }),
  );
  const rows = query.data?.mailboxes ?? [];
  const used = rows.reduce((sum, row) => sum + row.storageUsedBytes, 0);
  const limit = rows.reduce((sum, row) => sum + row.storageLimitBytes, 0);
  const sent = rows.reduce((sum, row) => sum + row.outboundUsedRecipients, 0);
  const unlimited = rows.some((row) => row.outboundLimitRecipients === null);
  const sendLimit = rows.reduce((sum, row) => sum + (row.outboundLimitRecipients ?? 0), 0);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  return (
    <section className={styles.usagePanel} aria-label={t("title")}>
      <h3>{t("title")}</h3>
      {!mailboxId ? <small>{t("allBoxes")}</small> : null}
      {query.isError ? (
        <button className="ms-btn ms-btn-ghost" type="button" onClick={() => void query.refetch()}>
          {t("retry")}
        </button>
      ) : query.isPending ? (
        <p aria-live="polite">{t("loading")}</p>
      ) : rows.length ? (
        <>
          <div className={styles.usageMetric}>
            <span>{t("storage")}</span>
            <strong>
              {t("ratio", { used: bytes(used, locale), total: bytes(limit, locale) })}
            </strong>
          </div>
          {limit > 0 ? (
            <progress aria-label={t("storage")} max={limit} value={Math.min(used, limit)} />
          ) : (
            <p>{t("noPolicy")}</p>
          )}
          <div className={styles.usageMetric}>
            <span>{t("outbound")}</span>
            <strong>
              {unlimited
                ? number(sent)
                : t("ratio", { used: number(sent), total: number(sendLimit) })}
            </strong>
          </div>
          {unlimited ? (
            <span className={styles.unlimitedUsage}>∞ {t("unlimited")}</span>
          ) : sendLimit > 0 ? (
            <progress
              aria-label={t("outbound")}
              max={sendLimit}
              value={Math.min(sent, sendLimit)}
            />
          ) : (
            <p>{t("noPolicy")}</p>
          )}
          <p>{t(unlimited ? "internalHelp" : "outboundHelp")}</p>
          {rows[0]?.periodEnd ? (
            <small>
              {t("renews", {
                date: new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(
                  rows[0].periodEnd,
                ),
              })}
            </small>
          ) : null}
        </>
      ) : (
        <p>{t("empty")}</p>
      )}
    </section>
  );
}
