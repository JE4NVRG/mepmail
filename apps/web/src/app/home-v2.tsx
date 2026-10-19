import { CHECKS, PLAN_RUNGS } from "@millionsend/core";
import { MCP_TOOLS } from "@millionsend/core/mcp-tools";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ArrivalTracker, DocsLink, GithubLink } from "@/components/public-events";
import { PublicStarterGallery } from "@/components/public-starter-gallery";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { StructuredData } from "@/components/structured-data";
import { WINDOWS_STORE_URL } from "@/lib/desktop-download";
import { MCP_DOCS_URL } from "@/lib/docs-links";
import { type PlanCopy, plansWithCopy } from "@/lib/landing-plans";
import {
  COMPARISON_FX,
  comparisonRowsForLocale,
  formatBrlPrice,
  formatUsd,
  formatVolume,
  formatWholeComparisonPrice,
} from "@/lib/landing-pricing";
import { CORREIO_FROM_BRL_CENTS, CORREIO_FROM_CENTS, LAUNCH_OFFER } from "@/lib/launch-offer";
import { legalLinks } from "@/lib/legal-links";
import { faqJsonLd, organizationJsonLd, siteBaseUrl, websiteJsonLd } from "@/lib/structured-data";
import { titlePhrases } from "@/lib/title-phrases";
import "./landing.css";
import "./landing-cro.css";
import "./site-v2.css";

const contact = "mailto:suporte@mepmail.dev";
const REPO_URL = "https://github.com/JE4NVRG/mepmail";
/** The comparison row the stat quotes (Scale 550K), from the dated table in landing-pricing. */
const PROOF_VOLUME = 550_000;

type FaqItem = { q: string; a: string };
type Tile = { title: string; body: string };
type CheckItem = { status: "ok" | "warn" | "info"; label: string };

/** A headline on one line of text, with the in-word hyphens made non-breaking. */
function headline(title: string): string {
  return titlePhrases(title).join(" ");
}

