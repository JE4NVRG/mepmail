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
import { type PlanCopy, plansWithCopy } from "@/lib/landing-plans";
import { formatBrl, formatBrlPrice, formatUsd } from "@/lib/landing-pricing";
import { LAUNCH_OFFER } from "@/lib/launch-offer";
import { legalLinks } from "@/lib/legal-links";
import { pricingFocus } from "@/lib/public-intent";
import { faqJsonLd } from "@/lib/structured-data";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "./pricing.css";

const contact = "mailto:suporte@mepmail.dev";
const canonical = "/pricing";

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

/**
 * Standalone pricing page: the whole ladder on one screen (no "show Scale"
 * fold), the overage rules and a short FAQ. Chrome, plan ladder and plan copy
 * all come from the shared sources the landing uses.
 */
export default async function PricingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const locale = await getLocale();
  // A Send campaign (?focus=send, or utm_campaign naming send) lands on Send: its offer leads
  // and its plans come right after, before the Mail scenarios (lib/public-intent.ts).
  const sendFirst = pricingFocus((await searchParams) ?? {}) === "send";
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
  // Headline prices: "R$ 149", "US$ 29".
  const sendPrice = brazil
    ? formatBrlPrice(LAUNCH_OFFER.sending.brlMonthlyCents, locale)
    : formatUsd(LAUNCH_OFFER.sending.monthlyCents / 100, locale);
  const sendFirstPrice = brazil
    ? formatBrlPrice(LAUNCH_OFFER.sending.brlFirstMonthlyCents, locale)
    : formatUsd(LAUNCH_OFFER.sending.firstMonthlyCents / 100, locale);

  const scenariosSection = scenarios.length ? (
    <section className="gtm-section" id="cenarios" aria-labelledby="pricing-scenarios-title">
      <div className="gtm-container">
        <p className="gtm-eyebrow">{t("scenarios.eyebrow")}</p>
        <h2 id="pricing-scenarios-title">{t("scenarios.title")}</h2>
        <p>{t("scenarios.lead")}</p>
        <div className="gtm-split gtm-split-three pricing-scenarios">
          {scenarios.map((scenario) => (
            <article className="ms-card gtm-plan" key={scenario.id}>
              <h3>{t(`scenarios.items.${scenario.id}.title`)}</h3>
              <p>{t(`scenarios.items.${scenario.id}.body`)}</p>
              <dl className="pricing-scenario-lines">
                <div>
                  <dt>
                    {t("scenarios.lineCorreio", {
                      plan: t(`correio.names.${scenario.correio.id}`),
                    })}
                  </dt>
                  <dd>
                    {brazil
                      ? formatBrl(scenario.correio.brlMonthlyCents / 100, locale)
                      : formatUsd(scenario.correio.monthlyCents / 100, locale)}
                  </dd>
                </div>
                <div>
                  <dt>
                    {t(scenario.sendPro ? "scenarios.lineSendPro" : "scenarios.lineSendFree")}
                  </dt>
                  <dd>
                    {scenario.sendPro
                      ? brazil
                        ? formatBrl(sendProBrlCents / 100, locale)
                        : formatUsd(sendProCents / 100, locale)
                      : t("scenarios.free")}
                  </dd>
                </div>
                <div className="pricing-scenario-total">
                  <dt>{t("scenarios.total")}</dt>
                  <dd>
                    {brazil
                      ? formatBrl(scenario.totalBrlCents / 100, locale)
                      : formatUsd(scenario.totalCents / 100, locale)}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </div>
    </section>
  ) : null;

  return (
    <div className="gtm">
      <StructuredData graph={[faqJsonLd(faq)]} />
      <PublicHeader labels={site} page="pricing" />
      <main id="conteudo">
        {sendFirst ? (
          <section className="gtm-section gtm-alt">
            <div className="gtm-container">
              <p className="gtm-eyebrow">{t("sendHero.eyebrow")}</p>
              <h1>
                {t.rich("sendHero.title", {
                  price: sendPrice,
                  highlight: (chunks) => <span>{chunks}</span>,
                })}
              </h1>
              <p className="gtm-lead">{t("sendHero.lead")}</p>
              <div className="gtm-actions">
                <SignupCta
                  className="ms-btn ms-btn-primary gtm-action"
                  label={t("sendHero.cta")}
                  plan="Pro 110K"
                  rung="pro_100k"
                />
                <a className="ms-btn ms-btn-secondary gtm-action" href="#planos">
                  {t("sendHero.plansLink")}
                </a>
              </div>
              <p className="gtm-note">
                {launchOfferEnabled
                  ? t("sendHero.note", { first: sendFirstPrice, price: sendPrice })
                  : t("sendHero.noteRegular", { price: sendPrice })}
              </p>
            </div>
          </section>
        ) : (
          <section className="gtm-section gtm-alt">
            <div className="gtm-container">
              <p className="gtm-eyebrow">{t("eyebrow")}</p>
              <h1>{t.rich("title", { highlight: (chunks) => <span>{chunks}</span> })}</h1>
              <p className="gtm-lead">{t("lead")}</p>
              <div className="gtm-actions">
                <SignupLink label={l("plans.cta")} />
                <a className="ms-btn ms-btn-secondary gtm-action" href="/alternatives/resend">
                  {t("alternatives.cta")}
                </a>
              </div>
              <p className="gtm-note">{t("note")}</p>
            </div>
          </section>
        )}

        {sendFirst ? null : scenariosSection}

        <section className="gtm-section" id="planos">
          <div className="gtm-container">
            <h2>{t("plans.title")}</h2>
            <p>{t("plans.intro")}</p>
            <div className="gtm-plan-grid">
              {allPlans.map((plan) => (
                <PlanCard key={plan.name} plan={plan} labels={cardLabels} />
              ))}
            </div>
            <p className="gtm-note">{l("plans.note")}</p>
            <p className="gtm-note">{l("plans.noteAttach")}</p>
          </div>
        </section>

        {launchOfferEnabled ? (
          <section className="gtm-section gtm-alt" id="pro110k" aria-labelledby="launch-pro-title">
            <div className="gtm-container">
              <p className="gtm-eyebrow">{t("launch.eyebrow")}</p>
              <h2 id="launch-pro-title">{t("launch.title")}</h2>
              <p>{t("launch.body")}</p>
              <div className="gtm-split">
                <article className="ms-card gtm-plan">
                  <h3>{t("launch.monthTitle")}</h3>
                  <p className="gtm-price">
                    {brazil
                      ? formatBrlPrice(LAUNCH_OFFER.sending.brlMonthlyCents, locale)
                      : formatUsd(LAUNCH_OFFER.sending.monthlyCents / 100, locale)}
                    <span>{l("plans.perMonth")}</span>
                  </p>
                  <p>{t("launch.monthIntro")}</p>
                  <p className="gtm-note">{t("launch.monthQuota")}</p>
                  <p className="gtm-note">
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
                <article className="ms-card gtm-plan">
                  <h3>{t("launch.yearTitle")}</h3>
                  <p className="gtm-price">
                    {brazil
                      ? formatBrlPrice(
                          LAUNCH_OFFER.sending.brlMonthlyCents * LAUNCH_OFFER.annualChargedMonths,
                          locale,
                        )
                      : formatUsd(
                          (LAUNCH_OFFER.sending.monthlyCents * LAUNCH_OFFER.annualChargedMonths) /
                            100,
                          locale,
                        )}
                    <span>{t("launch.perYear")}</span>
                  </p>
                  <p>{t("launch.yearUpfront")}</p>
                  <p className="gtm-note">{t("launch.yearQuota")}</p>
                  <p className="gtm-note">
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
              <p className="gtm-note">{t("launch.preserved")}</p>
              <a className="ms-btn ms-btn-secondary gtm-action" href="/correio">
                {t("launch.mailCta")}
              </a>
              <p className="gtm-note">{t("launch.mailAccess")}</p>
            </div>
          </section>
        ) : null}

        {sendFirst ? scenariosSection : null}

        {mailOpen ? (
          <section className="gtm-section" id="correio" aria-labelledby="pricing-correio-title">
            <div className="gtm-container">
              <p className="gtm-eyebrow">{t("correio.eyebrow")}</p>
              <h2 id="pricing-correio-title">{t("correio.title")}</h2>
              <p>{t(standaloneOpen ? "correio.bodyStandalone" : "correio.body")}</p>
              <div className={`gtm-split${standaloneOpen ? " gtm-split-three" : ""}`}>
                {standaloneOpen
                  ? correioPlans.map((plan) => (
                      <article className="ms-card gtm-plan" key={plan.id}>
                        <h3>{t(`correio.names.${plan.id}`)}</h3>
                        <p className="gtm-price">
                          {brazil
                            ? formatBrlPrice(plan.brlMonthlyCents, locale)
                            : formatUsd(plan.monthlyCents / 100, locale)}
                          <span>{t("correio.perMonthPlan")}</span>
                        </p>
                        <ul className="gtm-points">
                          <li>{t("correio.planMailboxes", { count: plan.mailboxes })}</li>
                          <li>{t("correio.sharedStorage", { size: plan.storageGiB })}</li>
                          <li>
                            {t("correio.sharedSends", { count: plan.monthlyRecipientDeliveries })}
                          </li>
                          <li>
                            {t("correio.planInbound", { count: plan.monthlyInboundMessages })}
                          </li>
                          <li>{t("correio.domains", { count: LAUNCH_OFFER.correioDomains })}</li>
                          <li>{t("correio.trial")}</li>
                          <li>
                            {t("correio.planLocal", {
                              price: brazil
                                ? formatUsd(plan.monthlyCents / 100, locale)
                                : formatBrl(plan.brlMonthlyCents / 100, locale),
                            })}
                          </li>
                        </ul>
                      </article>
                    ))
                  : LAUNCH_OFFER.mailboxes.map((box) => (
                      <article className="ms-card gtm-plan" key={box.id}>
                        <h3>{t(`correio.names.${box.id}`)}</h3>
                        <p className="gtm-price">
                          {formatUsd(box.monthlyCents / 100, locale)}
                          <span>{t("correio.perMonth")}</span>
                        </p>
                        <ul className="gtm-points">
                          <li>{t("correio.storage", { size: box.storageGiB })}</li>
                          <li>{t("correio.sends", { count: box.monthlyRecipientDeliveries })}</li>
                          <li>{t("correio.agents")}</li>
                        </ul>
                      </article>
                    ))}
              </div>
              {standaloneOpen ? <p className="gtm-note">{t("correio.noteLimits")}</p> : null}
              <p className="gtm-note">
                {t(standaloneOpen ? "correio.noteStandalone" : "correio.note")}
              </p>
              <div className="ms-wrap-row" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {standaloneOpen ? (
                  <a className="ms-btn ms-btn-primary gtm-action" href="/signup?next=/mail">
                    {t("correio.subscribe")}
                  </a>
                ) : null}
                <a className="ms-btn ms-btn-secondary gtm-action" href="/correio">
                  {t("correio.cta")}
                </a>
              </div>
            </div>
          </section>
        ) : null}

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("included.eyebrow")}</p>
            <h2>{t("included.title")}</h2>
            <p>{t("included.body")}</p>
            <ul className="gtm-points">
              {includedPoints.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("alternatives.eyebrow")}</p>
            <h2>{t("alternatives.title")}</h2>
            <p>{t("alternatives.body")}</p>
            <a className="ms-btn ms-btn-secondary gtm-action" href="/alternatives/resend">
              {t("alternatives.cta")}
            </a>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
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

        <section className="gtm-section gtm-close">
          <div className="gtm-container">
            <h2>{t("close.title")}</h2>
            <p>{t("close.body")}</p>
            <SignupLink label={t("close.cta")} />
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="pricing" contact={contact} legal={legalLinks()} />
    </div>
  );
}
