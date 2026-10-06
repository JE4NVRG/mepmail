"use client";

import {
  MIN_GUARDRAIL_VOLUME,
  MIN_PAUSE_COMPLAINTS,
  MIN_PAUSE_HARD_BOUNCES,
} from "@millionsend/core/deliverability";
import { useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { NoticeStrip } from "@/components/notice-strip";
import { DOCS_URL } from "@/lib/docs-links";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";

type Health = inferRouterOutputs<AppRouter>["metrics"]["health"];

/**
 * Global deliverability notice. Renders nothing while the health query is
 * unresolved or "ok" (a thin strip needs no ghost — it would itself be the
 * layout shift it means to avoid). "warning" is an amber nudge; "paused" is a
 * red strip that mirrors the send guard's block. Both link to /metrics.
 */
export function DeliverabilityBanner() {
  const t = useTranslations("deliverability");
  const locale = useLocale();
  const trpc = useTRPC();
  const { data, isError, isPending } = useQuery(trpc.metrics.health.queryOptions());

  if (!data || isError || isPending || data.status === "ok") return null;

  const reason =
    data.status === "paused"
      ? data.reasons.find((r) => r.tier === "paused")
      : data.reasons.find((r) => r.tier === "warning");
  if (!reason) return null;

  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });
  const fmt = new Intl.NumberFormat(locale);
  const limit =
    reason.metric === "bounce" ? data.thresholds.pauseBounce : data.thresholds.pauseComplaint;
  const paused = data.status === "paused";
  const text = t(`banner.${data.status}.${reason.metric}`, {
    rate: pct.format(reason.rate),
    limit: pct.format(limit),
    days: reason.windowDays,
    count: fmt.format(reason.metric === "bounce" ? data.pause.hardBounced : data.pause.complained),
    sent: fmt.format(data.pause.sent),
  });

  return (
    <NoticeStrip
      href="/metrics"
      tone={paused ? "danger" : "warn"}
      text={text}
      action={t("banner.action")}
    />
  );
}

/** Recovery explains the live guardrail. Navigation never changes counters or sending authority. */
export function DeliverabilityRecovery({ health }: { health: Health | undefined }) {
  const t = useTranslations("deliverability");
  const locale = useLocale();
  const titleId = useId();
  if (!health || health.status === "ok") return null;

  const fmt = new Intl.NumberFormat(locale);
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });
  const paused = health.status === "paused";
  const earliestAt = health.recovery?.reevaluationEarliestAt;
  const reevaluationAt =
    earliestAt instanceof Date && Number.isFinite(earliestAt.getTime())
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "UTC",
        }).format(earliestAt)
      : null;

  return (
    <section className="ms-kpi-card" aria-labelledby={titleId} style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <h2 id={titleId} style={{ margin: 0, fontSize: "var(--ms-fs-label)" }}>
          {t("recovery.title")}
        </h2>
        <span className={`ms-badge ms-badge-${paused ? "danger" : "warn"}`}>
          {t(`recovery.status.${health.status}`)}
        </span>
      </div>
      <p style={{ color: "var(--ms-muted)", lineHeight: 1.6 }}>
        {t(paused ? "recovery.pauseWindow" : "recovery.warningWindow", { days: health.windowDays })}
      </p>
      <ul style={{ paddingLeft: 20, lineHeight: 1.7 }}>
        {health.reasons.map((reason) => (
          <li key={`${reason.metric}-${reason.tier}`}>
            {t(reason.tier === "paused" ? "recovery.pauseEvidence" : "recovery.warningEvidence", {
              metric: t(`metric.${reason.metric}`),
              rate: pct.format(reason.rate),
              days: reason.windowDays,
              count: fmt.format(
                reason.metric === "bounce" ? health.pause.hardBounced : health.pause.complained,
              ),
              sent: fmt.format(health.pause.sent),
            })}
          </li>
        ))}
      </ul>
      <h3 style={{ fontSize: "var(--ms-fs-label)", marginBottom: 6 }}>
        {t("recovery.criteriaTitle")}
      </h3>
      <p style={{ color: "var(--ms-muted)", lineHeight: 1.6, marginTop: 0 }}>
        {t("recovery.criteriaVolume", { sent: fmt.format(MIN_GUARDRAIL_VOLUME) })}
      </p>
      <ul style={{ paddingLeft: 20, lineHeight: 1.7 }}>
        <li>
          {t("recovery.bounceCriteria", {
            count: fmt.format(MIN_PAUSE_HARD_BOUNCES),
            rate: pct.format(health.thresholds.pauseBounce),
          })}
        </li>
        <li>
          {t("recovery.complaintCriteria", {
            count: fmt.format(MIN_PAUSE_COMPLAINTS),
            rate: pct.format(health.thresholds.pauseComplaint),
          })}
        </li>
      </ul>
      <h3 style={{ fontSize: "var(--ms-fs-label)", marginBottom: 6 }}>
        {t("recovery.stepsTitle")}
      </h3>
      <ol style={{ paddingLeft: 20, lineHeight: 1.7 }}>
        <li>{t("recovery.steps.list")}</li>
        <li>{t("recovery.steps.suppressions")}</li>
        <li>{t("recovery.steps.consent")}</li>
      </ol>
      <h3 style={{ fontSize: "var(--ms-fs-label)", marginBottom: 6 }}>
        {t("recovery.reevaluationTitle")}
      </h3>
      <p style={{ color: "var(--ms-muted)", lineHeight: 1.6, marginTop: 0 }}>
        {reevaluationAt && earliestAt ? (
          <time dateTime={earliestAt.toISOString()}>
            {t("recovery.reevaluationAt", { date: reevaluationAt })}
          </time>
        ) : (
          t("recovery.reevaluationPending")
        )}
      </p>
      <p style={{ color: "var(--ms-muted)", lineHeight: 1.6 }}>{t("recovery.automatic")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <Link className="ms-btn ms-btn-primary" href="/emails/suppressions">
          {t("recovery.openSuppressions")}
        </Link>
        <a
          className="ms-btn ms-btn-ghost"
          href={`${DOCS_URL}/concepts/suppressions`}
          target="_blank"
          rel="noreferrer"
        >
          {t("recovery.help")}
        </a>
      </div>
    </section>
  );
}
