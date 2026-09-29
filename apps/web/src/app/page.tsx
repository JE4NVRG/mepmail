import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CodeDemo } from "@/components/code-demo";
import { type CalcLabels, LandingCalculator } from "@/components/landing-calculator";
import { PlanCard, type PlanCardLabels } from "@/components/plan-card";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { StackLogoRow } from "@/components/stack-logos";
import { type PlanCopy, plansWithCopy } from "@/lib/landing-plans";
import { formatUsd, formatVolume, PRICE_ROWS } from "@/lib/landing-pricing";
import { legalLinks } from "@/lib/legal-links";
import { HOME_STACK_LOGOS, MCP_CHIP } from "@/lib/stack-logos";
import { hasSession } from "@/server/auth";
import "./landing-calc.css";
import "./landing.css";

const contact = "mailto:jean@je4ndev.com";

const cellKeys = ["MepMail", "Resend", "SendGrid", "Postmark", "Mailgun", "vantagem"] as const;

/** The landing strip: the surfaces we ship, plus the drawn MCP chip. */
const stackSlugs = [...HOME_STACK_LOGOS.map((logo) => logo.slug), MCP_CHIP];

const MCP_CONFIG = `{
  "mcpServers": {
    "mepmail": {
      "command": "npx",
      "args": ["-y", "@mepmail/mcp"],
      "env": {
        "MEPMAIL_API_KEY": "ms_...",
        "MEPMAIL_BASE_URL": "https://api-mepmail.je4ndev.com"
      }
    }
  }
}`;

type FaqItem = { q: string; a: string };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("landing");
  const description = t("meta.description");
  return {
    title: { absolute: t("meta.title") },
    description,
    robots: { index: true, follow: true },
    openGraph: {
      title: t("meta.title"),
      description,
      type: "website",
      images: [{ url: "/og.png", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

export default async function RootPage() {
  if (await hasSession()) redirect("/emails");

  const locale = await getLocale();
  const t = await getTranslations("landing");
  // The public table is rendered per locale: shared numbers, locale separators
  // and quote word (see @/lib/landing-pricing). English is the global default.
  const comparison = PRICE_ROWS.map((row) => [
    formatVolume(row.volume, locale),
    formatUsd(row.mepmail, locale),
    formatUsd(row.resend, locale),
    formatUsd(row.sendgrid, locale),
    formatUsd(row.postmark, locale),
    formatUsd(row.mailgun, locale),
    row.savings,
  ]);
  // Chrome + plan copy live in the "landing" catalog: it is the public site's
  // catalog, shared by the landing, /pricing and /alternatives/resend.
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
  const allPlans = plansWithCopy(t.raw("plans.items") as PlanCopy[]);
  const points = t.raw("structure.points") as string[];
  const columns = t.raw("compare.columns") as string[];
  const steps = t.raw("how.items") as string[];
  const faq = t.raw("faq.items") as FaqItem[];
  const calc = t.raw("calc") as CalcLabels;
  const trust = t.raw("hero.trust") as string[];
  const mcpPoints = t.raw("mcp.points") as string[];
  const founders = t.raw("plans.founders") as {
    title: string;
    items: string[];
    note: string;
    cta: string;
  };

  return (
    <div className="gtm">
      <PublicHeader
        labels={site}
        page="landing"
        banner={
          <a className="gtm-announce" href="#mcp">
            <span className="gtm-announce-dot" aria-hidden="true" />
            <span>{t("announce.text")}</span>
            <span aria-hidden="true">→</span>
          </a>
        }
      />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container">
            <div className="gtm-hero-grid">
              <div className="gtm-hero-copy">
                <p className="gtm-eyebrow">
                  {t.rich("hero.eyebrow", {
                    badge: (chunks) => <span className="gtm-beta-badge">{chunks}</span>,
                  })}
                </p>
                <h1>
                  {t.rich("hero.title", {
                    highlight: (chunks) => <span>{chunks}</span>,
                  })}
                </h1>
                <p className="gtm-lead">{t("hero.lead")}</p>
                <div className="gtm-actions">
                  <SignupLink label={t("hero.ctaSignup")} />
                  <a className="ms-btn ms-btn-secondary gtm-action" href="#planos">
                    {t("hero.ctaPlans")}
                  </a>
                </div>
                <p className="gtm-note">{t("hero.note")}</p>
                <p className="gtm-migrate">{t("hero.migrate")}</p>
              </div>
              <CodeDemo subject={t("hero.demo.subject")} caption={t("hero.demo.caption")} />
            </div>
            <ul className="gtm-trust">
              {trust.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
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

        <section className="gtm-section gtm-alt" id="comparativo">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("compare.eyebrow")}</p>
            <h2>{t("compare.title")}</h2>
            <p>{t("compare.intro")}</p>
            <section
              className="gtm-table-scroll"
              aria-label={t("compare.tableAria")}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a tabela com overflow precisa de foco para rolagem por teclado
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
            <LandingCalculator labels={{ ...calc, contact }} />
            <p className="gtm-note">{t("compare.refNote")}</p>
          </div>
        </section>

        {/* Seção do produto: alvo real do item "Product" da nav v2 (nav_rows==1). */}
        <section className="gtm-section" id="product">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("structure.eyebrow")}</p>
            <h2>{t("structure.title")}</h2>
            <p>{t("structure.body")}</p>
            <ul className="gtm-points">
              {points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="planos">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("plans.eyebrow")}</p>
            <h2>{t("plans.title")}</h2>
            <p>{t("plans.intro")}</p>
            <div className="gtm-plan-grid">
              {allPlans
                .filter((plan) => plan.tier === "core")
                .map((plan) => (
                  <PlanCard key={plan.name} plan={plan} labels={cardLabels} />
                ))}
            </div>
            <details className="gtm-plans-more">
              <summary>{t("plans.showScale")}</summary>
              <div className="gtm-plan-grid">
                {allPlans
                  .filter((plan) => plan.tier === "scale")
                  .map((plan) => (
                    <PlanCard key={plan.name} plan={plan} labels={cardLabels} />
                  ))}
              </div>
            </details>
            <p className="gtm-note">{t("plans.note")}</p>
            <div className="gtm-founders">
              <h3>{founders.title}</h3>
              <ul>
                {founders.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="gtm-note">{founders.note}</p>
              <SignupLink label={founders.cta} />
            </div>
            <p className="gtm-note">{t("plans.noteAttach")}</p>
          </div>
        </section>

        <section className="gtm-section" id="como-funciona">
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
                <div className="gtm-demo-bar" aria-hidden="true">
                  <span className="gtm-demo-dot" />
                  <span className="gtm-demo-dot" />
                  <span className="gtm-demo-dot" />
                  <span className="gtm-demo-file">mcp.json</span>
                </div>
                <pre className="gtm-demo-code">{MCP_CONFIG}</pre>
              </div>
              <figcaption className="gtm-demo-caption">{t("mcp.caption")}</figcaption>
            </figure>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
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
