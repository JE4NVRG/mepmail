import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DocsLink } from "@/components/public-events";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { StackLogoRow } from "@/components/stack-logos";
import { DOCS_URL } from "@/lib/docs-links";
import { legalLinks } from "@/lib/legal-links";
import { STACK_SLUGS } from "@/lib/stack-logos";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "./integrations.css";

const contact = "mailto:suporte@mepmail.dev";
const canonical = "/integrations";

/**
 * The hero mural: every vendor mark the page can point at. The MCP text chip is
 * not a brand mark, so it stays inside the "AI agents" card instead.
 */
const MURAL_SLUGS = STACK_SLUGS;

type IntegrationCard = {
  name: string;
  kind: string;
  /** Slugs of the logos shown inside the card; "mcp" draws the text chip. */
  logos: string[];
  body: string;
  bullets: string[];
  links: { label: string; href: string }[];
  /** What the card reaches and with which credential (labels come from accessLabels). */
  access?: { label: AccessLabel; value: string }[];
};

type AccessLabel = "product" | "endpoint" | "credential" | "permissions";
type Credential = { name: string; where: string; body: string };

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls(canonical);
  const t = await getTranslations("integrations");
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
  const credentials = t.raw("credentials.items") as Credential[];
  const accessLabels = t.raw("accessLabels") as Record<AccessLabel, string>;

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
            {/* The two ways in sit in the hero: the page's own close CTA lands
                thousands of pixels down, past the fold of every phone. */}
            <div className="gtm-actions">
              <SignupLink label={t("close.cta")} />
              <DocsLink className="ms-btn ms-btn-secondary gtm-action" href={DOCS_URL}>
                {l("nav.docs")}
              </DocsLink>
            </div>
            <p className="gtm-note">{t("hero.note")}</p>
            <div className="gtm-integrations-mural">
              <p className="gtm-stack-eyebrow">{t("hero.muralLabel")}</p>
              <StackLogoRow slugs={MURAL_SLUGS} />
            </div>
          </div>
        </section>

        <section className="gtm-section" aria-labelledby="integrations-credentials-title">
          <div className="gtm-container">
            <h2 id="integrations-credentials-title" className="integrations-credentials-title">
              {t("credentials.title")}
            </h2>
            <p className="integrations-credentials-lead">{t("credentials.lead")}</p>
            <ul className="integrations-credentials">
              {credentials.map((credential) => (
                <li key={credential.name}>
                  <h3>{credential.name}</h3>
                  <p className="integrations-credential-where">{credential.where}</p>
                  <p>{credential.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <div className="gtm-integrations">
              {cards.map((card) => (
                <article className="gtm-integration" key={card.name}>
                  <p className="gtm-integration-kind">{card.kind}</p>
                  <h3>{card.name}</h3>
                  {card.logos.length > 0 ? (
                    <StackLogoRow slugs={card.logos} size={22} className="gtm-integration-mark" />
                  ) : null}
                  <p>{card.body}</p>
                  {card.access?.length ? (
                    <dl className="integration-access">
                      {card.access.map((row) => (
                        <div key={row.label}>
                          <dt>{accessLabels[row.label]}</dt>
                          <dd>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
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
