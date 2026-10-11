import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PublicFooter, PublicHeader, type PublicSiteLabels } from "@/components/site-chrome";
import { LINUX_DOWNLOAD_URL, WINDOWS_STORE_URL } from "@/lib/desktop-download";
import { legalLinks } from "@/lib/legal-links";
import latest from "../../../../../public/desktop/correio/latest.json";
import { type LinuxBundle, linuxFile } from "./linux-download";
import "../../../landing.css";
import "./linux.css";

const contact = "mailto:suporte@mepmail.dev";
const SOURCE_URL = "https://github.com/JE4NVRG/mepmail/tree/main/apps/desktop";
/** Most people run a Debian-family system: the .deb comes first. */
const BUNDLES: LinuxBundle[] = ["deb", "rpm", "appimage"];

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("desktop.linux");
  return {
    title: { absolute: t("meta.title") },
    description: t("meta.description"),
    alternates: { canonical: LINUX_DOWNLOAD_URL },
    robots: { index: true, follow: true },
    openGraph: {
      title: t("meta.title"),
      description: t("meta.description"),
      url: LINUX_DOWNLOAD_URL,
      type: "website",
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/**
 * The Linux downloads: the .deb, the .rpm and the AppImage of the current
 * desktop version, each with the command that installs or runs it and how it
 * updates. The buttons use the stable links next to this page (linux/deb,
 * linux/rpm, linux/appimage), which follow latest.json.
 */
export default async function LinuxDownloadsPage() {
  const t = await getTranslations("desktop.linux");
  const l = await getTranslations("landing");
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const tips = t.raw("tips") as string[];

  return (
    <div className="gtm">
      <PublicHeader labels={site} page="correio" />
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
            <div className="gtm-integrations linux-packages">
              {BUNDLES.map((bundle) => {
                const file = linuxFile(bundle).name;
                return (
                  <article className="gtm-integration" key={bundle} id={bundle}>
                    <p className="gtm-integration-kind">{t(`packages.${bundle}.kind`)}</p>
                    <h2>{t(`packages.${bundle}.name`)}</h2>
                    <p>{t(`packages.${bundle}.body`)}</p>
                    <div className="linux-command">
                      <p>{t("commandLabel")}</p>
                      <pre className="gtm-demo-code">
                        <code>{t(`packages.${bundle}.command`, { file })}</code>
                      </pre>
                    </div>
                    <p className="linux-updates">
                      <strong>{t("updatesLabel")}:</strong> {t(`packages.${bundle}.updates`)}
                    </p>
                    <a
                      className="ms-btn ms-btn-primary gtm-action linux-download"
                      href={`${LINUX_DOWNLOAD_URL}/${bundle}`}
                    >
                      {t(`packages.${bundle}.download`)}
                    </a>
                    <p className="linux-file">{file}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container linux-tips">
            <h2>{t("tipsTitle")}</h2>
            <ul className="gtm-points">
              {tips.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
            <p className="linux-links">
              <a href={WINDOWS_STORE_URL} target="_blank" rel="noopener noreferrer">
                {t("windows")} <span aria-hidden="true">↗</span>
              </a>
              <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                {t("source")} <span aria-hidden="true">↗</span>
              </a>
            </p>
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="correio" contact={contact} legal={legalLinks()} />
    </div>
  );
}
