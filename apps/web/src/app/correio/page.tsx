import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PublicFooter, PublicHeader, type PublicSiteLabels } from "@/components/site-chrome";
import { legalLinks } from "@/lib/legal-links";
import { LaunchPlanPreview } from "./launch-plan-preview";
import "../landing.css";
import "./correio.css";

const canonical = "/correio";
const docsOrigin = "https://docs-mepmail.je4ndev.com";

type TextStep = { label: string; text: string };
type TextItem = { title: string; body: string };
type UseCase = TextItem & { kind: string; address: string; points: string[] };
type Integration = TextItem & { kind: string; status: string; link: string; path: string };
type FaqItem = { q: string; a: string };
type ComparisonRow = { label: string; sending: string; combined: string };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("correio");
  return {
    title: { absolute: t("meta.title") },
    description: t("meta.description"),
    alternates: { canonical },
    // This launch preview is prepared in staging; opening access is a separate release.
    robots: { index: false, follow: true },
    openGraph: {
      title: t("meta.title"),
      description: t("meta.description"),
      url: canonical,
      type: "website",
      images: [{ url: "/og.png", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

export default async function CorreioPage() {
  const [t, l, locale] = await Promise.all([
    getTranslations("correio"),
    getTranslations("landing"),
    getLocale(),
  ]);
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const docs = `${docsOrigin}${locale === "pt-BR" ? "/pt-BR" : ""}`;
  const audiences = t.raw("hero.audiences") as string[];
  const exampleSteps = t.raw("example.steps") as TextStep[];
  const useCases = t.raw("use.items") as UseCase[];
  const permissions = t.raw("control.permissions") as TextItem[];
  const setup = t.raw("setup.steps") as TextItem[];
  const integrations = t.raw("integrations.items") as Integration[];
  const faq = t.raw("faq.items") as FaqItem[];
  const comparison = t.raw("comparison.rows") as ComparisonRow[];

  return (
    <div className="gtm correio">
      <PublicHeader labels={site} page="correio" />
      <main id="conteudo">
        <section className="correio-hero" aria-labelledby="correio-title">
          <div className="gtm-container correio-hero-grid">
            <div className="correio-hero-copy">
              <p className="correio-eyebrow">{t("hero.eyebrow")}</p>
              <h1 id="correio-title">
                {t("hero.title")}
                <span className="correio-title-end">{t("hero.titleEnd")}</span>
              </h1>
              <p className="correio-lead">{t("hero.lead")}</p>
              <div className="correio-actions">
                <a className="ms-btn ms-btn-primary correio-action" href="#como-funciona">
                  {t("hero.primary")} <span aria-hidden="true">→</span>
                </a>
                <a className="ms-btn ms-btn-secondary correio-action" href="/pricing">
                  {t("hero.secondary")}
                </a>
              </div>
              <p className="correio-note correio-hero-note">{t("hero.note")}</p>
              <p className="correio-status">{t("hero.status")}</p>
            </div>

            <aside className="correio-example" aria-labelledby="correio-example-label">
              <p className="correio-example-label" id="correio-example-label">
                {t("example.label")}
              </p>
              <div className="correio-identity">
                <p className="correio-eyebrow">{t("example.identity")}</p>
                <p className="correio-address">{t("example.address")}</p>
                <p className="correio-example-role">{t("example.role")}</p>
              </div>
              <ol className="correio-example-steps">
                {exampleSteps.map((step, index) => (
                  <li key={step.label}>
                    <span className="correio-step-marker" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <h2>{step.label}</h2>
                      <p>{step.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="correio-note correio-example-foot">{t("example.foot")}</p>
            </aside>
          </div>
          <div className="gtm-container">
            <ul className="correio-audiences">
              {audiences.map((audience) => (
                <li key={audience}>{audience}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="correio-section" aria-labelledby="correio-use-title">
          <div className="gtm-container">
            <div className="correio-section-heading">
              <div>
                <p className="correio-eyebrow">{t("use.eyebrow")}</p>
                <h2 id="correio-use-title">{t("use.title")}</h2>
              </div>
              <p className="correio-section-lead">{t("use.body")}</p>
            </div>
            <div className="correio-use-grid">
              {useCases.map((item) => (
                <article className="correio-use-case" key={item.kind}>
                  <p className="correio-eyebrow">{item.kind}</p>
                  <h3>{item.title}</h3>
                  <p className="correio-use-address">{item.address}</p>
                  <p>{item.body}</p>
                  <ul className="correio-points">
                    {item.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
            <p className="correio-note correio-under-grid">{t("use.exampleNote")}</p>
          </div>
        </section>

        <section
          className="correio-section correio-alternate"
          aria-labelledby="correio-control-title"
        >
          <div className="gtm-container correio-control-grid">
            <div>
              <p className="correio-eyebrow">{t("control.eyebrow")}</p>
              <h2 id="correio-control-title">{t("control.title")}</h2>
              <p>{t("control.body")}</p>
              <p className="correio-note">{t("control.note")}</p>
            </div>
            <dl className="correio-permissions">
              {permissions.map((permission, index) => (
                <div key={permission.title}>
                  <dt>
                    <span className="correio-step-marker" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {permission.title}
                  </dt>
                  <dd>{permission.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section
          className="correio-section"
          id="como-funciona"
          aria-labelledby="correio-setup-title"
        >
          <div className="gtm-container">
            <div className="correio-section-heading">
              <div>
                <p className="correio-eyebrow">{t("setup.eyebrow")}</p>
                <h2 id="correio-setup-title">{t("setup.title")}</h2>
              </div>
              <p className="correio-section-lead">{t("setup.body")}</p>
            </div>
            <ol className="correio-setup-steps">
              {setup.map((step, index) => (
                <li key={step.title}>
                  <span className="correio-setup-number" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
            <aside className="correio-migration-note">
              <div>
                <h3>{t("setup.warningTitle")}</h3>
                <p>{t("setup.warning")}</p>
              </div>
              <a className="correio-text-link" href={`${docs}/concepts/domains`}>
                {t("setup.docs")} <span aria-hidden="true">↗</span>
              </a>
            </aside>
          </div>
        </section>

        <section
          className="correio-section correio-alternate"
          aria-labelledby="correio-integrations-title"
        >
          <div className="gtm-container">
            <div className="correio-section-heading">
              <div>
                <p className="correio-eyebrow">{t("integrations.eyebrow")}</p>
                <h2 id="correio-integrations-title">{t("integrations.title")}</h2>
              </div>
              <p className="correio-section-lead">{t("integrations.body")}</p>
            </div>
            <div className="correio-integrations-grid">
              {integrations.map((item) => (
                <article className="correio-integration" key={item.kind}>
                  <p className="correio-eyebrow">{item.kind}</p>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                  <p className="correio-integration-status">{item.status}</p>
                  <a className="correio-text-link" href={`${docs}${item.path}`}>
                    {item.link} <span aria-hidden="true">↗</span>
                  </a>
                </article>
              ))}
            </div>
            <a className="correio-text-link correio-under-grid" href="/integrations">
              {t("integrations.all")} <span aria-hidden="true">→</span>
            </a>
          </div>
        </section>

        <section className="correio-section" aria-labelledby="correio-plans-title">
          <div className="gtm-container">
            <div className="correio-section-heading">
              <div>
                <p className="correio-eyebrow">{t("plans.eyebrow")}</p>
                <h2 id="correio-plans-title">{t("plans.title")}</h2>
              </div>
              <p className="correio-section-lead">{t("plans.body")}</p>
            </div>
            <div className="correio-plans-grid">
              <article className="correio-plan">
                <p className="correio-eyebrow">{t("plans.sending.label")}</p>
                <h3>{t("plans.sending.title")}</h3>
                <p>{t("plans.sending.body")}</p>
                <a className="ms-btn ms-btn-secondary correio-action" href="/pricing">
                  {t("plans.sending.link")}
                </a>
              </article>
              <article className="correio-plan">
                <p className="correio-eyebrow">{t("plans.mail.label")}</p>
                <h3>{t("plans.mail.title")}</h3>
                <p>{t("plans.mail.body")}</p>
                <p className="correio-note">{t("plans.mail.note")}</p>
              </article>
            </div>
            <div className="correio-comparison">
              <table>
                <caption>{t("comparison.caption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("comparison.feature")}</th>
                    <th scope="col">{t("comparison.sending")}</th>
                    <th scope="col">{t("comparison.combined")}</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      <td>{row.sending}</td>
                      <td>{row.combined}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="correio-note correio-under-grid">{t("comparison.earlyNote")}</p>
            <LaunchPlanPreview />
            <p className="correio-note correio-under-grid">{t("plans.terms")}</p>
          </div>
        </section>

        <section
          className="correio-section correio-alternate"
          aria-labelledby="correio-devices-title"
        >
          <div className="gtm-container">
            <div className="correio-section-heading">
              <div>
                <p className="correio-eyebrow">{t("devices.eyebrow")}</p>
                <h2 id="correio-devices-title">{t("devices.title")}</h2>
              </div>
              <p className="correio-section-lead">{t("devices.body")}</p>
            </div>
            <div className="correio-device-grid">
              <article>
                <h3>{t("devices.browser.title")}</h3>
                <p>{t("devices.browser.body")}</p>
              </article>
              <article>
                <h3>{t("devices.install.title")}</h3>
                <p>{t("devices.install.body")}</p>
              </article>
            </div>
            <p className="correio-note correio-under-grid">{t("devices.note")}</p>
          </div>
        </section>

        <section className="correio-section correio-alternate" aria-labelledby="correio-faq-title">
          <div className="gtm-container correio-faq-grid">
            <h2 id="correio-faq-title">{t("faq.title")}</h2>
            <div className="correio-faq">
              {faq.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="correio-section correio-close" aria-labelledby="correio-close-title">
          <div className="gtm-container">
            <p className="correio-eyebrow">{t("close.eyebrow")}</p>
            <h2 id="correio-close-title">{t("close.title")}</h2>
            <p>{t("close.body")}</p>
            <div className="correio-actions">
              <a className="ms-btn ms-btn-primary correio-action" href="/pricing">
                {t("close.primary")} <span aria-hidden="true">→</span>
              </a>
              <a className="ms-btn ms-btn-secondary correio-action" href={`${docs}/mailboxes`}>
                {t("close.secondary")}
              </a>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter
        labels={site}
        page="correio"
        contact="mailto:suporte@mepmail.dev"
        legal={legalLinks()}
      />
    </div>
  );
}
