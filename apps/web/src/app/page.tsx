import { PLAN_RUNGS } from "@millionsend/core";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { IntegrationTabs } from "@/components/integration-tabs";
import { type CalcLabels, LandingCalculator } from "@/components/landing-calculator";
import { LandingMotion } from "@/components/landing-motion";
import { PlanCard, type PlanCardLabels } from "@/components/plan-card";
import { ArrivalTracker, McpConfigCopy } from "@/components/public-events";
import { PublicStarterGallery } from "@/components/public-starter-gallery";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { StackLogoRow } from "@/components/stack-logos";
import { type PlanCopy, plansWithCopy } from "@/lib/landing-plans";
import { formatUsd, formatVolume, priceRowsForOffer } from "@/lib/landing-pricing";
import { LAUNCH_OFFER } from "@/lib/launch-offer";
import { legalLinks } from "@/lib/legal-links";
import { HOME_STACK_LOGOS } from "@/lib/stack-logos";
import { AgentDemo, type AgentDemoLabels } from "./correio/agent-demo";
import "./landing-calc.css";
import "./landing.css";
import "./landing-cro.css";

const contact = "mailto:jean@mepmail.dev";
const cellKeys = ["MepMail", "Resend", "SendGrid", "Postmark", "Mailgun", "vantagem"] as const;
const stackSlugs = HOME_STACK_LOGOS.map((logo) => logo.slug);
const proOffer = PLAN_RUNGS.find((rung) => rung.key === "pro_100k");
const MCP_CONFIG = `{
  "mcpServers": {
    "mepmail": {
      "command": "npx",
      "args": ["-y", "@mepmail/mcp"],
      "env": {
        "MEPMAIL_API_KEY": "ms_...",
        "MEPMAIL_BASE_URL": "https://api.mepmail.dev"
      }
    }
  }
}`;
const API_EXAMPLE = `curl https://api.mepmail.dev/emails \\
  -H "Authorization: Bearer $MEPMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "Your app <hello@your-domain.com>",
    "to": ["recipient@example.com"],
    "subject": "Hello from MepMail",
    "html": "<p>Your next email starts here.</p>"
  }'`;

