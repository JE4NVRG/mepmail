import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { StructuredData } from "@/components/structured-data";
import {
  GUIDE_SLUGS,
  GUIDES_UPDATED,
  type GuideCopy,
  type GuideSlug,
  guidePath,
  isGuideSlug,
} from "@/lib/guides";
import { legalLinks } from "@/lib/legal-links";
import { articleJsonLd, faqJsonLd, organizationJsonLd, siteBaseUrl } from "@/lib/structured-data";
import { publicPageUrls } from "@/server/public-seo";
import "../../landing.css";
import "../guides.css";

const contact = "mailto:suporte@mepmail.dev";

type Params = { params: Promise<{ slug: string }> };

async function guideOf(params: Params["params"]): Promise<{ slug: GuideSlug; copy: GuideCopy }> {
  const { slug } = await params;
  if (!isGuideSlug(slug)) notFound();
  const t = await getTranslations("guides");
  return { slug, copy: t.raw(`items.${slug}`) as GuideCopy };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, copy } = await guideOf(params);
  const seo = await publicPageUrls(guidePath(slug));
  return {
    title: { absolute: `${copy.meta.title} | MepMail` },
    description: copy.meta.description,
    alternates: seo.alternates,
    robots: { index: true, follow: true },
    openGraph: {
      title: copy.meta.title,
      description: copy.meta.description,
      url: seo.url,
      locale: seo.ogLocale,
      type: "article",
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/**
 * A public guide: one how-to per search people make before they buy email (see
 * lib/guides.ts), the copy in messages/<locale>/guides.json, an Article + FAQPage
 * graph and links to the other guides.
 */
export default async function GuidePage({ params }: Params) {
  const { slug, copy } = await guideOf(params);
  const locale = await getLocale();
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
  const base = siteBaseUrl();
  const url = `${base}${(await publicPageUrls(guidePath(slug))).url}`;
  const updated = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${GUIDES_UPDATED}T12:00:00Z`),
  );
  const others = GUIDE_SLUGS.filter((other) => other !== slug);

  return (
    <div className="gtm">
      <StructuredData
        graph={[
          organizationJsonLd(base),
          articleJsonLd(base, {
            url,
            headline: copy.title,
            description: copy.meta.description,
            dateModified: GUIDES_UPDATED,
            locale,
          }),
          faqJsonLd(copy.faq),
        ]}
      />
      <PublicHeader labels={site} page="guides" />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container guide-article">
            <p className="gtm-eyebrow">{copy.eyebrow}</p>
            <h1>{copy.title}</h1>
            <p className="gtm-lead">{copy.lead}</p>
            <p className="guide-updated">
              <time dateTime={GUIDES_UPDATED}>{t("updated", { date: updated })}</time>
            </p>
          </div>
        </section>

        <section className="gtm-section">
          <article className="gtm-container guide-article">
            {copy.sections.map((section) => (
              <section className="guide-part" key={section.title}>
                <h2>{section.title}</h2>
                {section.body?.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {section.steps ? (
                  <ol className="guide-steps">
                    {section.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                ) : null}
              </section>
            ))}
          </article>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container guide-article">
            <h2>{t("faqTitle")}</h2>
            <div className="gtm-faq">
              {copy.faq.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container guide-article">
            <h2>{t("related")}</h2>
            <ul className="guide-related">
              {others.map((other) => {
                const item = t.raw(`items.${other}`) as GuideCopy;
                return (
                  <li key={other}>
                    <a href={guidePath(other)}>{item.title}</a>
                    <p>{item.card}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        <section className="gtm-section gtm-close">
          <div className="gtm-container">
            <h2>{copy.cta.title}</h2>
            <p>{copy.cta.body}</p>
            <SignupLink label={copy.cta.button} />
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="guides" contact={contact} legal={legalLinks()} />
    </div>
  );
}
