import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { EloziSupport, type EloziSupportLabels } from "@/components/elozi-support";
import { PublicFooter, PublicHeader, type PublicSiteLabels } from "@/components/site-chrome";
import { DOCS_URL } from "@/lib/docs-links";
import { resolveEloziSupportChannel } from "@/lib/elozi-support";
import { legalLinks } from "@/lib/legal-links";
import { hasSession } from "@/server/auth";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "./support.css";

const contact = "mailto:suporte@mepmail.dev";
const canonical = "/support";

type SupportChannel = {
  name: string;
  kind: string;
  body: string;
  bullets: string[];
  links: { label: string; href: string }[];
};
type FaqItem = { q: string; a: string; link: { label: string; href: string } };

// In the Android app this page is the help (lib/android-app.ts): the docs links leave it
// ([data-docs]), and the answers that quote a price or point to the plans stay out of it
// ([data-purchase]), as nothing is sold there.
const isDocs = (href: string) => href.startsWith(DOCS_URL);
const quotesPurchase = (item: FaqItem) =>
  item.link.href.startsWith("/pricing") || /(?:US\$|R\$|\$)\s?\d/.test(item.a);

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls(canonical);
  const t = await getTranslations("support");
  const description = t("meta.description");
  return {
    title: { absolute: t("meta.title") },
    description,
    alternates: seo.alternates,
    robots: { index: true, follow: true },
    openGraph: {
      title: t("meta.title"),
      description,
      url: seo.url,
      locale: seo.ogLocale,
      type: "website",
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/**
 * Página pública /support: os canais de atendimento (e-mail, docs, updates e a
 * status page) e um
 * FAQ enxuto cujos links apontam para páginas reais da documentação. A copy
 * vive no namespace "support".
 */
export default async function SupportPage() {
  const t = await getTranslations("support");
  const l = await getTranslations("landing");
  // Signed in: identity is required even when configuration is temporarily unavailable.
  const identified = await hasSession();
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const channels = t.raw("channels.items") as SupportChannel[];
  const faq = t.raw("faq.items") as FaqItem[];
  const badges = t.raw("hero.badges") as string[];

  return (
    <div className="gtm">
      <PublicHeader labels={site} page="support" />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container gtm-support-hero">
            <div>
              <p className="gtm-eyebrow">{t("hero.eyebrow")}</p>
              <h1>{t("hero.title")}</h1>
              <p className="gtm-lead">{t("hero.lead")}</p>
              <ul className="gtm-chips">
                {badges.map((badge) => (
                  <li className="gtm-chip" key={badge}>
                    {badge}
                  </li>
                ))}
              </ul>
              <div className="gtm-actions">
                <a className="ms-btn ms-btn-primary gtm-action" href="mailto:suporte@mepmail.dev">
                  {t("hero.ctaEmail")}
                </a>
                <a className="ms-btn ms-btn-secondary gtm-action" href={DOCS_URL} data-docs="">
                  {t("hero.ctaDocs")}
                </a>
              </div>
              <p className="gtm-note">{t("hero.note")}</p>
            </div>
            <EloziSupport
              config={resolveEloziSupportChannel()}
              labels={t.raw("assistant") as EloziSupportLabels}
              identified={identified}
            />
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("channels.eyebrow")}</p>
            <h2>{t("channels.title")}</h2>
            <p>{t("channels.body")}</p>
            <div className="gtm-integrations gtm-pairs">
              {channels.map((channel) => (
                <article
                  className="gtm-integration"
                  key={channel.name}
                  data-docs={
                    channel.links.length && channel.links.every((link) => isDocs(link.href))
                      ? ""
                      : undefined
                  }
                >
                  <p className="gtm-integration-kind">{channel.kind}</p>
                  <h3>{channel.name}</h3>
                  <p>{channel.body}</p>
                  <ul className="gtm-points">
                    {channel.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                  <p className="gtm-integration-links">
                    {channel.links.map((link) =>
                      link.href.startsWith("http") ? (
                        <a
                          key={link.href}
                          href={link.href}
                          target="_blank"
                          rel="noreferrer"
                          data-docs={isDocs(link.href) ? "" : undefined}
                        >
                          {link.label}
                        </a>
                      ) : (
                        <a key={link.href} href={link.href}>
                          {link.label}
                        </a>
                      ),
                    )}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("faq.eyebrow")}</p>
            <h2>{t("faq.title")}</h2>
            <div className="gtm-faq">
              {faq.map((item) => (
                <details key={item.q} data-purchase={quotesPurchase(item) ? "" : undefined}>
                  <summary>{item.q}</summary>
                  <p>
                    {item.a}{" "}
                    <a href={item.link.href} data-docs={isDocs(item.link.href) ? "" : undefined}>
                      {item.link.label}
                    </a>
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="gtm-section gtm-close">
          <div className="gtm-container">
            <h2>{t("close.title")}</h2>
            <p>{t("close.body")}</p>
            <a className="ms-btn ms-btn-primary gtm-action" href="mailto:suporte@mepmail.dev">
              {t("close.cta")}
            </a>
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="support" contact={contact} legal={legalLinks()} />
    </div>
  );
}
