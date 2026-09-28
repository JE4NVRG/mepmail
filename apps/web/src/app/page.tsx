import { env } from "@millionsend/config";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { type CalcLabels, LandingCalculator } from "@/components/landing-calculator";
import { LandingLangSwitch } from "@/components/landing-lang-switch";
import { LandingNav } from "@/components/landing-nav";
import { SignupCta } from "@/components/signup-cta";
import { formatUsd, PRICE_ROWS } from "@/lib/landing-pricing";
import { hasSession } from "@/server/auth";
import "./landing-calc.css";
import "./landing.css";

const contact = "mailto:jean@je4ndev.com";
const legal = {
  termsUrl: env.TERMS_URL ?? "/terms",
  privacyUrl: env.PRIVACY_URL ?? "/privacy",
  refundUrl: "/refund",
};

const comparison = PRICE_ROWS.map((row) => [
  row.label,
  formatUsd(row.mepmail),
  formatUsd(row.resend),
  formatUsd(row.sendgrid),
  formatUsd(row.postmark),
  formatUsd(row.mailgun),
  row.savings,
]);

const cellKeys = ["MepMail", "Resend", "SendGrid", "Postmark", "Mailgun", "vantagem"] as const;

type Plan = {
  name: string;
  price: string;
  tier: "core" | "scale";
  featured?: boolean;
};

const plans: readonly Plan[] = [
  { name: "Free", price: "US$ 0", tier: "core" },
  { name: "Starter", price: "US$ 9", tier: "core" },
  { name: "Pro 100K", price: "US$ 20", tier: "core", featured: true },
  { name: "Pro 200K", price: "US$ 100", tier: "core" },
  { name: "Scale 500K", price: "US$ 199", tier: "scale" },
  { name: "Scale 1M", price: "US$ 319", tier: "scale" },
  { name: "Scale 1.5M", price: "US$ 429", tier: "scale" },
  { name: "Scale 2.5M", price: "US$ 549", tier: "scale" },
];

type PlanCopy = {
  volume: string;
  limits: string;
  overage: string;
  attachment: string;
  cta?: string;
};
type FaqItem = { q: string; a: string };

const EMPTY_PLAN_COPY: PlanCopy = { volume: "", limits: "", overage: "", attachment: "" };

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

function Wordmark() {
  return (
    <span className="gtm-wordmark">
      <img
        className="gtm-wordmark-dark"
        src="/logo/mepmail-wordmark.svg"
        alt=""
        width="143"
        height="20"
      />
      <img
        className="gtm-wordmark-light"
        src="/logo/mepmail-wordmark-light.svg"
        alt=""
        width="143"
        height="20"
      />
    </span>
  );
}

// CTA de criação de conta da landing. Todas as ocorrências (topo, hero, cards
// de plano e rodapé) passam pelo mesmo componente — um único ponto dispara o
// evento de conversão `signup-cta`.
function SignupLink({
  label,
  className = "ms-btn ms-btn-primary gtm-action",
}: {
  label: string;
  className?: string;
}) {
  return <SignupCta className={className} label={label} />;
}

function CodeDemo({ subject, caption }: { subject: string; caption: string }) {
  return (
    <figure className="gtm-hero-demo">
      <div className="gtm-demo-window">
        <div className="gtm-demo-bar" aria-hidden="true">
          <span className="gtm-demo-dot" />
          <span className="gtm-demo-dot" />
          <span className="gtm-demo-dot" />
          <span className="gtm-demo-file">send.ts</span>
        </div>
        <pre className="gtm-demo-code">
          <code>
            <span className="gtm-k">import</span> {"{ Resend }"} <span className="gtm-k">from</span>{" "}
            <span className="gtm-s">&quot;resend&quot;</span>;{"\n\n"}
            <span className="gtm-k">const</span> resend = <span className="gtm-k">new</span> Resend(
            <span className="gtm-s">&quot;ms_…&quot;</span>, {"{"}
            {"\n  "}baseUrl:{" "}
            <span className="gtm-s">&quot;https://api-mepmail.je4ndev.com&quot;</span>,{"\n"}
            {"}"});{"\n\n"}
            <span className="gtm-k">await</span> resend.emails.send({"{"}
            {"\n  "}from: &quot;Acme &lt;onboarding@acme.dev&gt;&quot;,{"\n"}
            {"  "}to: <span className="gtm-s">&quot;delivered@example.com&quot;</span>,{"\n"}
            {"  "}subject: <span className="gtm-s">&quot;{subject}&quot;</span>,{"\n"}
            {"}"});{"\n"}
          </code>
        </pre>
        <div className="gtm-demo-response">
          <span className="gtm-demo-status">200 OK</span>
          <code>{'{ "id": "a1b2c3d4-…" }'}</code>
        </div>
      </div>
      <figcaption className="gtm-demo-caption">{caption}</figcaption>
    </figure>
  );
}

