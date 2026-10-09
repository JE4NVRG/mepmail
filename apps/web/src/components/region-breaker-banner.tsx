"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { NoticeStrip } from "@/components/notice-strip";
import { useTRPC } from "@/lib/trpc";

/**
 * One strip per SES region where the platform breaker holds broadcasts. The
 * query answers null for users who cannot act on it.
 */
export function RegionBreakerBanner() {
  const t = useTranslations("settings.ses.breaker");
  const locale = useLocale();
  const trpc = useTRPC();
  const { data } = useQuery(trpc.system.platformBreakers.queryOptions());
  if (!data) return null;
  // "0,49" in pt-BR, "0.49" in en.
  const percent = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (
    <>
      {data.map((r) => (
        <NoticeStrip
          key={r.region}
          tone="danger"
          text={
            r.held
              ? t("held", { region: r.region })
              : t("paused", {
                  region: r.region,
                  metric: t(`metric.${r.reason?.metric ?? "complaint"}`),
                  rate: percent.format((r.reason?.rate ?? 0) * 100),
                })
          }
        />
      ))}
    </>
  );
}