/** The two lines that change when an app moves from Resend's SDK to MepMail. */
function ResendDiff() {
  return (
    <pre>
      <span className="v2-code-line v2-code-dim">import {"{ Resend }"} from "resend";</span>
      <span className="v2-code-line"> </span>
      <span className="v2-code-line v2-code-del">- const resend = new Resend("re_…");</span>
      <span className="v2-code-line v2-code-add">+ const resend = new Resend("ms_…", {"{"}</span>
      <span className="v2-code-line v2-code-add">{'+   baseUrl: "https://api.mepmail.dev",'}</span>
      <span className="v2-code-line v2-code-add">+ {"});"}</span>
      <span className="v2-code-line"> </span>
      <span className="v2-code-line">
        await resend.emails.send({"{ from, to, subject, html });"}
      </span>
    </pre>
  );
}

/**
 * The home since v2 (Jean, 2026-10-19), while Correio is sold on its own: a split hero
 * (Correio in bone, Envio in black), one verified domain serving both, numbers anyone can
 * check, a block per product, both price ladders and one close. Every price comes from the
 * catalog; every count from the code it describes.
 */
export async function HomeV2() {
  const [t, l, mail, prices, locale] = await Promise.all([
    getTranslations("landing.home"),
    getTranslations("landing"),
    getTranslations("correio"),
    getTranslations("pricing"),
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
  const money = (brlCents: number, usdCents: number) =>
    brazil ? formatBrlPrice(brlCents, locale) : formatUsd(usdCents / 100, locale);
  const mailFrom = money(CORREIO_FROM_BRL_CENTS, CORREIO_FROM_CENTS);
  const correioPlans = LAUNCH_OFFER.correioPlans.map((plan) => ({
    ...plan,
    price: money(plan.brlMonthlyCents, plan.monthlyCents),
  }));
  const duo = correioPlans.find((plan) => plan.id === "duo");
  const equipe = correioPlans.find((plan) => plan.id === "equipe");
  const free = PLAN_RUNGS.find((rung) => rung.key === "free");
  const largest = PLAN_RUNGS[PLAN_RUNGS.length - 1];
  if (!duo || !equipe || !free || !largest) throw new Error("Missing a plan in the catalog");
  const sendLadder = plansWithCopy(
    l.raw("plans.items") as PlanCopy[],
    launchOfferEnabled,
    undefined,
    brazil ? "brl" : "usd",
  )
    .slice(0, 3)
    .map((plan) => {
      const rung = PLAN_RUNGS.find((item) => item.key === plan.rung);
      const amount = new Intl.NumberFormat(locale).format(rung?.included ?? 0);
      return {
        ...plan,
        volume:
          rung?.period === "day"
            ? t("prices.perDay", { amount })
            : t("prices.perMonth", { amount }),
      };
    });
  const firstMonth = money(
    LAUNCH_OFFER.sending.brlFirstMonthlyCents,
    LAUNCH_OFFER.sending.firstMonthlyCents,
  );
  const proofRow = comparisonRowsForLocale(launchOfferEnabled, locale).find(
    (row) => row.volume === PROOF_VOLUME,
  );
  const freeVolume = new Intl.NumberFormat(locale).format(free.included);
  const correioTiles = t.raw("correio.tiles") as Tile[];
  const checks = t.raw("envio.checks") as CheckItem[];
  const faq = t.raw("faq.items") as FaqItem[];
  const base = siteBaseUrl();
  const b = (chunks: ReactNode) => <strong>{chunks}</strong>;

  return (
    <div className="gtm v2">
      <StructuredData
        graph={[organizationJsonLd(base), websiteJsonLd(base, locale), faqJsonLd(faq)]}
      />
      <ArrivalTracker />
      <PublicHeader labels={site} page="landing" />
      <main id="conteudo">
        {/* Two doors, two personalities. */}
        <section className="v2-split" aria-label={t("doorsAria")}>
          <div className="v2-door v2-light">
            <p className="v2-eyebrow">{t("correio.eyebrow")}</p>
            <h1 className="v2-display">{headline(t("correio.title"))}</h1>
            <p className="v2-lead">{t("correio.lead")}</p>
            <div className="v2-actions">
              <SignupLink label={l("domainHero.cta")} className="v2-btn v2-btn-ink" />
              <a className="v2-link" href="#correio">
                {t("correio.more")}
              </a>
            </div>
            <p className="v2-note">{t.rich("correio.note", { price: mailFrom, b })}</p>
            <figure>
              <div className="v2-approval">
                <p className="v2-approval-from">
                  <span className="v2-avatar" aria-hidden="true">
                    AS
                  </span>
                  <span>{t.rich("correio.approvalFrom", { sender: mail("demo.sender"), b })}</span>
                </p>
                <p>{mail("demo.preview")}</p>
                <div className="v2-approval-draft">
                  <small>{mail("demo.agent")}</small>
                  <p>{mail("demo.reply")}</p>
                </div>
                <div className="v2-approval-row">
                  <span className="v2-pill v2-pill-wait">{mail("demo.awaiting")}</span>
                  <span className="v2-fake-button" aria-hidden="true">
                    {mail("demo.approve")}
                  </span>
                </div>
              </div>
              <figcaption className="v2-fine v2-gap-sm">{mail("demo.foot")}</figcaption>
            </figure>
            <p>
              <a className="v2-link-accent" href="/signup?next=/mail">
                {t("correio.noDomain")} <span aria-hidden="true">→</span>
              </a>
            </p>
          </div>

          <div className="v2-door v2-door-dark v2-dark">
            <p className="v2-eyebrow v2-eyebrow-mono">{t("envio.eyebrow")}</p>
            <h2 className="v2-display-sans">{t("envio.title")}</h2>
            <p className="v2-lead">{t("envio.lead")}</p>
            <div className="v2-actions">
              <SignupLink label={t("envio.cta")} className="v2-btn v2-btn-bone" />
              <a className="v2-link" href="#envio">
                {t("envio.more")}
              </a>
            </div>
            <p className="v2-note">{t.rich("envio.note", { free: freeVolume, b })}</p>
            <figure>
              <div className="v2-code">
                <p className="v2-code-bar">
                  <span>send.ts</span>
                  <span>{t("envio.changed")}</span>
                </p>
                <ResendDiff />
              </div>
              <figcaption className="v2-fine v2-gap-sm">
                {l("hero.migrate")}{" "}
                <a className="v2-link-accent" href="/alternatives/resend">
                  {l("integration.migrationCta")} <span aria-hidden="true">→</span>
                </a>
              </figcaption>
            </figure>
          </div>
        </section>

        {/* One verified domain serves both fronts. */}
        <section
          className="v2-ground v2-sec v2-center"
          id="como-funciona"
          aria-labelledby="home-domain-title"
        >
          <div className="v2-wrap">
            <h2 id="home-domain-title" className="v2-h2">
              {t("domain.title")}
            </h2>
            <p className="v2-lead v2-gap-sm">{t("domain.lead")}</p>
            <div className="v2-domain">
              <ul className="v2-domain-side">
                <li className="v2-eyebrow">{t("domain.correio")}</li>
                <li className="v2-domain-box v2-domain-box-light">voce@</li>
                <li className="v2-domain-box v2-domain-box-light">vendas@</li>
                <li className="v2-domain-box v2-domain-box-agent">{t("domain.agentBox")}</li>
              </ul>
              <span className="v2-domain-wire" aria-hidden="true" />
              <div className="v2-domain-hub">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5fce8b"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8 12.5l2.5 2.5L16 9.5" />
                </svg>
                <strong>{t("domain.hub")}</strong>
                <span>{t("domain.hubNote")}</span>
              </div>
              <span className="v2-domain-wire" aria-hidden="true" />
              <ul className="v2-domain-side">
                <li className="v2-eyebrow v2-eyebrow-mono">{t("domain.envio")}</li>
                <li className="v2-domain-box v2-domain-box-dark">{t("domain.boxes.auth")}</li>
                <li className="v2-domain-box v2-domain-box-dark">{t("domain.boxes.orders")}</li>
                <li className="v2-domain-box v2-domain-box-dark">{t("domain.boxes.news")}</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Numbers that anyone can check. */}
        <section className="v2-dark v2-sec-tight" id="comparativo" aria-label={t("stats.aria")}>
          <div className="v2-wrap">
            <div className="v2-stats">
              <p className="v2-stat">
                <span className="v2-stat-num">{CHECKS.length}</span>
                <span className="v2-stat-text">{t("stats.checks")}</span>
              </p>
              <p className="v2-stat">
                <span className="v2-stat-num">{MCP_TOOLS.length}</span>
                <span className="v2-stat-text">{t("stats.mcp")}</span>
              </p>
              {proofRow ? (
                <p className="v2-stat">
                  <span className="v2-stat-num">
                    {formatWholeComparisonPrice(proofRow.mepmail, locale)}
                  </span>
                  <span className="v2-stat-text">
                    {l("compare.homeStat", {
                      volume: formatVolume(PROOF_VOLUME, locale),
                      theirs: formatWholeComparisonPrice(proofRow.resend, locale),
                    })}
                  </span>
                </p>
              ) : null}
              <p className="v2-stat">
                <span className="v2-stat-num">AGPL</span>
                <span className="v2-stat-text">{t("stats.open")}</span>
              </p>
            </div>
            <p className="v2-proof-links">
              <a href={WINDOWS_STORE_URL} target="_blank" rel="noopener noreferrer">
                {t("stats.store")} <span aria-hidden="true">↗</span>
              </a>
              <DocsLink href={MCP_DOCS_URL}>
                {t("stats.mcpDocs")} <span aria-hidden="true">↗</span>
              </DocsLink>
              <GithubLink href={REPO_URL}>
                {t("stats.github")} <span aria-hidden="true">↗</span>
              </GithubLink>
              <a href="/status">{t("stats.status")}</a>
            </p>
            <p className="v2-fine v2-gap-sm">
              {l("compare.homeFootnote", {
                date: new Date(`${COMPARISON_FX.date}T12:00:00Z`).toLocaleDateString(locale, {
                  timeZone: "UTC",
                }),
                rate: COMPARISON_FX.brlPerUsd.toLocaleString(locale),
              })}
            </p>
          </div>
        </section>

        {/* Correio, in bone. */}
        <section className="v2-light v2-sec" id="correio" aria-labelledby="home-correio-title">
          <div className="v2-wrap">
            <p className="v2-eyebrow">{t("correio.blockEyebrow")}</p>
            <h2 id="home-correio-title" className="v2-h2">
              {t("correio.blockTitle")}
            </h2>
            <div className="v2-grid">
              <article className="v2-card v2-cell-wide">
                <h3 className="v2-h3">{t("correio.agentTitle")}</h3>
                <p className="v2-body">{t("correio.agentBody")}</p>
                <ul className="v2-actions">
                  <li className="v2-pill v2-pill-ok">✓ {t("correio.permissions.read")}</li>
                  <li className="v2-pill v2-pill-ok">✓ {t("correio.permissions.draft")}</li>
                  <li className="v2-pill v2-pill-wait">{t("correio.permissions.send")}</li>
                </ul>
              </article>
              <article className="v2-card v2-card-ink v2-cell">
                <p className="v2-eyebrow">{t("correio.priceLabel")}</p>
                <p className="v2-plan-price">{mailFrom}</p>
                <p className="v2-body">
                  {t("correio.priceNote", { duo: duo.price, equipe: equipe.price })}
                </p>
                <a className="v2-link v2-gap-sm" href="/pricing#correio">
                  {t("correio.priceLink")}
                </a>
              </article>
              {correioTiles.map((tile) => (
                <article className="v2-card v2-cell" key={tile.title}>
                  <h3 className="v2-h3-sm">{tile.title}</h3>
                  <p className="v2-body">{tile.body}</p>
                </article>
              ))}
            </div>
            <div className="v2-actions v2-gap-lg">
              <SignupLink label={l("domainHero.cta")} className="v2-btn v2-btn-ink" />
              <a className="v2-btn v2-btn-line" href="/correio">
                {t("correio.cta")}
              </a>
            </div>
          </div>
        </section>

        {/* Envio, in black. */}
        <section className="v2-dark v2-sec" id="envio" aria-labelledby="home-envio-title">
          <div className="v2-wrap" id="product">
            <p className="v2-eyebrow v2-eyebrow-mono">{t("envio.blockEyebrow")}</p>
            <h2 id="home-envio-title" className="v2-h2-sans">
              {t("envio.blockTitle")}
            </h2>
            <div className="v2-grid">
              <figure className="v2-card v2-card-raised v2-cell-wide v2-gallery cro">
                <div>
                  <h3 className="v2-h3">{t("envio.galleryTitle")}</h3>
                  <p className="v2-body v2-gap-sm">{t("envio.galleryBody")}</p>
                </div>
                <PublicStarterGallery compact />
                <figcaption>{l("productProof.caption")}</figcaption>
              </figure>
              <article className="v2-card v2-card-accent v2-cell">
                <h3 className="v2-h3">
                  <span className="v2-stat-num">{CHECKS.length}</span> {t("envio.checksTitle")}
                </h3>
                <ul className="v2-checks">
                  {checks.map((item) => (
                    <li key={item.label}>
                      <span className={`v2-check-${item.status}`} aria-hidden="true">
                        {item.status === "ok" ? "✓" : item.status === "warn" ? "!" : "○"}
                      </span>
                      {item.label}
                    </li>
                  ))}
                </ul>
                <p className="v2-fine">{t("envio.checksNote")}</p>
              </article>
              <article className="v2-card v2-cell">
                <h3 className="v2-h3-sm">{t("envio.webhooksTitle")}</h3>
                <p className="v2-body">{t("envio.webhooksBody")}</p>
              </article>
              <article className="v2-card v2-cell">
                <h3 className="v2-h3-sm">{t("envio.audienceTitle")}</h3>
                <p className="v2-body">{t("envio.audienceBody")}</p>
              </article>
              <article className="v2-card v2-cell">
                <h3 className="v2-h3-sm">{t("envio.protectionTitle")}</h3>
                <p className="v2-body">{t("envio.protectionBody")}</p>
              </article>
              <article className="v2-card v2-cell" id="mcp">
                <h3 className="v2-h3-sm">{t("envio.waysTitle")}</h3>
                <p className="v2-body v2-mono">POST /emails</p>
                <p className="v2-body v2-mono">smtp.mepmail.dev:2587</p>
                <p className="v2-body v2-mono">npx -y @mepmail/mcp</p>
              </article>
            </div>
            <div className="v2-actions v2-gap-lg">
              <SignupLink label={t("envio.cta")} className="v2-btn v2-btn-bone" />
              <a className="v2-btn v2-btn-line" href="/envio">
                {t("envio.page")} <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        </section>

        {/* Both ladders side by side. */}
        <section className="v2-ground v2-sec" id="planos" aria-labelledby="home-prices-title">
          <div className="v2-wrap">
            <h2 id="home-prices-title" className="v2-h2">
              {t("prices.title")}
            </h2>
            <div className="v2-grid">
              <div className="v2-card-bone v2-cell">
                <p className="v2-eyebrow">{t("prices.correio")}</p>
                <div className="v2-ladder v2-ladder-light">
                  {correioPlans.map((plan) => (
                    <div key={plan.id}>
                      <span className="v2-ladder-name">
                        {prices(`correio.names.${plan.id}`)}{" "}
                        <small>· {t("prices.mailboxes", { count: plan.mailboxes })}</small>
                      </span>
                      <span className="v2-ladder-serif">{plan.price}</span>
                    </div>
                  ))}
                </div>
                <p className="v2-note v2-gap-sm">{t("prices.correioNote")}</p>
              </div>
              <div className="v2-card v2-card-raised v2-cell">
                <p className="v2-eyebrow v2-eyebrow-mono">{t("prices.envio")}</p>
                <div className="v2-ladder">
                  {sendLadder.map((plan) => (
                    <div key={plan.rung}>
                      <span className="v2-ladder-name">
                        {plan.name} <small>· {plan.volume}</small>
                      </span>
                      <span className="v2-ladder-sans">{plan.price}</span>
                    </div>
                  ))}
                </div>
                <p className="v2-note">
                  {t(launchOfferEnabled ? "prices.envioNote" : "prices.envioNoteRegular", {
                    first: firstMonth,
                    max: formatVolume(largest.included, locale),
                  })}
                </p>
              </div>
            </div>
            <div className="v2-actions v2-gap">
              <a className="v2-btn v2-btn-line" data-purchase="" href="/pricing">
                {t("prices.all")} <span aria-hidden="true">→</span>
              </a>
              <a className="v2-link" data-purchase="" href="/pricing#cenarios">
                {t("prices.scenarios")}
              </a>
            </div>
          </div>
        </section>

        <section className="v2-dark v2-sec" aria-labelledby="home-faq-title">
          <div className="v2-wrap v2-narrow">
            <h2 id="home-faq-title" className="v2-h2 v2-faq-title">
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

        <section className="v2-violet v2-sec v2-center" aria-labelledby="home-close-title">
          <div className="v2-wrap v2-stack">
            <h2 id="home-close-title" className="v2-h2 v2-close-title">
              {t("close.title")}
            </h2>
            <p className="v2-lead">{t("close.body")}</p>
            <div className="v2-actions">
              <SignupLink label={l("domainHero.cta")} className="v2-btn v2-btn-bone" />
              <a className="v2-btn v2-btn-line" href="/envio">
                {t("close.envio")}
              </a>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="landing" contact={contact} legal={legalLinks()} />
    </div>
  );
}
