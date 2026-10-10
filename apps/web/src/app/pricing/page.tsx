import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PlanCard, type PlanCardLabels } from "@/components/plan-card";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { type PlanCopy, plansWithCopy } from "@/lib/landing-plans";
import { formatUsd } from "@/lib/landing-pricing";
import { LAUNCH_OFFER } from "@/lib/launch-offer";
import { legalLinks } from "@/lib/legal-links";
import "../landing.css";

const contact = "mailto:jean@mepmail.dev";
const canonical = "/pricing";

type FaqItem = { q: string; a: string };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pricing");
  const description = t(
    process.env.SEND_LAUNCH_OFFER_ENABLED === "true"
      ? "meta.launchDescription"
      : "meta.description",
  );
  return {
    title: t("meta.title"),
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
 * Standalone pricing page: the whole ladder on one screen (no "show Scale"
 * fold), the overage rules and a short FAQ. Chrome, plan ladder and plan copy
 * all come from the shared sources the landing uses.
 */
export default async function PricingPage() {
  const locale = await getLocale();
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
  const solo = LAUNCH_OFFER.standaloneMailbox;
  const allPlans = plansWithCopy(
    l.raw("plans.items") as PlanCopy[],
    launchOfferEnabled,
    l("plans.launchPriceNote"),
  );
  const includedPoints = t.raw("included.points") as string[];
  const faq = t.raw(launchOfferEnabled ? "launchFaq" : "faq.items") as FaqItem[];

  return (
    <div className="gtm">
      <PublicHeader labels={site} page="pricing" />
      <main id="conteudo">
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
                    {formatUsd(LAUNCH_OFFER.sending.monthlyCents / 100, locale)}
                    <span>{l("plans.perMonth")}</span>
                  </p>
                  <p>{t("launch.monthIntro")}</p>
                  <p className="gtm-note">{t("launch.monthQuota")}</p>
                </article>
                <article className="ms-card gtm-plan">
                  <h3>{t("launch.yearTitle")}</h3>
                  <p className="gtm-price">
                    {formatUsd(
                      (LAUNCH_OFFER.sending.monthlyCents * LAUNCH_OFFER.annualChargedMonths) / 100,
                      locale,
                    )}
                    <span>{t("launch.perYear")}</span>
                  </p>
                  <p>{t("launch.yearUpfront")}</p>
                  <p className="gtm-note">{t("launch.yearQuota")}</p>
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

        {mailOpen ? (
          <section className="gtm-section" id="correio" aria-labelledby="pricing-correio-title">
            <div className="gtm-container">
              <p className="gtm-eyebrow">{t("correio.eyebrow")}</p>
              <h2 id="pricing-correio-title">{t("correio.title")}</h2>
              <p>{t(standaloneOpen ? "correio.bodyStandalone" : "correio.body")}</p>
              <div className={`gtm-split${standaloneOpen ? " gtm-split-three" : ""}`}>
                {standaloneOpen ? (
                  <article className="ms-card gtm-plan" key={solo.id}>
                    <h3>{t("correio.names.solo")}</h3>
                    <p className="gtm-price">
                      {formatUsd(solo.monthlyCents / 100, locale)}
                      <span>{t("correio.perMonth")}</span>
                    </p>
                    <ul className="gtm-points">
                      <li>{t("correio.withoutSending")}</li>
                      <li>{t("correio.storage", { size: solo.storageGiB })}</li>
                      <li>{t("correio.sends", { count: solo.monthlyRecipientDeliveries })}</li>
                      <li>{t("correio.domains", { count: solo.domains })}</li>
                      <li>{t("correio.agents")}</li>
                    </ul>
                  </article>
                ) : null}
                {LAUNCH_OFFER.mailboxes.map((box) => (
                  <article className="ms-card gtm-plan" key={box.id}>
                    <h3>{t(`correio.names.${box.id}`)}</h3>
                    <p className="gtm-price">
                      {formatUsd(box.monthlyCents / 100, locale)}
                      <span>{t("correio.perMonth")}</span>
                    </p>
                    <ul className="gtm-points">
                      {standaloneOpen ? <li>{t("correio.withSending")}</li> : null}
                      <li>{t("correio.storage", { size: box.storageGiB })}</li>
                      <li>{t("correio.sends", { count: box.monthlyRecipientDeliveries })}</li>
                      <li>{t("correio.agents")}</li>
                    </ul>
                  </article>
                ))}
              </div>
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
