import { CHECKS, WEBHOOK_EVENT_TYPES } from "@millionsend/core";
import { MCP_TOOLS } from "@millionsend/core/mcp-tools";
import { PLAN_RUNGS } from "@millionsend/core/plans";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { IntegrationTabs } from "@/components/integration-tabs";
import { PlanCard, type PlanCardLabels } from "@/components/plan-card";
import { DocsLink, GithubLink, McpConfigCopy } from "@/components/public-events";
import { PublicStarterGallery } from "@/components/public-starter-gallery";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { StructuredData } from "@/components/structured-data";
import { DOCS_URL } from "@/lib/docs-links";
import { type PlanCopy, plansWithCopy } from "@/lib/landing-plans";
import {
  COMPARISON_FX,
  comparisonRowsForLocale,
  formatBrlPrice,
  formatUsd,
  formatVolume,
  formatWholeComparisonPrice,
} from "@/lib/landing-pricing";
import { legalLinks } from "@/lib/legal-links";
import { faqJsonLd } from "@/lib/structured-data";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "../landing-cro.css";
import "../site-v2.css";

const canonical = "/envio";
const contact = "mailto:suporte@mepmail.dev";
const REPO_URL = "https://github.com/JE4NVRG/mepmail";
/** The comparison row the price proof quotes: Scale 550K, where the gap is widest to read. */
const PROOF_VOLUME = 550_000;
/** Webhook events shown as chips; each one is checked against the real event list. */
const WEBHOOK_CHIPS = [
  "email.sent",
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "quota.warning",
] as const;
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
const ENV_EXAMPLE = `# Os SDKs oficiais do Resend leem estas duas variáveis
RESEND_API_KEY=ms_...
RESEND_BASE_URL=https://api.mepmail.dev`;
const ENV_EXAMPLE_EN = `# The official Resend SDKs read these two variables
RESEND_API_KEY=ms_...
RESEND_BASE_URL=https://api.mepmail.dev`;
const CURL_EXAMPLE = `curl https://api.mepmail.dev/emails \\
  -H "Authorization: Bearer $MEPMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "Loja <pedidos@sualoja.com.br>",
    "to": ["ana@exemplo.com"],
    "subject": "Pedido 4812 confirmado",
    "html": "<p>Recebemos o seu pedido.</p>"
  }'`;
const SMTP_EXAMPLE = `Servidor: smtp.mepmail.dev
Porta:    2587 (STARTTLS)
Usuário e senha: Configurações → SMTP`;
const SMTP_EXAMPLE_EN = `Server:   smtp.mepmail.dev
Port:     2587 (STARTTLS)
Username and password: Settings → SMTP`;

