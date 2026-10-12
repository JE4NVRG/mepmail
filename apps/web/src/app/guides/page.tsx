import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PublicFooter, PublicHeader, type PublicSiteLabels } from "@/components/site-chrome";
import { StructuredData } from "@/components/structured-data";
import { GUIDE_SLUGS, type GuideCopy, guidePath } from "@/lib/guides";
import { legalLinks } from "@/lib/legal-links";
import { organizationJsonLd, siteBaseUrl } from "@/lib/structured-data";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "./guides.css";

const contact = "mailto:suporte@mepmail.dev";
const canonical = "/guides";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls(canonical);
  const t = await getTranslations("guides");
  return {
    title: { absolute: `${t("index.meta.title")} | MepMail` },
    description: t("index.meta.description"),
    alternates: seo.alternates,
    robots: { index: true, follow: true },
    openGraph: {
      title: t("index.meta.title"),
      description: t("index.meta.description"),
      url: seo.url,
      locale: seo.ogLocale,
      type: "website",
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/** /guides: the list of public guides (lib/guides.ts), each with its one-line summary. */
export default async function GuidesIndexPage() {
  const t = await getTranslations("guides");
  const l = await getTranslations("landing");
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;

  return (
    <div className="gtm">
      <StructuredData graph={[organizationJsonLd(siteBaseUrl())]} />
      <PublicHeader labels={site} page="guides" />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container guide-article">
            <p className="gtm-eyebrow">{t("index.eyebrow")}</p>
            <h1>{t("index.title")}</h1>
            <p className="gtm-lead">{t("index.lead")}</p>
          </div>
        </section>
        <section className="gtm-section">
          <div className="gtm-container guide-article">
            <ul className="guide-related">
              {GUIDE_SLUGS.map((slug) => {
                const item = t.raw(`items.${slug}`) as GuideCopy;
                return (
                  <li key={slug}>
                    <a href={guidePath(slug)}>{item.title}</a>
                    <p>{item.card}</p>
                    <a className="guide-read" href={guidePath(slug)}>
                      {t("index.read")} <span aria-hidden="true">→</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="guides" contact={contact} legal={legalLinks()} />
    </div>
  );
}
