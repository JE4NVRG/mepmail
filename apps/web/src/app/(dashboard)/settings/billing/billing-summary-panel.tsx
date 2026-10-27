"use client";

import { useTranslations } from "next-intl";
import { type CSSProperties, type ReactNode, useId } from "react";
import type { BillingSummary } from "@/lib/billing-summary";

const labelStyle: CSSProperties = {
  margin: 0,
  color: "var(--ms-muted)",
  fontSize: "var(--ms-fs-ui)",
};
const valueStyle: CSSProperties = {
  margin: "6px 0 0",
  color: "var(--ms-bone)",
  fontSize: "var(--ms-fs-ui)",
  lineHeight: 1.6,
  overflowWrap: "anywhere",
};

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt style={labelStyle}>{label}</dt>
      <dd style={valueStyle}>{children}</dd>
    </div>
  );
}

/** Read-only server projection. No billing amounts or benefit eligibility are inferred here. */
export function BillingSummaryPanel({
  summary,
  locale,
  onRetry,
}: {
  summary: BillingSummary;
  locale: string;
  onRetry?: () => void;
}) {
  const t = useTranslations("settings.billing.summary");
  const titleId = useId();
  // Pin calendar dates to UTC so SSR and hydration never disagree at midnight.
  let safeLocale = locale;
  try {
    new Intl.DateTimeFormat(safeLocale);
  } catch {
    safeLocale = "en";
  }
  const dateFormatter = new Intl.DateTimeFormat(safeLocale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  const date = (iso: string | null) => {
    if (!iso || !Number.isFinite(new Date(iso).getTime())) return t("dateUnavailable");
    return <time dateTime={iso}>{dateFormatter.format(new Date(iso))}</time>;
  };
  const period = (start: string | null, end: string | null) => (
    <span style={{ display: "grid", gap: 2 }}>
      <span>
        {t("starts")} {date(start)}
      </span>
      <span>
        {t("ends")} {date(end)}
      </span>
    </span>
  );
  const invoice = summary.nextInvoice;
  const money = (cents: number) =>
    new Intl.NumberFormat(safeLocale, {
      style: "currency",
      currency: invoice?.currency.toUpperCase() ?? "USD",
    }).format(cents / 100);

  if (summary.state === "not_applicable") return null;

  return (
    <section
      className="ms-card"
      aria-labelledby={titleId}
      style={{ padding: 24, minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2
        id={titleId}
        className="ms-display"
        style={{ margin: "0 0 20px", color: "var(--ms-bone)", fontSize: "var(--ms-fs-h2)" }}
      >
        {t("title")}
      </h2>
      {summary.state === "unavailable" ? (
        <div role="status">
          <p style={{ ...valueStyle, marginTop: 0 }}>{t("unavailable")}</p>
          {onRetry ? (
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              onClick={onRetry}
              style={{ marginTop: 14, minHeight: 44, whiteSpace: "normal" }}
            >
              {t("retry")}
            </button>
          ) : (
            <p style={{ ...labelStyle, marginTop: 10 }}>{t("reload")}</p>
          )}
        </div>
      ) : (
        <>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
              gap: 24,
              margin: 0,
            }}
          >
            <Detail label={t("currentPeriod")}>
              {period(summary.currentPeriodStart, summary.currentPeriodEnd)}
            </Detail>
            <Detail label={t(summary.accessEndsAt ? "accessUntil" : "nextRenewal")}>
              {date(summary.accessEndsAt ?? summary.renewalAt)}
              {summary.accessEndsAt ? (
                <span style={{ ...labelStyle, display: "block", marginTop: 4 }}>
                  {t("notRenewing")}
                </span>
              ) : null}
            </Detail>
          </dl>

          {summary.benefit ? (
            <div
              style={{
                marginTop: 24,
                padding: 18,
                borderRadius: "var(--ms-r-card)",
                border: "1px solid var(--ms-success-border)",
                background: "var(--ms-success-bg)",
              }}
            >
              <h3 style={{ margin: 0, color: "var(--ms-success)", fontSize: "var(--ms-fs-ui)" }}>
                {t(summary.benefit.kind === "courtesy" ? "courtesy" : "discount")}
              </h3>
              <p style={{ ...valueStyle, marginTop: 8 }}>
                {t(summary.benefit.kind === "courtesy" ? "courtesyBody" : "discountBody")}
              </p>
              <dl style={{ margin: "14px 0 0", display: "grid", gap: 14 }}>
                <Detail label={t("benefitPeriod")}>
                  {period(summary.benefit.periodStart, summary.benefit.periodEnd)}
                </Detail>
                {summary.benefit.regularBillingResumesAt ? (
                  <Detail label={t("regularResumes")}>
                    {date(summary.benefit.regularBillingResumesAt)}
                  </Detail>
                ) : null}
              </dl>
            </div>
          ) : null}

          {invoice ? (
            <div style={{ marginTop: 24, paddingTop: 22, borderTop: "1px solid var(--ms-line)" }}>
              <h3 style={{ ...labelStyle, fontWeight: 400 }}>{t("nextPlanCharge")}</h3>
              <p
                className="ms-display"
                style={{ ...valueStyle, marginTop: 8, fontSize: "var(--ms-fs-h1)" }}
              >
                {money(invoice.baseNetCents)}
              </p>
              <p style={valueStyle}>
                {t("chargeOn")} {date(invoice.at)}
              </p>
              {invoice.baseDiscountCents > 0 ? (
                <p style={{ ...labelStyle, marginTop: 8 }}>
                  {t("baseDiscount", { amount: money(invoice.baseDiscountCents) })}
                </p>
              ) : null}
              <dl style={{ margin: "18px 0 0", display: "grid", gap: 18 }}>
                <Detail label={t("chargePeriod")}>
                  {period(invoice.periodStart, invoice.periodEnd)}
                </Detail>
                <Detail label={t("estimate")}>{money(invoice.totalEstimateCents)}</Detail>
              </dl>
              <p style={{ ...labelStyle, marginTop: 14, lineHeight: 1.6 }}>
                {t(invoice.usageMayChange ? "usageNote" : "estimateNote")}
              </p>
            </div>
          ) : (
            <p style={{ ...labelStyle, marginTop: 22, lineHeight: 1.6 }}>
              {t(summary.accessEndsAt ? "noRenewalCharge" : "invoiceUnavailable")}
            </p>
          )}
          <p style={{ ...labelStyle, marginTop: 18 }}>{t("datesUtc")}</p>
        </>
      )}
    </section>
  );
}
