import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PublicFooter, PublicHeader, type PublicSiteLabels } from "@/components/site-chrome";
import { legalLinks } from "@/lib/legal-links";
import { readPublicMetrics } from "@/server/public-delivery";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "../site-v2.css";

// Public delivery rates. Not /metrics: the dashboard already owns that URL
// (app/(dashboard)/metrics), so this page takes its own public path.
const canonical = "/delivery";

/**
 * Rendering happens per request: the numbers come from one memoized database
 * read (server/public-delivery.ts), never from a build-time snapshot and never
 * from a query per view.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("public-metrics");
  const seo = await publicPageUrls(canonical);
  return {
    title: t("title"),
    description: t("description"),
    alternates: seo.alternates,
    robots: { index: true, follow: true },
  };
}

/**
 * Public /delivery: delivery, bounce and complaint rates for the rolling
 * 30-day window, computed from the platform's own mail. Rates only — no
 * absolute volume, no per-customer or per-domain numbers — and accounts
 * suspended for abuse are left out of every count. Below the minimum resolved
 * volume the page refuses to publish a rate instead of showing noise.
 */
export default async function MetricsPage() {
  const [t, l, locale, snapshot] = await Promise.all([
    getTranslations("public-metrics"),
    getTranslations("landing"),
    getLocale(),
    readPublicMetrics(),
  ]);
  const labels = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const stamp = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  // One decimal is all a rate this size can honestly carry.
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const rates = snapshot?.rates ?? null;
  const points = t.raw("methodology.points") as string[];
  return (
    <div className="gtm v2">
      <PublicHeader labels={labels} page="metrics" />
      <main id="conteudo">
        <section className="v2-dark v2-sec">
          <div className="v2-wrap v2-stack">
            <p className="v2-eyebrow">{t("eyebrow")}</p>
            <h1 className="v2-display">{t("title")}</h1>
            <p className="v2-lead">{t("lead")}</p>
            {snapshot ? (
              <p className="v2-note">
                {t("window", {
                  since: day.format(new Date(snapshot.since)),
                  until: day.format(new Date(snapshot.until)),
                })}
                {" · "}
                {t("computedAt", { time: stamp.format(new Date(snapshot.computedAt)) })}
              </p>
            ) : null}
          </div>
        </section>

        <section className="v2-dark v2-sec-tight">
          <div className="v2-wrap">
            {rates ? (
              <div className="v2-stats">
                <p className="v2-stat">
                  <span className="v2-stat-num">{percent.format(rates.deliveryRate)}</span>
                  <span className="v2-stat-text">{t("rates.delivery")}</span>
                  <span className="v2-note">{t("rates.deliveryNote")}</span>
                </p>
                <p className="v2-stat">
                  <span className="v2-stat-num">{percent.format(rates.bounceRate)}</span>
                  <span className="v2-stat-text">{t("rates.bounce")}</span>
                  <span className="v2-note">{t("rates.bounceNote")}</span>
                </p>
                <p className="v2-stat">
                  <span className="v2-stat-num">{percent.format(rates.complaintRate)}</span>
                  <span className="v2-stat-text">{t("rates.complaint")}</span>
                  <span className="v2-note">{t("rates.complaintNote")}</span>
                </p>
              </div>
            ) : (
              <article className="v2-card">
                <h2 className="v2-h3-sm">
                  {t(snapshot ? "insufficient.title" : "unavailable.title")}
                </h2>
                <p className="v2-body">{t(snapshot ? "insufficient.body" : "unavailable.body")}</p>
              </article>
            )}
          </div>
        </section>

        <section className="v2-light v2-sec">
          <div className="v2-wrap v2-narrow">
            <p className="v2-eyebrow">{t("methodology.eyebrow")}</p>
            <h2 className="v2-h2">{t("methodology.title")}</h2>
            <ul className="v2s-points v2s-gap">
              {points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <p className="v2-note v2s-gap">{t("methodology.note")}</p>
            <div className="v2-actions">
              <a className="v2-btn v2-btn-line" href="/status">
                {t("statusLink")}
              </a>
              <a className="v2-btn v2-btn-line" href="mailto:suporte@mepmail.dev">
                {t("support")}
              </a>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter
        labels={labels}
        page="metrics"
        contact="mailto:suporte@mepmail.dev"
        legal={legalLinks()}
      />
    </div>
  );
}
