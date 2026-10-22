"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { Table } from "@/components/table";
import { formatMailboxPrice } from "@/lib/mailbox-setup";
import { useTRPC } from "@/lib/trpc";

function Kpi({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="ms-card" style={{ padding: "16px 20px" }}>
      <div className="ms-microlabel">{label}</div>
      <div className="ms-digits" style={{ fontSize: 26, lineHeight: 1.2, marginTop: 4 }}>
        {value}
      </div>
      {sub ? (
        <div style={{ fontSize: 13, color: "var(--ms-muted)", marginTop: 2 }}>{sub}</div>
      ) : null}
    </div>
  );
}

/** Revenue as mirrored from verified Stripe webhooks; internal licenses are listed, never summed. */
export function RevenueView() {
  const t = useTranslations("console.revenue");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(trpc.console.revenue.summary.queryOptions());
  const d = query.data;
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const day = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }),
    [locale],
  );
  const money = (cents: number, currency: string) => formatMailboxPrice(cents, currency, locale);

  if (query.isError) {
    return (
      <>
        <PageHeader title={t("title")} />
        <div className="ms-card ms-state">
          <p className="ms-state-headline">{common("loadError")}</p>
          <div className="ms-state-actions">
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              onClick={() => query.refetch()}
            >
              {common("retry")}
            </button>
          </div>
        </div>
      </>
    );
  }

  const mrr = d?.mrr.length
    ? d.mrr.map((m) => money(m.cents, m.currency)).join(" + ")
    : d
      ? money(0, "usd")
      : null;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("proof")} />
      <div className="ms-grid ms-grid-4" style={{ marginBottom: 16 }}>
        {d ? (
          <>
            <Kpi label={t("kpi.mrr")} value={mrr} sub={t("kpi.mrrSub")} />
            <Kpi
              label={t("kpi.paying")}
              value={nf.format(d.paying.send + d.paying.mail)}
              sub={t("kpi.payingSub", { send: d.paying.send, mail: d.paying.mail })}
            />
            <Kpi
              label={t("kpi.next30")}
              value={nf.format(d.renewals30d)}
              sub={t("kpi.next30Sub", {
                cancels: d.cancellations30d,
                pastDue: d.pastDue,
              })}
            />
            <Kpi
              label={t("kpi.internal")}
              value={nf.format(d.internal)}
              sub={t("kpi.internalSub", { ended: d.ended })}
            />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => (
            <Skeleton key={i} width="100%" height={104} radius="var(--ms-r-card)" />
          ))
        )}
      </div>

      <div className="ms-card" style={{ padding: 0 }}>
        {!d ? (
          <div style={{ padding: 20 }}>
            <Skeleton width="100%" height={160} />
          </div>
        ) : d.rows.length === 0 ? (
          <p style={{ margin: 0, padding: 20, color: "var(--ms-muted)" }}>{t("empty")}</p>
        ) : (
          <Table className="nowrap">
            <thead>
              <tr>
                <th>{t("columns.team")}</th>
                <th>{t("columns.product")}</th>
                <th>{t("columns.status")}</th>
                <th className="right">{t("columns.monthly")}</th>
                <th>{t("columns.renews")}</th>
                <th>{t("columns.links")}</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => {
                const tone = r.paying
                  ? r.status === "past_due"
                    ? "warn"
                    : "success"
                  : r.source === "internal"
                    ? "info"
                    : "neutral";
                const status = r.paying
                  ? t(`status.${r.status === "past_due" ? "pastDue" : "paying"}`)
                  : r.source === "internal"
                    ? t("status.internal")
                    : t("status.ended");
                return (
                  <tr key={`${r.teamId}-${r.product}`}>
                    <td>
                      <Link
                        href={`/console/teams?status=all&q=${encodeURIComponent(r.team)}`}
                        style={{ color: "inherit" }}
                      >
                        {r.team}
                      </Link>
                      {r.suspended ? (
                        <span className="ms-badge ms-badge-danger" style={{ marginLeft: 8 }}>
                          {t("suspended")}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {t(`product.${r.product}`)}
                      {r.plan && r.plan !== "free" ? (
                        <span style={{ color: "var(--ms-muted)" }}> · {r.plan}</span>
                      ) : null}
                      {r.seats ? (
                        <span style={{ color: "var(--ms-muted)" }}>
                          {" "}
                          · {t("seats", { count: r.seats })}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className={`ms-badge ms-badge-${tone}`} title={r.status}>
                        {status}
                      </span>
                    </td>
                    <td className="right num">
                      {r.monthlyCents && r.currency ? (
                        money(r.monthlyCents, r.currency)
                      ) : (
                        <span style={{ color: "var(--ms-muted)" }}>{common("none")}</span>
                      )}
                    </td>
                    <td style={{ color: "var(--ms-muted)" }}>
                      {r.cancelAt
                        ? t("cancelsOn", { date: day.format(new Date(r.cancelAt)) })
                        : r.periodEnd
                          ? day.format(new Date(r.periodEnd))
                          : common("none")}
                    </td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <Link
                        className="ms-chip"
                        style={{ textDecoration: "none", fontSize: 12 }}
                        href={`/console/audit?team=${r.teamId}`}
                      >
                        {t("audit")}
                      </Link>
                      <Link
                        className="ms-chip"
                        style={{ textDecoration: "none", fontSize: 12 }}
                        href={`/console/safety/${r.teamId}`}
                      >
                        {t("review")}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
