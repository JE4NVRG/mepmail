import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PlanCard, type PlanCardLabels } from "@/components/plan-card";
import { SignupCta } from "@/components/signup-cta";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { StructuredData } from "@/components/structured-data";
import { ENTRY_COMPARISON_SOURCE, ENTRY_PLAN_COMPARISON } from "@/lib/entry-plan-comparison";
import { type PlanCopy, plansWithCopy } from "@/lib/landing-plans";
import {
  COMPARISON_FX,
  comparisonRowsForLocale,
  formatBrl,
  formatBrlPrice,
  formatUsd,
  formatVolume,
  formatWholeComparisonPrice,
} from "@/lib/landing-pricing";
import { LAUNCH_OFFER } from "@/lib/launch-offer";
import { legalLinks } from "@/lib/legal-links";
import { signupMailboxHref } from "@/lib/public-intent";
import { faqJsonLd } from "@/lib/structured-data";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "../site-v2.css";
import "./pricing.css";

const contact = "mailto:suporte@mepmail.dev";
const canonical = "/pricing";
/** The comparison row the Resend band quotes (Scale 550K), from the dated table. */
const PROOF_VOLUME = 550_000;
const MAIL_SIGNUP = signupMailboxHref();

type FaqItem = { q: string; a: string };

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls(canonical);
  const t = await getTranslations("pricing");
  const description = t(
    process.env.SEND_LAUNCH_OFFER_ENABLED === "true"
      ? "meta.launchDescription"
      : "meta.description",
  );
  return {
    title: t("meta.title"),
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

/** Two products, one server-rendered choice. Catalogs and checkout gates stay authoritative. */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  // Only an explicit Mail selection changes the default Send-first ordering.
  const params = (await searchParams) ?? {};
  const sendFirst = params.focus !== "mail";
  const focusHref = (focus: "send" | "mail") => {
    const query = new URLSearchParams();
    for (const key of [
      "lang",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
    ]) {
      const value = params[key];
      if (typeof value === "string") query.set(key, value);
    }
    query.set("focus", focus);
    return `/pricing?${query.toString()}#${focus === "send" ? "planos" : mailOpen ? "correio" : "mail-availability"}`;
  };
  const t = await getTranslations("pricing");
  const l = await getTranslations("landing");
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
  const launchOfferEnabled = process.env.SEND_LAUNCH_OFFER_ENABLED === "true";
  const mailOpen = process.env.MAILBOX_EARLY_ACCESS_OPEN === "true";
  // Correio on its own, without an Envio plan (checkout stays server-gated).
  const standaloneOpen = mailOpen && process.env.MAILBOX_STANDALONE_OPEN === "true";
  const correioPlans = LAUNCH_OFFER.correioPlans;
  // Portuguese readers are Brazil's audience: reais first (Pix or card), dollars as a note.
  const brazil = locale === "pt-BR";
  const allPlans = plansWithCopy(
    l.raw("plans.items") as PlanCopy[],
    launchOfferEnabled,
    l("plans.launchPriceNote"),
    brazil ? "brl" : "usd",
  );
  const includedPoints = t.raw("included.points") as string[];
  const faq = t.raw(launchOfferEnabled ? "launchFaq" : "faq.items") as FaqItem[];
  // Sums of the separate plans shown on this page; no bundle and no discount.
  const sendProCents = LAUNCH_OFFER.sending.monthlyCents;
  const sendProBrlCents = LAUNCH_OFFER.sending.brlMonthlyCents;
  const scenarios = standaloneOpen
    ? (
        [
          { id: "solo", plan: "solo", sendPro: false },
          { id: "support", plan: "duo", sendPro: false },
          ...(launchOfferEnabled ? [{ id: "saas", plan: "equipe", sendPro: true }] : []),
        ] as const
      ).map((scenario) => {
        const plan = correioPlans.find((p) => p.id === scenario.plan);
        if (!plan) throw new Error(`Unknown Correio plan ${scenario.plan}`);
        return {
          ...scenario,
          correio: plan,
          totalCents: plan.monthlyCents + (scenario.sendPro ? sendProCents : 0),
          totalBrlCents: plan.brlMonthlyCents + (scenario.sendPro ? sendProBrlCents : 0),
        };
      })
    : [];
  const money = (brlCents: number, usdCents: number) =>
    brazil ? formatBrlPrice(brlCents, locale) : formatUsd(usdCents / 100, locale);
  const exact = (brlCents: number, usdCents: number) =>
    brazil ? formatBrl(brlCents / 100, locale) : formatUsd(usdCents / 100, locale);
  // Headline prices: "R$ 149", "US$ 29".
  const sendPrice = money(LAUNCH_OFFER.sending.brlMonthlyCents, LAUNCH_OFFER.sending.monthlyCents);
  const sendFirstPrice = money(
    LAUNCH_OFFER.sending.brlFirstMonthlyCents,
    LAUNCH_OFFER.sending.firstMonthlyCents,
  );
  const proofRow = comparisonRowsForLocale(launchOfferEnabled, locale).find(
    (row) => row.volume === PROOF_VOLUME,
  );

  const quickPrices = (
    <nav className="pricing-shortcuts v2-quick" aria-label={t("quickPrices.label")}>
      {standaloneOpen ? (
        <a href="#correio">
          <span>{t("quickPrices.mail")}</span>
          <strong>
            {money(correioPlans[0].brlMonthlyCents, correioPlans[0].monthlyCents)}
            <small>{l("plans.perMonth")}</small>
          </strong>
        </a>
      ) : null}
      <a href="#planos">
        <span>{t("quickPrices.send")}</span>
        <strong>
          {brazil ? "R$ 0" : "US$ 0"}
          <small>{t("quickPrices.free")}</small>
        </strong>
      </a>
    </nav>
  );

  // The entry plans of both products on the first screen (redesign 2026-10-20): Mail's three
  // plans and Send's first three rungs, each with its price, its allowance and its section.
  const sendEntry = allPlans.slice(0, 3);
  const planBoard = standaloneOpen ? (
    <div className="v2p-board">
      <div className="v2p-panel v2p-panel-mail">
        <h2 id="pricing-board-mail" className="v2p-panel-title">
          {t("board.mail")}
          <small>{t("board.mailUnit")}</small>
        </h2>
        <ul>
          {correioPlans.map((plan) => (
            <li key={plan.id}>
              <a href="#correio" className={plan.id === "equipe" ? "is-featured" : undefined}>
                <strong>{t(`correio.names.${plan.id}`)}</strong>
                <span>
                  {t("correio.planMailboxes", { count: plan.mailboxes })} ·{" "}
                  {t("board.mailAllowance", {
                    sends: plan.monthlyRecipientDeliveries.toLocaleString(locale),
                    domains: plan.domains,
                  })}
                </span>
                <em>
                  {money(plan.brlMonthlyCents, plan.monthlyCents)}
                  <small>{l("plans.perMonth")}</small>
                </em>
              </a>
            </li>
          ))}
        </ul>
        <p className="v2-fine">{t("board.mailNote")}</p>
      </div>
      <div className="v2p-panel v2p-panel-send">
        <h2 id="pricing-board-send" className="v2p-panel-title">
          {t("board.send")}
          <small>{t("board.sendUnit")}</small>
        </h2>
        <ul>
          {sendEntry.map((plan) => (
            <li key={plan.rung}>
              <a href="#planos" className={plan.featured ? "is-featured" : undefined}>
                <strong>{plan.name}</strong>
                <span>{plan.copy.volume}</span>
                <em>
                  {plan.price}
                  <small>{l("plans.perMonth")}</small>
                </em>
              </a>
            </li>
          ))}
        </ul>
        <p className="v2-fine">
          {launchOfferEnabled
            ? t("board.sendLaunch", { first: sendFirstPrice, price: sendPrice })
            : t("board.sendNote")}
        </p>
      </div>
    </div>
  ) : (
    quickPrices
  );

  const scenariosSection = scenarios.length ? (
    <section
      className="v2-dark v2-sec-tight"
      id="cenarios"
      aria-labelledby="pricing-scenarios-title"
    >
      <div className="v2-wrap">
        <p className="v2-eyebrow">{t("scenarios.eyebrow")}</p>
        <h2 id="pricing-scenarios-title" className="v2-h3">
          {t("scenarios.title")}
        </h2>
        <div className="v2-grid">
          {scenarios.map((scenario, index) => (
            <article
              className={`v2-card v2-cell${index === scenarios.length - 1 && scenario.sendPro ? " v2-card-violet" : ""}`}
              key={scenario.id}
            >
              <h3 className="v2-h3-sm">{t(`scenarios.items.${scenario.id}.title`)}</h3>
              <p className="v2-plan-price">
                {exact(scenario.totalBrlCents, scenario.totalCents)}
                <small>{l("plans.perMonth")}</small>
              </p>
              <p className="v2-body">{t(`scenarios.items.${scenario.id}.body`)}</p>
              <dl className="v2-mono-table v2-scenario-lines">
                <div>
                  <dt>
                    {t("scenarios.lineCorreio", {
                      plan: t(`correio.names.${scenario.correio.id}`),
                    })}
                  </dt>
                  <dd>{exact(scenario.correio.brlMonthlyCents, scenario.correio.monthlyCents)}</dd>
                </div>
                <div>
                  <dt>
                    {t(scenario.sendPro ? "scenarios.lineSendPro" : "scenarios.lineSendFree")}
                  </dt>
                  <dd>
                    {scenario.sendPro ? exact(sendProBrlCents, sendProCents) : t("scenarios.free")}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
        <p className="v2-fine v2-gap-sm">{t("scenarios.lead")}</p>
      </div>
    </section>
  ) : null;

  const correioSection = mailOpen ? (
    <section className="v2-light v2-sec" id="correio" aria-labelledby="pricing-correio-title">
      <div className="v2-wrap">
        <p className="v2-eyebrow">{t("correio.eyebrow")}</p>
        <h2 id="pricing-correio-title" className="v2-h2">
          {standaloneOpen ? t("v2.correioTitle") : t("correio.title")}
        </h2>
        <p className="v2-lead v2-gap-sm">
          {t(standaloneOpen ? "correio.bodyStandalone" : "correio.body")}
        </p>
        <div className="v2-grid">
          {standaloneOpen
            ? correioPlans.map((plan) => {
                const featured = plan.id === "duo";
                const name = t(`correio.names.${plan.id}`);
                return (
                  <article
                    className={`v2-plan v2-cell${featured ? " is-featured" : ""}`}
                    key={plan.id}
                  >
                    <h3 className="v2-h3">{name}</h3>
                    <p className="v2-plan-price">
                      {money(plan.brlMonthlyCents, plan.monthlyCents)}
                      <small>{t("correio.perMonthPlan")}</small>
                    </p>
                    <ul className="v2-plan-list">
                      <li>
                        <strong>{t("correio.planMailboxes", { count: plan.mailboxes })}</strong>
                      </li>
                      <li>{t("correio.sharedStorage", { size: plan.storageGiB })}</li>
                      <li>
                        {t("correio.sharedSends", { count: plan.monthlyRecipientDeliveries })}
                      </li>
                      <li>{t("correio.planInbound", { count: plan.monthlyInboundMessages })}</li>
                      <li>{t("correio.domains", { count: plan.domains })}</li>
                      <li>{t("correio.trial")}</li>
                      <li>
                        {t("correio.planLocal", {
                          price: brazil
                            ? formatUsd(plan.monthlyCents / 100, locale)
                            : formatBrl(plan.brlMonthlyCents / 100, locale),
                        })}
                      </li>
                    </ul>
                    <a
                      className={`v2-btn v2-btn-block ${featured ? "v2-btn-bone" : "v2-btn-line"}`}
                      href={signupMailboxHref(plan.id)}
                    >
                      {t("v2.correioCta", { plan: name })}
                    </a>
                  </article>
                );
              })
            : LAUNCH_OFFER.mailboxes.map((box) => (
                <article className="v2-plan v2-cell" key={box.id}>
                  <h3 className="v2-h3">{t(`correio.names.${box.id}`)}</h3>
                  <p className="v2-plan-price">
                    {formatUsd(box.monthlyCents / 100, locale)}
                    <small>{t("correio.perMonth")}</small>
                  </p>
                  <ul className="v2-plan-list">
                    <li>{t("correio.storage", { size: box.storageGiB })}</li>
                    <li>{t("correio.sends", { count: box.monthlyRecipientDeliveries })}</li>
                    <li>{t("correio.agents")}</li>
                  </ul>
                </article>
              ))}
        </div>
        {standaloneOpen ? <p className="v2-note v2-gap">{t("v2.correioFree")}</p> : null}
        <details className="v2-details">
          <summary>{t("v2.correioDetails")}</summary>
          <div>
            {standaloneOpen ? <p className="v2-note">{t("correio.noteLimits")}</p> : null}
            <p className="v2-note">
              {t(standaloneOpen ? "correio.noteStandalone" : "correio.note")}
            </p>
          </div>
        </details>
        <p className="v2-gap">
          <a className="v2-link-accent" href="/correio">
            {t("correio.cta")} <span aria-hidden="true">→</span>
          </a>
        </p>
      </div>
    </section>
  ) : (
    <section
      className="v2-light v2-sec-tight"
      id="mail-availability"
      aria-labelledby="pricing-correio-title"
    >
      <div className="v2-wrap">
        <h2 id="pricing-correio-title" className="v2-h3">
          {t("choice.mailTitle")}
        </h2>
        <p className="v2-note">{t("choice.mailClosed")}</p>
        <a className="v2-link-accent" href="/correio">
          {t("correio.cta")}
        </a>
      </div>
    </section>
  );

  return (
    <div className="gtm v2">
      <StructuredData graph={[faqJsonLd(faq)]} />
      <PublicHeader labels={site} page="pricing" />
      <main id="conteudo">
        <section className="v2-dark pricing-choice" aria-labelledby="pricing-choice-title">
          <div className="v2-wrap">
            <p id="pricing-choice-title" className="v2-eyebrow">
              {t("choice.title")}
            </p>
            <nav className="pricing-focus" aria-label={t("choice.title")}>
              <a href={focusHref("send")} aria-current={sendFirst ? "true" : undefined}>
                <strong>{t("choice.send")}</strong>
                <span>{t("choice.sendHint")}</span>
              </a>
              <a href={focusHref("mail")} aria-current={!sendFirst ? "true" : undefined}>
                <strong>{t("choice.mail")}</strong>
                <span>{t("choice.mailHint")}</span>
              </a>
            </nav>
            <p className="v2-note">{t("choice.separate")}</p>
          </div>
        </section>
        {sendFirst ? (
          <section className="v2-dark v2-sec pricing-intro">
            <div className="v2-wrap v2-stack">
              <p className="v2-eyebrow v2-eyebrow-mono">{t("sendHero.eyebrow")}</p>
              <h1>{t("choice.sendTitle")}</h1>
              <p className="v2-lead">{t("sendHero.lead")}</p>
              <p className="pricing-entry-note">
                {t("choice.sendEntry", { price: allPlans[1]?.price ?? "" })}
              </p>
              <div className="v2-actions">
                <SignupCta
                  className="v2-btn v2-btn-bone"
                  label={t("choice.freeCta")}
                  plan="Free"
                  rung="free"
                />
                <a className="v2-link" href="#planos">
                  {t("sendHero.plansLink")}
                </a>
              </div>
              <p className="v2-note">{t("note")}</p>
            </div>
          </section>
        ) : (
          <section className="v2-dark v2-sec pricing-intro v2p-intro">
            <div className="v2-wrap v2p-intro-grid">
              <div className="v2-stack">
                <p className="v2-eyebrow">{t("eyebrow")}</p>
                <h1>{t("choice.mailTitle")}</h1>
                <p className="v2-lead">{t("v2.lead")}</p>
                <p className="pricing-entry-note">
                  {t(standaloneOpen ? "choice.mailEntry" : "choice.mailClosed", {
                    price: money(correioPlans[0].brlMonthlyCents, correioPlans[0].monthlyCents),
                  })}
                </p>
                {brazil && standaloneOpen ? <p className="v2-note">{t("choice.mailPix")}</p> : null}
                <div className="v2-actions">
                  {standaloneOpen ? (
                    <SignupLink
                      label={l("plans.cta")}
                      className="v2-btn v2-btn-bone"
                      mailboxPlan="choose"
                    />
                  ) : (
                    <a className="v2-btn v2-btn-bone" href="/correio">
                      {t("correio.cta")}
                    </a>
                  )}
                  <a className="v2-link" href="/alternatives/resend">
                    {t("alternatives.cta")}
                  </a>
                </div>
                <p className="v2-note">{t("note")}</p>
              </div>
              {planBoard}
            </div>
          </section>
        )}

        {sendFirst ? null : correioSection}

        <section className="v2-dark v2-sec" id="planos" aria-labelledby="pricing-plans-title">
          <div className="v2-wrap">
            <p className="v2-eyebrow v2-eyebrow-mono">{t("v2.envioEyebrow")}</p>
            <h2 id="pricing-plans-title" className="v2-h2-sans">
              {t("v2.envioTitle")}
            </h2>
            <p className="v2-lead v2-gap-sm">{t("plans.intro")}</p>
            <div className="gtm-plan-grid">
              {allPlans.slice(0, 3).map((plan) => (
                <PlanCard key={plan.name} plan={plan} labels={cardLabels} />
              ))}
            </div>
            <h3 className="v2-h3 v2-gap-lg">{t("v2.moreTitle")}</h3>
            <section
              className="v2-table-box v2-gap-sm"
              aria-label={t("v2.table.aria")}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: focus lets the keyboard scroll the table
              tabIndex={0}
            >
              <table className="v2-table">
                <thead>
                  <tr>
                    <th scope="col">{t("v2.table.plan")}</th>
                    <th scope="col">{t("v2.table.volume")}</th>
                    <th scope="col">{t("v2.table.price")}</th>
                    <th scope="col">{t("v2.table.overage")}</th>
                    <th scope="col">
                      <span className="gtm-sr-only">{t("v2.table.choose")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {allPlans.slice(3).map((plan) => (
                    <tr key={plan.rung}>
                      <th scope="row">{plan.name}</th>
                      <td>{plan.copy.volume}</td>
                      <td className="v2-table-price">
                        {plan.price}
                        {l("plans.perMonth")}
                      </td>
                      <td>{plan.copy.overage}</td>
                      <td>
                        <SignupCta
                          className="v2-link-accent"
                          label={t("v2.table.choose")}
                          plan={plan.name}
                          rung={plan.rung}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <p className="v2-fine v2-gap-sm">
              {t("v2.scaleNote", { limits: allPlans[allPlans.length - 1]?.copy.limits ?? "" })}
            </p>
            <p className="v2-note v2-gap-sm">
              <a className="v2-link-accent" href="#pricing-usage">
                {t("plans.details")}
              </a>
            </p>
          </div>
        </section>

        {launchOfferEnabled ? (
          <section className="v2-dark v2-sec-tight" aria-labelledby="pricing-entry-compare-title">
            <div className="v2-wrap">
              <h2 id="pricing-entry-compare-title" className="v2-h3">
                {t("entryComparison.title")}
              </h2>
              <p className="v2-note v2-gap-sm">{t("entryComparison.scope")}</p>
              <div className="v2-table-box v2-gap-sm">
                <table className="v2-table pricing-entry-table">
                  <caption className="gtm-sr-only">{t("entryComparison.title")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("entryComparison.volume")}</th>
                      <th scope="col">MepMail</th>
                      <th scope="col">Resend</th>
                      <th scope="col">{t("entryComparison.condition")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ENTRY_PLAN_COMPARISON.map((row) => (
                      <tr key={row.volume}>
                        <th scope="row">{formatVolume(row.volume, locale)}</th>
                        <td>
                          {formatUsd(row.mepmailUsd, locale)} · {row.plan}
                        </td>
                        <td>{formatUsd(row.resendUsd, locale)} · Pro 50K</td>
                        <td>
                          {row.condition === "daily"
                            ? t("entryComparison.daily", {
                                cap: row.dailyCap,
                                days: row.minimumSendingDays,
                              })
                            : t("entryComparison.monthly")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="v2-note v2-gap-sm">{t("entryComparison.notAlwaysCheaper")}</p>
              <p className="v2-fine v2-gap-sm">
                {t("entryComparison.sources", { date: ENTRY_COMPARISON_SOURCE.checkedAt })}{" "}
                <a className="v2-link-accent" href={ENTRY_COMPARISON_SOURCE.resend}>
                  Resend
                </a>
                {" · "}
                <a className="v2-link-accent" href={ENTRY_COMPARISON_SOURCE.mepmail}>
                  MepMail Starter
                </a>
                {" · "}
                <a className="v2-link-accent" href={ENTRY_COMPARISON_SOURCE.offer}>
                  MepMail Pro 110K
                </a>
              </p>
            </div>
          </section>
        ) : null}

        {launchOfferEnabled ? (
          <section className="v2-ground v2-sec" id="pro110k" aria-labelledby="launch-pro-title">
            <div className="v2-wrap">
              <p className="v2-eyebrow v2-eyebrow-mono">{t("launch.eyebrow")}</p>
              <h2 id="launch-pro-title" className="v2-h2-sans">
                {t("launch.title")}
              </h2>
              <p className="v2-lead v2-gap-sm">{t("launch.body")}</p>
              <div className="v2-grid">
                <article className="v2-card v2-card-raised v2-cell">
                  <h3 className="v2-h3">{t("launch.monthTitle")}</h3>
                  <p className="v2-plan-price">
                    {sendPrice}
                    <small>{l("plans.perMonth")}</small>
                  </p>
                  <p className="v2-body">{t("launch.monthIntro")}</p>
                  <p className="v2-fine">{t("launch.monthQuota")}</p>
                  <p className="v2-fine">
                    {brazil
                      ? t("launch.monthLocal", {
                          first: formatUsd(LAUNCH_OFFER.sending.firstMonthlyCents / 100, locale),
                          price: formatUsd(LAUNCH_OFFER.sending.monthlyCents / 100, locale),
                        })
                      : t("launch.monthLocal", {
                          first: formatBrl(LAUNCH_OFFER.sending.brlFirstMonthlyCents / 100, locale),
                          price: formatBrl(LAUNCH_OFFER.sending.brlMonthlyCents / 100, locale),
                        })}
                  </p>
                </article>
                <article className="v2-card v2-card-raised v2-cell">
                  <h3 className="v2-h3">{t("launch.yearTitle")}</h3>
                  <p className="v2-plan-price">
                    {money(
                      LAUNCH_OFFER.sending.brlMonthlyCents * LAUNCH_OFFER.annualChargedMonths,
                      LAUNCH_OFFER.sending.monthlyCents * LAUNCH_OFFER.annualChargedMonths,
                    )}
                    <small>{t("launch.perYear")}</small>
                  </p>
                  <p className="v2-body">{t("launch.yearUpfront")}</p>
                  <p className="v2-fine">{t("launch.yearQuota")}</p>
                  <p className="v2-fine">
                    {t("launch.yearLocal", {
                      price: brazil
                        ? formatUsd(
                            (LAUNCH_OFFER.sending.monthlyCents * LAUNCH_OFFER.annualChargedMonths) /
                              100,
                            locale,
                          )
                        : formatBrl(
                            (LAUNCH_OFFER.sending.brlMonthlyCents *
                              LAUNCH_OFFER.annualChargedMonths) /
                              100,
                            locale,
                          ),
                    })}
                  </p>
                </article>
              </div>
              <p className="v2-note v2-gap">{t("launch.preserved")}</p>
              <p className="v2-note v2-gap-sm">
                {t("launch.mailAccess")}{" "}
                <a className="v2-link-accent" href="/correio">
                  {t("launch.mailCta")} <span aria-hidden="true">→</span>
                </a>
              </p>
            </div>
          </section>
        ) : null}

        {sendFirst ? correioSection : null}
        {scenariosSection}

        <section className="v2-dark v2-sec-tight" aria-labelledby="pricing-included-title">
          <div className="v2-wrap">
            <p className="v2-eyebrow v2-eyebrow-mono">{t("included.eyebrow")}</p>
            <h2 id="pricing-included-title" className="v2-h3">
              {t("included.title")}
            </h2>
            <ul className="v2-checks v2-gap">
              {includedPoints.map((point) => (
                <li key={point}>
                  <span className="v2-check-ok" aria-hidden="true">
                    ✓
                  </span>
                  {point}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {proofRow ? (
          <section className="v2-dark v2-sec-tight" aria-labelledby="pricing-compare-title">
            <div className="v2-wrap">
              <div className="v2-card-bone v2-row v2-compare">
                <div className="v2-stack-sm">
                  <h2 id="pricing-compare-title" className="v2-h3 v2-compare-title">
                    {t("v2.compareTitle", {
                      volume: formatVolume(PROOF_VOLUME, locale),
                      ours: formatWholeComparisonPrice(proofRow.mepmail, locale),
                      theirs: formatWholeComparisonPrice(proofRow.resend, locale),
                    })}
                  </h2>
                  <p className="v2-note">{t("alternatives.body")}</p>
                </div>
                <p>
                  <a className="v2-btn v2-btn-ink" href="/alternatives/resend">
                    {t("alternatives.cta")} <span aria-hidden="true">→</span>
                  </a>
                </p>
              </div>
              <p className="v2-fine v2-gap-sm">
                {t("v2.footnote", {
                  volume: formatVolume(PROOF_VOLUME, locale),
                  date: new Date(`${COMPARISON_FX.date}T12:00:00Z`).toLocaleDateString(locale, {
                    timeZone: "UTC",
                  }),
                  rate: COMPARISON_FX.brlPerUsd.toLocaleString(locale),
                })}
              </p>
            </div>
          </section>
        ) : null}

        <section className="v2-ground v2-sec" id="faq" aria-labelledby="pricing-faq-title">
          <div className="v2-wrap v2-narrow">
            <h2 id="pricing-faq-title" className="v2-h2 v2-faq-title">
              {t("faq.title")}
            </h2>
            <div className="v2-faq">
              {faq.map((item, index) => (
                <details key={item.q} id={index === 0 ? "pricing-usage" : `pricing-faq-${index}`}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                  {index === 0 ? <p>{t("choice.dailyNote")}</p> : null}
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="v2-violet v2-sec v2-center" aria-labelledby="pricing-close-title">
          <div className="v2-wrap v2-stack">
            <h2 id="pricing-close-title" className="v2-h2 v2-close-title">
              {t("v2.closeTitle")}
            </h2>
            <p className="v2-lead">{t("close.body")}</p>
            <div className="v2-actions">
              <SignupLink label={t("close.cta")} className="v2-btn v2-btn-bone" />
              {standaloneOpen ? (
                <a className="v2-btn v2-btn-line" href={MAIL_SIGNUP}>
                  {t("correio.subscribe")}
                </a>
              ) : null}
            </div>
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="pricing" contact={contact} legal={legalLinks()} />
    </div>
  );
}
