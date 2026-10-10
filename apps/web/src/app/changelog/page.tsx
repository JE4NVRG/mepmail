import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { DOCS_URL } from "@/lib/docs-links";
import { legalLinks } from "@/lib/legal-links";
import "../landing.css";

const contact = "mailto:suporte@mepmail.dev";
const canonical = "/changelog";

type ChangeGroup = { kind: string; items: string[] };
type Release = {
  version: string;
  date: string;
  title: string;
  summary: string;
  changes: ChangeGroup[];
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("changelog");
  const description = t("meta.description");
  return {
    title: { absolute: t("meta.title") },
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      title: t("meta.title"),
      description,
      url: canonical,
      type: "website",
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/**
 * Página pública /changelog: a lista de releases recentes, mais novas primeiro,
 * reconstruída do histórico do repositório (e espelhada em CHANGELOG.md). A copy
 * vive no namespace "changelog"; o chrome e o catálogo público vêm de "landing".
 */
export default async function ChangelogPage() {
  const t = await getTranslations("changelog");
  const l = await getTranslations("landing");
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const badges = t.raw("hero.badges") as string[];
  const releases = t.raw("releases") as Release[];
  const labels = t.raw("feed.labels") as Record<string, string>;

  return (
    <div className="gtm">
      <PublicHeader labels={site} page="changelog" />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("hero.eyebrow")}</p>
            <h1>{t.rich("hero.title", { highlight: (chunks) => <span>{chunks}</span> })}</h1>
            <p className="gtm-lead">{t("hero.lead")}</p>
            <ul className="gtm-chips">
              {badges.map((badge) => (
                <li className="gtm-chip" key={badge}>
                  {badge}
                </li>
              ))}
            </ul>
            <div className="gtm-actions">
              <SignupLink label={l("plans.cta")} />
              <a className="ms-btn ms-btn-secondary gtm-action" href={DOCS_URL}>
                {t("hero.ctaDocs")}
              </a>
            </div>
            <p className="gtm-note">{t("hero.note")}</p>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("feed.eyebrow")}</p>
            <h2>{t("feed.title")}</h2>
            <p>{t("feed.body")}</p>
          </div>
        </section>

        {releases.map((release, index) => (
          <section
            key={release.version}
            className={index % 2 === 0 ? "gtm-section" : "gtm-section gtm-alt"}
            id={`v${release.version}`}
          >
            <div className="gtm-container">
              <p className="gtm-eyebrow">{release.date}</p>
              <h2>
                v{release.version} — {release.title}
              </h2>
              <p>{release.summary}</p>
              {release.changes.map((change) => (
                <div key={change.kind}>
                  <h3 className="gtm-subhead">{labels[change.kind] ?? change.kind}</h3>
                  <ul className="gtm-points">
                    {change.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="gtm-section gtm-close">
          <div className="gtm-container">
            <h2>{t("close.title")}</h2>
            <p>{t("close.body")}</p>
            <div className="gtm-actions">
              <SignupLink label={l("plans.cta")} />
              <a className="ms-btn ms-btn-secondary gtm-action" href={DOCS_URL}>
                {t("close.cta")}
              </a>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="changelog" contact={contact} legal={legalLinks()} />
    </div>
  );
}
