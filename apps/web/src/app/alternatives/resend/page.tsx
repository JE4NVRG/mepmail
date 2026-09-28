import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CodeDemo } from "@/components/code-demo";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import {
  CLAIM_ANCHOR_ROW,
  MAX_RESEND_SAVINGS_PCT,
  MIN_RESEND_SAVINGS_PCT,
  RESEND_PRICING_SOURCE,
  RESEND_ROWS,
  resendSavings,
} from "@/lib/alternatives-resend";
import { formatUsd } from "@/lib/landing-pricing";
import { legalLinks } from "@/lib/legal-links";
import "../../landing.css";

const contact = "mailto:jean@je4ndev.com";
const canonical = "/alternatives/resend";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("alternatives");
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
 * Honest "Resend alternative" page: the compatible surface, what is explicitly
 * NOT promised, and the price difference computed from Resend's public list
 * (@/lib/alternatives-resend) with its source and read date on the page.
 */
export default async function ResendAlternativePage() {
  const t = await getTranslations("alternatives");
  const l = await getTranslations("landing");
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const columns = t.raw("table.columns") as string[];
  const sameItems = t.raw("same.items") as string[];
  const differentItems = t.raw("different.items") as string[];
  const steps = t.raw("steps.items") as string[];

  return (
    <div className="gtm">
      <PublicHeader labels={site} page="alternatives" />
      <main id="conteudo">
        <section className="gtm-section gtm-alt gtm-hero">
          <div className="gtm-container">
            <div className="gtm-hero-grid">
              <div className="gtm-hero-copy">
                <p className="gtm-eyebrow">{t("eyebrow")}</p>
                <h1>{t.rich("title", { highlight: (chunks) => <span>{chunks}</span> })}</h1>
                <p className="gtm-lead">{t("lead")}</p>
                <div className="gtm-actions">
                  <SignupLink label={l("plans.cta")} />
                  <a className="ms-btn ms-btn-secondary gtm-action" href="/pricing">
                    {t("pricingLink")}
                  </a>
                </div>
                <p className="gtm-note">{t("note")}</p>
              </div>
              <CodeDemo subject={l("hero.demo.subject")} caption={l("hero.demo.caption")} />
            </div>
          </div>
        </section>

        <section className="gtm-section" id="comparativo">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("eyebrow")}</p>
            <h2>{t("table.title")}</h2>
            <p>{t("table.intro")}</p>
            <section
              className="gtm-table-scroll"
              aria-label={t("table.title")}
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
                  {RESEND_ROWS.map((row) => {
                    const savings = resendSavings(row);
                    return (
                      <tr key={row.label}>
                        <th scope="row">{row.label}</th>
                        <td>{formatUsd(row.resend)}</td>
                        <td>{formatUsd(row.mepmail)}</td>
                        <td>
                          {t("table.rowAdvantage", {
                            percent: savings.pct,
                            usd: formatUsd(savings.usd),
                          })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
            <p className="gtm-note">
              {t.rich("table.source", {
                link: (chunks) => (
                  <a href={RESEND_PRICING_SOURCE.url} target="_blank" rel="noreferrer">
                    {chunks}
                  </a>
                ),
                date: RESEND_PRICING_SOURCE.checkedOn,
              })}
            </p>
            <div className="gtm-claim">
              <h3>{t("claim.title")}</h3>
              <p className="gtm-note">
                {t("claim.body", {
                  volume: CLAIM_ANCHOR_ROW.label,
                  sendgrid: formatUsd(CLAIM_ANCHOR_ROW.sendgrid),
                  mepmail: formatUsd(CLAIM_ANCHOR_ROW.mepmail),
                  min: MIN_RESEND_SAVINGS_PCT,
                  max: MAX_RESEND_SAVINGS_PCT,
                })}
              </p>
            </div>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container gtm-split">
            <div>
              <h3>{t("same.title")}</h3>
              <ul className="gtm-points">
                {sameItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>{t("different.title")}</h3>
              <ul className="gtm-points">
                {differentItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("steps.eyebrow")}</p>
            <h2>{t("steps.title")}</h2>
            <ol className="gtm-steps">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="gtm-note">{t("steps.note")}</p>
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
      <PublicFooter labels={site} page="alternatives" contact={contact} legal={legalLinks()} />
    </div>
  );
}