type FaqItem = { q: string; a: string };
type InsightItem = { status: "ok" | "warn" | "info"; label: string };

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls(canonical);
  const t = await getTranslations("envio");
  const title = t("meta.title");
  const description = t("meta.description", { checks: CHECKS.length });
  return {
    title: { absolute: title },
    description,
    alternates: seo.alternates,
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description,
      type: "website",
      url: seo.url,
      locale: seo.ogLocale,
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/** The diff the hero shows: two lines of the official SDK change, nothing else. */
function ResendDiff({ brazil }: { brazil: boolean }) {
  return (
    <pre>
      <span className="v2-code-line v2-code-dim">import {"{ Resend }"} from "resend";</span>
      <span className="v2-code-line"> </span>
      <span className="v2-code-line v2-code-del">- const resend = new Resend("re_…");</span>
      <span className="v2-code-line v2-code-add">+ const resend = new Resend("ms_…", {"{"}</span>
      <span className="v2-code-line v2-code-add">{'+   baseUrl: "https://api.mepmail.dev",'}</span>
      <span className="v2-code-line v2-code-add">+ {"});"}</span>
      <span className="v2-code-line"> </span>
      <span className="v2-code-line">await resend.emails.send({"{"}</span>
      <span className="v2-code-line">
        {brazil
          ? '  from: "Loja <pedidos@sualoja.com.br>",'
          : '  from: "Shop <orders@yourshop.com>",'}
      </span>
      <span className="v2-code-line">
        {brazil ? '  to: ["ana@exemplo.com"],' : '  to: ["ana@example.com"],'}
      </span>
      <span className="v2-code-line">
        {brazil ? '  subject: "Pedido 4812 confirmado",' : '  subject: "Order 4812 confirmed",'}
      </span>
      <span className="v2-code-line">{"});"}</span>
    </pre>
  );
}

function Snippet({ children }: { children: ReactNode }) {
  return <pre className="v2-snippet">{children}</pre>;
}

export default async function EnvioPage() {
  const [t, l, locale] = await Promise.all([
    getTranslations("envio"),
    getTranslations("landing"),
    getLocale(),
  ]);
  const brazil = locale === "pt-BR";
  const launchOfferEnabled = process.env.SEND_LAUNCH_OFFER_ENABLED === "true";
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const cardLabels = {
    perMonth: l("plans.perMonth"),
    limitsLabel: l("plans.limitsLabel"),
    overageLabel: l("plans.overageLabel"),
    attachmentLabel: l("plans.attachmentLabel"),
    cta: l("plans.cta"),
    ctaNote: l("plans.ctaNote"),
    featuredBadge: l("plans.featuredBadge"),
  } satisfies PlanCardLabels;
  const allPlans = plansWithCopy(
    l.raw("plans.items") as PlanCopy[],
    launchOfferEnabled,
    l("plans.launchPriceNote"),
    brazil ? "brl" : "usd",
  );
  const free = PLAN_RUNGS.find((rung) => rung.key === "free");
  const starter = PLAN_RUNGS.find((rung) => rung.key === "starter");
  if (!free || !starter) throw new Error("Missing Free or Starter rung");
  const freeVolume = new Intl.NumberFormat(locale).format(free.included);
  const starterPrice = brazil
    ? formatBrlPrice(starter.brlPriceCents, locale)
    : formatUsd(starter.priceCents / 100, locale);
  // The proof quotes the same dated table as /alternatives/resend, never a typed number.
  const proofRow = comparisonRowsForLocale(launchOfferEnabled, locale).find(
    (row) => row.volume === PROOF_VOLUME,
  );
  const proofPlan = allPlans.find((plan) => plan.rung === "scale_500k");
  const webhookChips = WEBHOOK_CHIPS.filter((event) =>
    (WEBHOOK_EVENT_TYPES as readonly string[]).includes(event),
  );
  const insights = t.raw("panel.insights") as InsightItem[];
  const faq = t.raw("faq.items") as FaqItem[];
  const docs = `${DOCS_URL}${brazil ? "/pt-BR" : ""}`;
  const b = (chunks: ReactNode) => <strong className="v2-strong">{chunks}</strong>;

  return (
    <div className="gtm v2">
      <StructuredData graph={[faqJsonLd(faq)]} />
      <PublicHeader labels={site} page="envio" />
      <main id="conteudo">
        {/* Hero: the migration in two lines, in reais for Brazil. */}
        <section className="v2-dark v2-sec" aria-labelledby="envio-title">
          <div className="v2-wrap v2-row">
            <div className="v2-stack">
              <p className="v2-eyebrow v2-eyebrow-mono">{t("hero.eyebrow")}</p>
              <h1 id="envio-title" className="v2-display-sans">
                {t("hero.titleStart")} <span className="v2-accent">{t("hero.titleEnd")}</span>
              </h1>
              <p className="v2-lead">{t("hero.lead")}</p>
              <div className="v2-actions">
                <SignupLink label={t("hero.cta")} className="v2-btn v2-btn-bone" />
                <a className="v2-btn v2-btn-line" href="#migrar">
                  {t("hero.migrate")}
                </a>
              </div>
              <p className="v2-note">
                {t.rich("hero.note", { free: freeVolume, starter: starterPrice, b })}
              </p>
            </div>
            <figure>
              <div className="v2-code">
                <IntegrationTabs
                  label={t("hero.codeAria")}
                  tabs={[
                    { label: "Node", content: <ResendDiff brazil={brazil} /> },
                    { label: ".env", content: <pre>{brazil ? ENV_EXAMPLE : ENV_EXAMPLE_EN}</pre> },
                    { label: "cURL", content: <pre>{CURL_EXAMPLE}</pre> },
                    {
                      label: "SMTP",
                      content: <pre>{brazil ? SMTP_EXAMPLE : SMTP_EXAMPLE_EN}</pre>,
                    },
                  ]}
                />
              </div>
              <figcaption className="v2-fine v2-gap-sm">{t("hero.codeCaption")}</figcaption>
            </figure>
          </div>
        </section>

        {/* Price proof, from the dated comparison table. */}
        {proofRow && proofPlan ? (
          <section className="v2-ground" aria-label={t("proof.cta")}>
            <div className="v2-wrap v2-proof">
              <p className="v2-body">
                {t.rich("proof.lead", { volume: formatVolume(PROOF_VOLUME, locale), b })}
              </p>
              <div className="v2-proof-figures">
                <div>
                  <small>{t("proof.ours", { plan: proofPlan.name })}</small>
                  <strong>{formatWholeComparisonPrice(proofRow.mepmail, locale)}</strong>
                </div>
                <div className="is-them">
                  <small>{t("proof.theirs")}</small>
                  <strong>{formatWholeComparisonPrice(proofRow.resend, locale)}</strong>
                </div>
              </div>
              <a className="v2-link-accent" href="/alternatives/resend">
                {t("proof.cta")} <span aria-hidden="true">→</span>
              </a>
            </div>
          </section>
        ) : null}

        {/* Three ways in. */}
        <section className="v2-dark v2-sec" aria-labelledby="envio-ways-title">
          <div className="v2-wrap">
            <h2 id="envio-ways-title" className="v2-h2-sans">
              {t("ways.title")}
            </h2>
            <div className="v2-grid">
              <article className="v2-card v2-card-raised v2-cell">
                <span className="v2-address">{t("ways.api.kind")}</span>
                <h3 className="v2-h3">{t("ways.api.title")}</h3>
                <Snippet>POST https://api.mepmail.dev/emails</Snippet>
                <p className="v2-body">{t("ways.api.body")}</p>
              </article>
              <article className="v2-card v2-card-raised v2-cell">
                <span className="v2-address">{t("ways.smtp.kind")}</span>
                <h3 className="v2-h3">{t("ways.smtp.title")}</h3>
                <Snippet>smtp.mepmail.dev:2587 · STARTTLS</Snippet>
                <p className="v2-body">{t("ways.smtp.body")}</p>
              </article>
              <article className="v2-card v2-card-raised v2-cell">
                <span className="v2-address">{t("ways.mcp.kind")}</span>
                <h3 className="v2-h3">{t("ways.mcp.title")}</h3>
                <Snippet>https://api.mepmail.dev/mcp</Snippet>
                <p className="v2-body">{t("ways.mcp.body", { tools: MCP_TOOLS.length })}</p>
              </article>
            </div>
          </div>
        </section>

        {/* The dashboard, as a bento of real capabilities. */}
        <section className="v2-ground v2-sec" aria-labelledby="envio-panel-title">
          <div className="v2-wrap">
            <p className="v2-eyebrow v2-eyebrow-mono">{t("panel.eyebrow")}</p>
            <h2 id="envio-panel-title" className="v2-h2-sans">
              {t("panel.title")}
            </h2>
            <div className="v2-grid">
              <figure className="v2-card v2-card-raised v2-cell-wide v2-gallery cro">
                <div>
                  <h3 className="v2-h3">{t("panel.templatesTitle")}</h3>
                  <p className="v2-body v2-gap-sm">{t("panel.templatesBody")}</p>
                </div>
                <PublicStarterGallery compact />
                <figcaption>{l("productProof.caption")}</figcaption>
              </figure>

              <article className="v2-card v2-card-accent v2-cell">
                <h3 className="v2-h3">
                  <span className="v2-stat-num">{CHECKS.length}</span> {t("panel.insightsTitle")}
                </h3>
                <p className="v2-body">{t("panel.insightsBody")}</p>
                <ul className="v2-checks">
                  {insights.map((item) => (
                    <li key={item.label}>
                      <span className={`v2-check-${item.status}`} aria-hidden="true">
                        {item.status === "ok" ? "✓" : item.status === "warn" ? "!" : "○"}
                      </span>
                      {item.label}
                    </li>
                  ))}
                </ul>
                <p className="v2-fine">{t("panel.insightsNote")}</p>
              </article>

              <article className="v2-card v2-cell">
                <h3 className="v2-h3-sm">{t("panel.logsTitle")}</h3>
                <ul className="v2-log" aria-hidden="true">
                  <li>
                    <span className="v2-log-time">10:42:07</span>
                    <span className="v2-log-ok">delivered</span>
                    <span className="v2-log-to">ana@exemplo.com</span>
                  </li>
                  <li>
                    <span className="v2-log-time">10:42:05</span>
                    <span className="v2-log-info">sent</span>
                    <span className="v2-log-to">ana@exemplo.com</span>
                  </li>
                  <li>
                    <span className="v2-log-time">10:39:51</span>
                    <span className="v2-log-bad">bounced</span>
                    <span className="v2-log-to">antigo@exemplo.org</span>
                  </li>
                </ul>
                <p className="v2-body">{t("panel.logsBody")}</p>
              </article>

              <article className="v2-card v2-cell">
                <h3 className="v2-h3-sm">{t("panel.webhooksTitle")}</h3>
                <ul className="v2-chips">
                  {webhookChips.map((event) => (
                    <li key={event} className="v2-chip">
                      {event}
                    </li>
                  ))}
                </ul>
                <p className="v2-body">{t("panel.webhooksBody")}</p>
              </article>

              <article className="v2-card v2-cell">
                <h3 className="v2-h3-sm">{t("panel.audienceTitle")}</h3>
                <p className="v2-body">{t("panel.audienceBody")}</p>
              </article>

              <article className="v2-card v2-cell">
                <h3 className="v2-h3-sm">{t("panel.protectionTitle")}</h3>
                <p className="v2-body">{t("panel.protectionBody")}</p>
              </article>
            </div>
          </div>
        </section>

        {/* Agents */}
        <section className="v2-dark v2-sec" id="mcp" aria-labelledby="envio-agents-title">
          <div className="v2-wrap v2-row">
            <div className="v2-stack">
              <p className="v2-eyebrow v2-eyebrow-mono">{t("agents.eyebrow")}</p>
              <h2 id="envio-agents-title" className="v2-h2-sans">
                {t("agents.title")}
              </h2>
              <p className="v2-body">{t("agents.body")}</p>
              <dl className="v2-card v2-card-raised v2-mono-table">
                <div>
                  <dt>{t("agents.url")}</dt>
                  <dd className="v2-mono">https://api.mepmail.dev/mcp</dd>
                </div>
                <div>
                  <dt>{t("agents.login")}</dt>
                  <dd>{t("agents.loginValue")}</dd>
                </div>
                <div>
                  <dt>{t("agents.tools")}</dt>
                  <dd>{t("agents.toolsValue", { count: MCP_TOOLS.length })}</dd>
                </div>
                <div>
                  <dt>{t("agents.local")}</dt>
                  <dd className="v2-mono">npx -y @mepmail/mcp</dd>
                </div>
              </dl>
            </div>
            <figure>
              <div className="v2-code">
                <div className="v2-code-bar">
                  <span>{t("agents.configFile")}</span>
                  <McpConfigCopy value={MCP_CONFIG} />
                </div>
                <pre>{MCP_CONFIG}</pre>
              </div>
              <figcaption className="v2-fine v2-gap-sm">{t("agents.configCaption")}</figcaption>
            </figure>
          </div>
        </section>

        {/* Migration: a light block to break the rhythm. */}
        <section className="v2-light v2-sec" id="migrar" aria-labelledby="envio-migrate-title">
          <div className="v2-wrap">
            <p className="v2-eyebrow">{t("migrate.eyebrow")}</p>
            <h2 id="envio-migrate-title" className="v2-h2">
              {t("migrate.title")}
            </h2>
            <p className="v2-lead v2-gap">{t("migrate.lead")}</p>
            <ol className="v2-grid">
              <li className="v2-card v2-cell">
                <span className="v2-step-num">1</span>
                <h3 className="v2-h3">{t("migrate.plan.title")}</h3>
                <Snippet>mepmail migrate plan --from resend</Snippet>
                <p className="v2-body">{t("migrate.plan.body")}</p>
              </li>
              <li className="v2-card v2-cell">
                <span className="v2-step-num">2</span>
                <h3 className="v2-h3">{t("migrate.apply.title")}</h3>
                <Snippet>mepmail migrate apply plan.json</Snippet>
                <p className="v2-body">{t("migrate.apply.body")}</p>
              </li>
              <li className="v2-card v2-cell">
                <span className="v2-step-num">3</span>
                <h3 className="v2-h3">{t("migrate.switch.title")}</h3>
                <Snippet>RESEND_BASE_URL=https://api.mepmail.dev</Snippet>
                <p className="v2-body">{t("migrate.switch.body")}</p>
              </li>
            </ol>
            <p className="v2-note v2-gap">
              {t("migrate.honesty")}{" "}
              <DocsLink className="v2-link-accent" href={`${docs}/migrate-from-resend`}>
                {t("migrate.guide")} <span aria-hidden="true">↗</span>
              </DocsLink>
            </p>
          </div>
        </section>

        {/* Open source */}
        <section className="v2-dark v2-sec-tight" aria-labelledby="envio-open-title">
          <div className="v2-wrap v2-row">
            <div className="v2-stack-sm">
              <h2 id="envio-open-title" className="v2-h3 v2-open-title">
                {t("open.title")}
              </h2>
              <p className="v2-body">{t("open.body")}</p>
            </div>
            <div className="v2-actions">
              <GithubLink className="v2-btn v2-btn-line" href={REPO_URL}>
                {t("open.github")} <span aria-hidden="true">↗</span>
              </GithubLink>
              <DocsLink className="v2-btn v2-btn-line" href={`${docs}/self-hosting`}>
                {t("open.selfHost")} <span aria-hidden="true">↗</span>
              </DocsLink>
            </div>
          </div>
        </section>

        {/* Plans */}
        <section className="v2-ground v2-sec" id="planos" aria-labelledby="envio-plans-title">
          <div className="v2-wrap">
            <h2 id="envio-plans-title" className="v2-h2-sans">
              {t("plans.title")}
            </h2>
            <p className="v2-lead v2-gap-sm">{t("plans.lead")}</p>
            <div className="gtm-plan-grid">
              {allPlans.slice(0, 3).map((plan) => (
                <PlanCard key={plan.name} plan={plan} labels={cardLabels} />
              ))}
            </div>
            <p className="v2-note v2-gap">
              {t("plans.more", {
                list: allPlans
                  .slice(3)
                  .map((plan) => `${plan.name} ${plan.price}`)
                  .join(" · "),
              })}{" "}
              <a className="v2-link-accent" href="/pricing#planos">
                {t("plans.all")} <span aria-hidden="true">→</span>
              </a>
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section className="v2-dark v2-sec" aria-labelledby="envio-faq-title">
          <div className="v2-wrap v2-narrow">
            <h2 id="envio-faq-title" className="v2-h2-sans v2-faq-title">
              {t("faq.title")}
            </h2>
            <div className="v2-faq">
              {faq.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Close */}
        <section className="v2-violet v2-sec v2-center" aria-labelledby="envio-close-title">
          <div className="v2-wrap v2-stack">
            <h2 id="envio-close-title" className="v2-display-sans">
              {t("close.title")}
            </h2>
            <p className="v2-lead">{t("close.body", { free: freeVolume })}</p>
            <div className="v2-actions">
              <SignupLink label={t("close.cta")} className="v2-btn v2-btn-bone" />
              <DocsLink className="v2-btn v2-btn-line" href={docs}>
                {t("close.docs")}
              </DocsLink>
            </div>
          </div>
        </section>

        <div className="v2-dark">
          <p className="v2-wrap v2-fine v2-footnote">
            {t("footnote", {
              volume: formatVolume(PROOF_VOLUME, locale),
              date: new Date(`${COMPARISON_FX.date}T12:00:00Z`).toLocaleDateString(locale, {
                timeZone: "UTC",
              }),
              rate: COMPARISON_FX.brlPerUsd.toLocaleString(locale),
            })}
          </p>
        </div>
      </main>
      <PublicFooter labels={site} page="envio" contact={contact} legal={legalLinks()} />
    </div>
  );
}
