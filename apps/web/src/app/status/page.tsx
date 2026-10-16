import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PublicFooter, PublicHeader, type PublicSiteLabels } from "@/components/site-chrome";
import { legalLinks } from "@/lib/legal-links";
import { readPublicStatus } from "@/lib/public-status";
import { PUBLISHED_INCIDENTS } from "@/lib/public-status-history";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "./status.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("status");
  const seo = await publicPageUrls("/status");
  return {
    title: t("title"),
    description: t("description"),
    alternates: seo.alternates,
    robots: { index: true, follow: true },
  };
}

export default async function StatusPage() {
  const [t, l, locale, snapshot] = await Promise.all([
    getTranslations("status"),
    getTranslations("landing"),
    getLocale(),
    readPublicStatus(),
  ]);
  const labels = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const available = snapshot.checks.every((check) => check.available);
  const stamp = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
  return (
    <div className="gtm gtm-status">
      <PublicHeader labels={labels} page="status" />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("eyebrow")}</p>
            <h1>{t("title")}</h1>
            <p className="gtm-lead">{t("description")}</p>
            <p className={`gtm-status-summary ${available ? "is-available" : "is-unavailable"}`}>
              <span aria-hidden="true" />
              {t(available ? "summaryAvailable" : "summaryUnavailable")}
            </p>
            <p className="gtm-note">
              {t("checkedAt", { time: stamp.format(new Date(snapshot.checkedAt)) })}
            </p>
            <div className="gtm-status-grid">
              {snapshot.checks.map((check) => (
                <article className="ms-card gtm-status-service" key={check.id}>
                  <h2>{t(`services.${check.id}`)}</h2>
                  <p className={check.available ? "is-available" : "is-unavailable"}>
                    {t(check.available ? "available" : "unavailable")}
                  </p>
                  <small>
                    {check.httpStatus === null ? t("noResponse") : `HTTP ${check.httpStatus}`}
                  </small>
                </article>
              ))}
            </div>
            <p className="gtm-note gtm-status-scope">{t("scope")}</p>
            <div className="gtm-actions">
              <a className="ms-btn ms-btn-secondary gtm-action" href="/status">
                {t("refresh")}
              </a>
              <a className="ms-btn ms-btn-secondary gtm-action" href="/support">
                {t("support")}
              </a>
            </div>
          </div>
        </section>
        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("historyEyebrow")}</p>
            <h2>{t("historyTitle")}</h2>
            {PUBLISHED_INCIDENTS.length === 0 ? (
              <p>{t("historyEmpty")}</p>
            ) : (
              <ol className="gtm-status-history">
                {PUBLISHED_INCIDENTS.map((incident) => (
                  <li key={incident.id}>
                    <time dateTime={incident.startedAt}>
                      {stamp.format(new Date(incident.startedAt))} UTC
                    </time>
                    <p>{incident.summary[locale === "pt-BR" ? "pt-BR" : "en"]}</p>
                    <strong>{t(incident.resolvedAt ? "resolved" : "ongoing")}</strong>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </main>
      <PublicFooter
        labels={labels}
        page="status"
        contact="mailto:suporte@mepmail.dev"
        legal={legalLinks()}
      />
    </div>
  );
}
