import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { legalLinks } from "@/lib/legal-links";
import "../landing.css";

const contact = "mailto:jean@je4ndev.com";
const canonical = "/integrations";

type IntegrationCard = {
  name: string;
  kind: string;
  body: string;
  bullets: string[];
  links: { label: string; href: string }[];
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("integrations");
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
      images: [{ url: "/og.png", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/**
 * Página pública /integrations: a história de encaixe do MepMail nas
 * ferramentas do cliente (n8n, canais de chat, MCP, SMTP, SDKs do Resend,
 * CLI/API). O chrome e o catálogo de copy compartilhado vêm de "landing";
 * a copy da página vive no namespace "integrations".
 */
export default async function IntegrationsPage() {
  const t = await getTranslations("integrations");
  const l = await getTranslations("landing");
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const cards = t.raw("cards.items") as IntegrationCard[];

  return (
    <div className="gtm">
      <PublicHeader labels={site} page="integrations" />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("hero.eyebrow")}</p>
            <h1>
              {t.rich("hero.title", {
                highlight: (chunks) => <span>{chunks}</span>,
              })}
            </h1>
            <p className="gtm-lead">{t("hero.lead")}</p>
            <p className="gtm-note">{t("hero.note")}</p>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <div className="gtm-integrations">
              {cards.map((card) => (
                <article className="gtm-integration" key={card.name}>
                  <p className="gtm-integration-kind">{card.kind}</p>
                  <h3>{card.name}</h3>
                  <p>{card.body}</p>
                  <ul className="gtm-points">
                    {card.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                  <p className="gtm-integration-links">
                    {card.links.map((link) =>
                      link.href.startsWith("http") ? (
                        <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
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

        <section className="gtm-section gtm-close">
          <div className="gtm-container">
            <h2>{t("close.title")}</h2>
            <p>{t("close.body")}</p>
            <SignupLink label={t("close.cta")} />
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="integrations" contact={contact} legal={legalLinks()} />
    </div>
  );
}