type FaqItem = { q: string; a: string };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("landing");
  return {
    title: { absolute: t("meta.title") },
    description: t("meta.description"),
    alternates: { canonical: "/" },
    robots: { index: true, follow: true },
    openGraph: {
      title: t("meta.title"),
      description: t("meta.description"),
      type: "website",
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

export default async function RootPage() {
  const locale = await getLocale();
  const t = await getTranslations("landing");
  const mail = await getTranslations("correio");
  const launchOfferEnabled = process.env.SEND_LAUNCH_OFFER_ENABLED === "true";
  // The Correio section and announcement follow the same switch as /correio.
  const mailOpen = process.env.MAILBOX_EARLY_ACCESS_OPEN === "true";
  const mailFrom = formatUsd(
    Math.min(...LAUNCH_OFFER.mailboxes.map((box) => box.monthlyCents)) / 100,
    locale,
  );
  const priceRows = priceRowsForOffer(launchOfferEnabled);
  const comparison = priceRows.map((row) => [
    formatVolume(row.volume, locale),
    formatUsd(row.mepmail, locale),
    formatUsd(row.resend, locale),
    formatUsd(row.sendgrid, locale),
    formatUsd(row.postmark, locale),
    formatUsd(row.mailgun, locale),
    row.savings,
  ]);
  const site = {
    skip: t("skip"),
    brandAria: t("brandAria"),
    navAria: t("navAria"),
    langAria: t("lang.aria"),
    nav: t.raw("nav"),
    footer: t.raw("footer"),
  } as PublicSiteLabels;
  const cardLabels = {
    perMonth: t("plans.perMonth"),
    limitsLabel: t("plans.limitsLabel"),
    overageLabel: t("plans.overageLabel"),
    attachmentLabel: t("plans.attachmentLabel"),
    cta: t("plans.cta"),
    ctaNote: t("plans.ctaNote"),
    featuredBadge: t("plans.featuredBadge"),
  } satisfies PlanCardLabels;
  const allPlans = plansWithCopy(
    t.raw("plans.items") as PlanCopy[],
    launchOfferEnabled,
    t("plans.launchPriceNote"),
  );
  const points = t.raw("structure.points") as string[];
  const columns = t.raw("compare.columns") as string[];
  const steps = t.raw("how.items") as string[];
  const faq = t.raw("faq.items") as FaqItem[];
  const calc = t.raw("calc") as CalcLabels;
  const mcpPoints = t.raw("mcp.points") as string[];
  const correioPoints = t.raw("correio.points") as string[];

  return (
    <div className="gtm cro">
      <ArrivalTracker />
      <LandingMotion />
      <PublicHeader
        labels={site}
        page="landing"
        banner={
          <a className="gtm-announce" href={mailOpen ? "/correio" : "#mcp"}>
            <span className="gtm-announce-dot" aria-hidden="true" />
            <span>{t(mailOpen ? "announce.correio" : "announce.text")}</span>
            <span aria-hidden="true">→</span>
          </a>
        }
      />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container gtm-hero-grid">
            <div className="gtm-hero-copy">
              <p className="gtm-eyebrow">{t("hero.eyebrow")}</p>
              <h1>{t("hero.title")}</h1>
              <p className="gtm-lead">{t("hero.lead")}</p>
              <div className="gtm-actions">
                <SignupLink label={t("hero.ctaSignup")} />
                <a className="ms-btn ms-btn-secondary gtm-action" href="#product">
                  {t("hero.ctaPlans")}
                </a>
              </div>
              <p className="gtm-note">{t("hero.note")}</p>
              {proOffer && (
                <p className="cro-offer">
                  {t(launchOfferEnabled ? "hero.launchOffer" : "hero.offer", {
                    volume: new Intl.NumberFormat(locale).format(proOffer.included),
                    price: formatUsd(
                      (launchOfferEnabled
                        ? LAUNCH_OFFER.sending.monthlyCents
                        : proOffer.priceCents) / 100,
                      locale,
                    ),
                  })}
                  {/* A no-break space keeps the arrow on the sentence's last line. */}
                  {"\u00a0"}
                  <a href="#planos" aria-label={t("nav.plans")}>
                    ↗
                  </a>
                </p>
              )}
            </div>
            <figure className="cro-hero-proof">
              <div className="cro-proof-label">
                <span aria-hidden="true" />
                MepMail / templates
              </div>
              <PublicStarterGallery compact />
              <figcaption>{t("productProof.caption")}</figcaption>
            </figure>
          </div>
        </section>

        <section className="gtm-stack" aria-label={t("stack.aria")}>
          <div className="gtm-container gtm-stack-inner">
            <p className="gtm-stack-eyebrow">{t("stack.eyebrow")}</p>
            <StackLogoRow slugs={stackSlugs} />
            <p className="gtm-stack-note">
              {t("stack.note")}{" "}
              <a className="gtm-stack-cta" href="/integrations">
                {t("stack.pageCta")}
              </a>
            </p>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="product">
          <div className="gtm-container">
            <div className="cro-product-intro">
              <div>
                <p className="gtm-eyebrow">{t("structure.eyebrow")}</p>
                <h2>{t("structure.title")}</h2>
                <p>{t("structure.body")}</p>
              </div>
              <ol className="cro-benefits">
                {points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ol>
            </div>
            <figure className="cro-product-proof">
              <PublicStarterGallery />
              <figcaption>{t("productProof.caption")}</figcaption>
            </figure>
            <p className="cro-product-next">
              {t("productProof.detail")}{" "}
              <a className="ms-btn ms-btn-primary gtm-action" href="/templates/new">
                {t("productProof.viewAll")}
              </a>
            </p>
          </div>
        </section>

        <section className="gtm-section" id="integration">
          <div className="gtm-container cro-integration-grid">
            <div>
              <p className="gtm-eyebrow">{t("integration.eyebrow")}</p>
              <h2>{t("integration.title")}</h2>
              <p>{t("integration.example")}</p>
              <p className="gtm-note">
                {t("hero.migrate")}{" "}
                <a href="/alternatives/resend">{t("integration.migrationCta")} →</a>
              </p>
            </div>
            <IntegrationTabs
              label={t("integration.aria")}
              tabs={[
                {
                  label: t("integration.api"),
                  content: (
                    <pre>
                      <code>{API_EXAMPLE}</code>
                    </pre>
                  ),
                },
                {
                  label: t("integration.smtp"),
                  content: (
                    <>
                      <p>{t("integration.smtpBody")}</p>
                      <pre>
                        <code>{"smtp.mepmail.dev\nPort: 2587\nSecurity: STARTTLS"}</code>
                      </pre>
                    </>
                  ),
                },
                {
                  label: t("integration.agents"),
                  content: (
                    <>
                      <p>{t("integration.agentsBody")}</p>
                      <pre>
                        <code>npx -y @mepmail/mcp</code>
                      </pre>
                      <a href="#mcp">{t("integration.agentsCta")} →</a>
                    </>
                  ),
                },
              ]}
            />
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="mcp">
          <div className="gtm-container gtm-mcp-grid">
            <div>
              <p className="gtm-eyebrow">{t("mcp.eyebrow")}</p>
              <h2>{t("mcp.title")}</h2>
              <p>{t.rich("mcp.body", { b: (chunks) => <strong>{chunks}</strong> })}</p>
              <ul className="gtm-points">
                {mcpPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <SignupLink label={t("mcp.cta")} />
            </div>
            <figure className="gtm-mcp-demo">
              <div className="gtm-demo-window">
                <div className="gtm-demo-bar">
                  <span className="gtm-demo-file">mcp.json</span>
                  <McpConfigCopy value={MCP_CONFIG} />
                </div>
                <pre className="gtm-demo-code">{MCP_CONFIG}</pre>
              </div>
              <figcaption className="gtm-demo-caption">{t("mcp.caption")}</figcaption>
            </figure>
          </div>
        </section>

        {mailOpen ? (
          <section
            className="gtm-section cro-correio"
            id="correio"
            aria-labelledby="home-correio-title"
          >
            <div className="gtm-container">
              <div className="cro-correio-card">
                <div>
                  <p className="gtm-eyebrow">
                    <span className="cro-correio-new">{t("correio.badge")}</span>
                    {t("correio.eyebrow")}
                  </p>
                  <h2 id="home-correio-title">{t("correio.title")}</h2>
                  <p>{t("correio.body")}</p>
                  <ul className="gtm-points">
                    {correioPoints.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                  <p className="cro-correio-price">{t("correio.price", { price: mailFrom })}</p>
                  <div className="gtm-actions">
                    <a className="ms-btn ms-btn-primary gtm-action" href="/correio">
                      {t("correio.cta")} <span aria-hidden="true">→</span>
                    </a>
                    <a className="ms-btn ms-btn-secondary gtm-action" href="/pricing#correio">
                      {t("correio.pricing")}
                    </a>
                  </div>
                </div>
                <AgentDemo labels={mail.raw("demo") as AgentDemoLabels} compact />
              </div>
            </div>
          </section>
        ) : null}

        <section className="gtm-section cro-value">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("deliverability.eyebrow")}</p>
            <h2>{t("deliverability.title")}</h2>
            <p>
              {t.rich("deliverability.body", {
                api: (chunks) => <code>{chunks}</code>,
                smtp: (chunks) => <code>{chunks}</code>,
              })}
            </p>
            <p className="gtm-note">{t("deliverability.note")}</p>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="planos">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("plans.eyebrow")}</p>
            <h2>{t("plans.title")}</h2>
            <p>{t("plans.intro")}</p>
            <div className="gtm-plan-grid">
              {allPlans.slice(0, 3).map((plan) => (
                <PlanCard key={plan.name} plan={plan} labels={cardLabels} />
              ))}
            </div>
            <details className="gtm-plans-more">
              <summary>{t("plans.showScale")}</summary>
              <div className="gtm-plan-grid">
                {allPlans.slice(3).map((plan) => (
                  <PlanCard key={plan.name} plan={plan} labels={cardLabels} />
                ))}
              </div>
            </details>
            <p>
              <a href="/pricing">{t("productProof.allPlans")} →</a>
            </p>
            <p className="gtm-note">{t("plans.note")}</p>
            <p className="gtm-note">{t("plans.noteAttach")}</p>
          </div>
        </section>

        <section className="gtm-section" id="comparativo">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("compare.eyebrow")}</p>
            <h2>{t("compare.title")}</h2>
            <p>{t("compare.intro")}</p>
            <LandingCalculator labels={{ ...calc, contact }} rows={priceRows} />
            <details className="cro-comparison">
              <summary>{t("integration.tableSummary")}</summary>
              <section
                className="gtm-table-scroll"
                aria-label={t("compare.tableAria")}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: foco permite rolar a tabela por teclado
                tabIndex={0}
              >
                <table className="gtm-table">
                  <thead>
                    <tr>
                      {columns.map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.map(([volume, ...values]) => (
                      <tr key={volume}>
                        <th scope="row">{volume}</th>
                        {values.map((value, index) => (
                          <td key={cellKeys[index]}>{value}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <p className="gtm-note">{t("compare.slideNote")}</p>
            </details>
            <p className="gtm-note">{t("compare.refNote")}</p>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="como-funciona">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("how.eyebrow")}</p>
            <h2>{t("how.title")}</h2>
            <ol className="gtm-steps">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="gtm-note">{t("how.note")}</p>
            <SignupLink label={t("hero.ctaSignup")} />
          </div>
        </section>
        <section className="gtm-section">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("faq.eyebrow")}</p>
            <h2>{t("faq.title")}</h2>
            <div className="gtm-faq">
              {faq.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
        <section className="gtm-section gtm-alt gtm-close">
          <div className="gtm-container">
            <h2>{t("close.title")}</h2>
            <p>{t("close.body")}</p>
            <SignupLink label={t("close.cta")} />
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="landing" contact={contact} legal={legalLinks()} />
    </div>
  );
}
