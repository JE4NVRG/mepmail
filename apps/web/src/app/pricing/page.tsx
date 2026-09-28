import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PlanCard, type PlanCardLabels } from "@/components/plan-card";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { type PlanCopy, plansWithCopy } from "@/lib/landing-plans";
import { legalLinks } from "@/lib/legal-links";
import "../landing.css";

const contact = "mailto:jean@je4ndev.com";
const canonical = "/pricing";

type FaqItem = { q: string; a: string };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pricing");
  const description = t("meta.description");
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
  const allPlans = plansWithCopy(l.raw("plans.items") as PlanCopy[]);
  const includedPoints = t.raw("included.points") as string[];
  const faq = t.raw("faq.items") as FaqItem[];

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