export default async function RootPage() {
  if (await hasSession()) redirect("/emails");

  const t = await getTranslations("landing");
  const planCopy = t.raw("plans.items") as PlanCopy[];
  const points = t.raw("structure.points") as string[];
  const columns = t.raw("compare.columns") as string[];
  const steps = t.raw("how.items") as string[];
  const faq = t.raw("faq.items") as FaqItem[];
  const calc = t.raw("calc") as CalcLabels;
  const trust = t.raw("hero.trust") as string[];
  const mcpPoints = t.raw("mcp.points") as string[];
  const footerPoints = t.raw("footer.points") as string[];
  const founders = t.raw("plans.founders") as {
    title: string;
    items: string[];
    note: string;
    cta: string;
  };
  const allPlans = plans.map((plan, index) => ({
    ...plan,
    copy: planCopy[index] ?? EMPTY_PLAN_COPY,
  }));

  const renderPlan = (plan: (typeof allPlans)[number]) => (
    <article className={`ms-card gtm-plan${plan.featured ? " is-featured" : ""}`} key={plan.name}>
      {plan.featured ? <span className="gtm-plan-badge">{t("plans.featuredBadge")}</span> : null}
      <h3>{plan.name}</h3>
      <p className="gtm-price">
        {plan.price}
        <span>{t("plans.perMonth")}</span>
      </p>
      <p className="gtm-volume">{plan.copy.volume}</p>
      <dl>
        <div>
          <dt>{t("plans.limitsLabel")}</dt>
          <dd>{plan.copy.limits}</dd>
        </div>
        <div>
          <dt>{t("plans.overageLabel")}</dt>
          <dd>{plan.copy.overage}</dd>
        </div>
        <div>
          <dt>{t("plans.attachmentLabel")}</dt>
          <dd>{plan.copy.attachment}</dd>
        </div>
      </dl>
      <SignupLink label={plan.copy.cta ?? t("plans.cta")} />
      {plan.price !== "US$ 0" ? <p className="gtm-cta-note">{t("plans.ctaNote")}</p> : null}
    </article>
  );

  return (
    <div className="gtm">
      <a className="gtm-skip" href="#conteudo">
        {t("skip")}
      </a>
      <a className="gtm-announce" href="#mcp">
        <span className="gtm-announce-dot" aria-hidden="true" />
        <span>{t("announce.text")}</span>
        <span aria-hidden="true">→</span>
      </a>
      <header className="gtm-header">
        <div className="gtm-container gtm-header-inner">
          <div className="gtm-brand-group">
            <a className="gtm-brand" href="/" aria-label={t("brandAria")}>
              <Wordmark />
            </a>
            <span className="gtm-brand-badge">
              <span className="gtm-brand-dot" aria-hidden="true" />
              {t("nav.badge")}
            </span>
          </div>
          <LandingNav label={t("navAria")} menuLabel={t("nav.menu")}>
            <div className="gtm-nav-links">
              <a href="#comparativo">{t("nav.compare")}</a>
              <a href="#planos">{t("nav.plans")}</a>
              <a href="#mcp">{t("nav.mcp")}</a>
              <a href="#como-funciona">{t("nav.how")}</a>
            </div>
            <div className="gtm-nav-actions">
              <LandingLangSwitch label={t("lang.aria")} />
              <span className="gtm-nav-divider" aria-hidden="true" />
              <a className="gtm-nav-login" href="/login">
                {t("nav.login")}
              </a>
            </div>
          </LandingNav>
          {/* A CTA fica FORA da .gtm-nav: ela precisa continuar visível na 1ª
              linha do header quando a nav colapsa no mobile (ver landing.css). */}
          <div className="gtm-header-cta">
            <SignupLink label={t("nav.signup")} />
          </div>
        </div>
      </header>
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

        <section className="gtm-section">
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
              {allPlans.filter((plan) => plan.tier === "core").map(renderPlan)}
            </div>
            <details className="gtm-plans-more">
              <summary>{t("plans.showScale")}</summary>
              <div className="gtm-plan-grid">
                {allPlans.filter((plan) => plan.tier === "scale").map(renderPlan)}
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
      <footer className="gtm-footer">
        <div className="gtm-container gtm-footer-grid">
          <div className="gtm-footer-brand">
            <a className="gtm-brand" href="/" aria-label={t("brandAria")}>
              <Wordmark />
            </a>
            <p>{t("footer.tagline")}</p>
            <ul className="gtm-footer-points">
              {footerPoints.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <SignupLink label={t("footer.cta")} />
          </div>
          <nav className="gtm-footer-col" aria-label={t("footer.colProduct")}>
            <h3>{t("footer.colProduct")}</h3>
            <a href="#comparativo">{t("nav.compare")}</a>
            <a href="#planos">{t("nav.plans")}</a>
            <a href="#mcp">{t("nav.mcp")}</a>
            <a href="#como-funciona">{t("nav.how")}</a>
          </nav>
          <nav className="gtm-footer-col" aria-label={t("footer.colAccount")}>
            <h3>{t("footer.colAccount")}</h3>
            <SignupCta label={t("nav.signup")} />
            <a href="/login">{t("footer.login")}</a>
            <a href={contact}>{t("footer.contact")}</a>
          </nav>
          <nav className="gtm-footer-col" aria-label={t("footer.colLegal")}>
            <h3>{t("footer.colLegal")}</h3>
            <a href={legal.termsUrl}>{t("footer.terms")}</a>
            <a href={legal.privacyUrl}>{t("footer.privacy")}</a>
            <a href={legal.refundUrl}>{t("footer.refund")}</a>
          </nav>
        </div>
        <div className="gtm-container gtm-footer-base">
          <p>{t("footer.rights")}</p>
          <a
            className="gtm-footer-gh"
            href="https://github.com/je4ndev"
            target="_blank"
            rel="noreferrer"
          >
            <span className="gtm-sr-only">{t("footer.ghAria")}</span>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.31 9.31 0 0 1 12 6.98c.85 0 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.07.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.59.69.49A10.13 10.13 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
            </svg>
          </a>
          <p className="gtm-footer-credit">
            {t("footer.credit")}{" "}
            <a href="https://github.com/je4ndev" target="_blank" rel="noreferrer">
              Je4nDev
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
