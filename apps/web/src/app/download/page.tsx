import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { PublicFooter, PublicHeader, type PublicSiteLabels } from "@/components/site-chrome";
import {
  DESKTOP_DOWNLOAD_URL,
  type DesktopAppPlatform,
  desktopAppFor,
  LINUX_DOWNLOAD_URL,
  WINDOWS_INSTALLER_URL,
  WINDOWS_STORE_URL,
} from "@/lib/desktop-download";
import { legalLinks } from "@/lib/legal-links";
import { publicPageUrls } from "@/server/public-seo";
import latest from "../../../public/desktop/correio/latest.json";
import "../landing.css";
import "./download.css";

const contact = "mailto:suporte@mepmail.dev";
const SOURCE_URL = "https://github.com/JE4NVRG/mepmail/tree/main/apps/desktop";

type Feature = { title: string; body: string };

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls(DESKTOP_DOWNLOAD_URL);
  const t = await getTranslations("desktop.hub");
  return {
    title: { absolute: t("meta.title") },
    description: t("meta.description"),
    alternates: seo.alternates,
    robots: { index: true, follow: true },
    openGraph: {
      title: t("meta.title"),
      description: t("meta.description"),
      url: seo.url,
      locale: seo.ogLocale,
      type: "website",
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/**
 * Every way to get the desktop app, in one place the whole site links to: Windows (the
 * Microsoft Store first, the self-updating installer for PCs where the Store is blocked)
 * and Linux (its own page with the packages). The visitor's system, read from the user
 * agent, comes first and is marked; phones and Macs get the browser.
 */
export default async function DownloadPage() {
  const t = await getTranslations("desktop.hub");
  const l = await getTranslations("landing");
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const features = t.raw("features") as Feature[];
  const detected = desktopAppFor((await headers()).get("user-agent") ?? "", false);
  const order: DesktopAppPlatform[] =
    detected === "linux" ? ["linux", "windows"] : ["windows", "linux"];

  const cards: Record<DesktopAppPlatform, ReactNode> = {
    windows: (
      <article
        className="gtm-integration download-card"
        id="windows"
        key="windows"
        data-detected={detected === "windows" || undefined}
      >
        {detected === "windows" ? <p className="download-detected">{t("detected")}</p> : null}
        <p className="gtm-integration-kind">{t("windows.kind")}</p>
        <h2>{t("windows.name")}</h2>
        <p>{t("windows.body")}</p>
        <div className="download-actions">
          <a
            className="ms-btn ms-btn-primary gtm-action"
            href={WINDOWS_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("windows.store")} <span aria-hidden="true">↗</span>
          </a>
          <a className="download-secondary" href={WINDOWS_INSTALLER_URL}>
            {t("windows.installer")}
          </a>
          <p className="download-fine">{t("windows.installerNote")}</p>
        </div>
      </article>
    ),
    linux: (
      <article
        className="gtm-integration download-card"
        id="linux"
        key="linux"
        data-detected={detected === "linux" || undefined}
      >
        {detected === "linux" ? <p className="download-detected">{t("detected")}</p> : null}
        <p className="gtm-integration-kind">{t("linux.kind")}</p>
        <h2>{t("linux.name")}</h2>
        <p>{t("linux.body")}</p>
        <div className="download-actions">
          <a className="ms-btn ms-btn-primary gtm-action" href={LINUX_DOWNLOAD_URL}>
            {t("linux.download")} <span aria-hidden="true">→</span>
          </a>
        </div>
      </article>
    ),
  };

  return (
    <div className="gtm">
      <PublicHeader labels={site} page="download" />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("eyebrow")}</p>
            <h1>{t.rich("title", { highlight: (chunks) => <span>{chunks}</span> })}</h1>
            <p className="gtm-lead">{t("lead")}</p>
            <p className="gtm-note">{t("note", { version: latest.version })}</p>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <div className="gtm-integrations download-cards">{order.map((key) => cards[key])}</div>
          </div>
        </section>

        <section className="gtm-section" aria-labelledby="download-features-title">
          <div className="gtm-container">
            <h2 id="download-features-title" className="download-title">
              {t("featuresTitle")}
            </h2>
            <ul className="download-features">
              {features.map((feature) => (
                <li key={feature.title}>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container download-other">
            <h2>{t("otherTitle")}</h2>
            <p>{t("other")}</p>
            <p className="download-links">
              <a className="ms-btn ms-btn-secondary gtm-action" href="/mail">
                {t("openWeb")} <span aria-hidden="true">→</span>
              </a>
              <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                {t("source")} <span aria-hidden="true">↗</span>
              </a>
            </p>
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="download" contact={contact} legal={legalLinks()} />
    </div>
  );
}
