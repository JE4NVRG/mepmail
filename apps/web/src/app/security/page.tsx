import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { DOCS_URL } from "@/lib/docs-links";
import { legalLinks } from "@/lib/legal-links";
import "../landing.css";

const contact = "mailto:jean@mepmail.dev";
const disclosureContact = "mailto:jean@mepmail.dev";
const canonical = "/security";

type Card = { kind: string; name: string; body: string; bullets: string[] };
type ControlCard = { name: string; body: string; bullets: string[] };
type SubprocessorRow = { provider: string; role: string; location: string };
type PartnerRow = { provider: string; role: string };
type ComplianceRow = { label: string; state: string; tone: string; body: string };
type FaqItem = { q: string; a: string; link?: { label: string; href: string } };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("security");
  const description = t("meta.description");
  return {
    title: { absolute: t("meta.title") },
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      title: t("meta.title"),
      description,
      url: canonical,
      type: "website",
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/**
 * Página pública /security em modo vitrine: abre com as vantagens que existem
 * de fato (residência de dados na Alemanha, AGPL/open source, self-host,
 * isolamento por time) e só então detalha os controles, os subprocessadores, o
 * estado de compliance — SOC 2 e ISO 27001 como item de roadmap, nunca como
 * manchete — e as perguntas que uma revisão enterprise realmente faz. A copy
 * vive no namespace "security"; o chrome e o catálogo público vêm de "landing".
 */
export default async function SecurityPage() {
  const t = await getTranslations("security");
  const l = await getTranslations("landing");
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const badges = t.raw("hero.badges") as string[];
  const protection = t.raw("protection.items") as Card[];
  const advantages = t.raw("advantages.items") as Card[];
  const controls = t.raw("controls.items") as ControlCard[];
  const columns = t.raw("subprocessors.columns") as string[];
  const rows = t.raw("subprocessors.rows") as SubprocessorRow[];
  const partners = t.raw("partners.items") as PartnerRow[];
  const compliance = t.raw("compliance.items") as ComplianceRow[];
  const faq = t.raw("faq.items") as FaqItem[];
  const disclosure = t.raw("disclosure.bullets") as string[];
  const privacyHref = legalLinks().privacy;

  return (
    <div className="gtm">
      <PublicHeader labels={site} page="security" />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("hero.eyebrow")}</p>
            <h1>{t.rich("hero.title", { highlight: (chunks) => <span>{chunks}</span> })}</h1>
            <p className="gtm-lead">{t("hero.lead")}</p>
            <ul className="gtm-chips">
              {badges.map((badge) => (
                <li className="gtm-chip" key={badge}>
                  {badge}
                </li>
              ))}
            </ul>
            <div className="gtm-actions">
              <SignupLink label={l("plans.cta")} />
              <a className="ms-btn ms-btn-secondary gtm-action" href={DOCS_URL}>
                {t("hero.ctaDocs")}
              </a>
            </div>
            <p className="gtm-note">{t("hero.note")}</p>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("protection.eyebrow")}</p>
            <h2>{t("protection.title")}</h2>
            <p>{t("protection.body")}</p>
            <div className="gtm-integrations">
              {protection.map((card) => (
                <article className="gtm-integration" key={card.name}>
                  <p className="gtm-integration-kind">{card.kind}</p>
                  <h3>{card.name}</h3>
                  <p>{card.body}</p>
                  <ul className="gtm-points">
                    {card.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("advantages.eyebrow")}</p>
            <h2>{t("advantages.title")}</h2>
            <p>{t("advantages.body")}</p>
            <div className="gtm-integrations gtm-pairs">
              {advantages.map((card) => (
                <article className="gtm-integration" key={card.name}>
                  <p className="gtm-integration-kind">{card.kind}</p>
                  <h3>{card.name}</h3>
                  <p>{card.body}</p>
                  <ul className="gtm-points">
                    {card.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="controles">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("controls.eyebrow")}</p>
            <h2>{t("controls.title")}</h2>
            <p>{t("controls.body")}</p>
            <div className="gtm-integrations">
              {controls.map((control) => (
                <article className="gtm-integration" key={control.name}>
                  <h3>{control.name}</h3>
                  <p>{control.body}</p>
                  <ul className="gtm-points">
                    {control.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="gtm-section" id="subprocessadores">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("subprocessors.eyebrow")}</p>
            <h2>{t("subprocessors.title")}</h2>
            <p>{t("subprocessors.body")}</p>
            <section
              className="gtm-table-scroll"
              aria-label={t("subprocessors.title")}
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
                  {rows.map((row) => (
                    <tr key={row.provider}>
                      <th scope="row">{row.provider}</th>
                      <td>{row.role}</td>
                      <td>{row.location}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <p className="gtm-note">{t("subprocessors.note")}</p>

            <h3 className="gtm-subhead">{t("partners.title")}</h3>
            <p>{t("partners.body")}</p>
            <ul className="gtm-partners">
              {partners.map((partner) => (
                <li key={partner.provider}>
                  <strong>{partner.provider}</strong>
                  <span className="gtm-partner-role">{partner.role}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="compliance">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("compliance.eyebrow")}</p>
            <h2>{t("compliance.title")}</h2>
            <p>{t("compliance.body")}</p>
            <ul className="gtm-status-grid">
              {compliance.map((row) => (
                <li className="gtm-status-row" key={row.label}>
                  <div className="gtm-status-head">
                    <span className="gtm-status-label">{row.label}</span>
                    <span className={`gtm-status-chip gtm-is-${row.tone}`}>{row.state}</span>
                  </div>
                  <p className="gtm-status-body">
                    {row.body}
                    {row.tone === "ok" ? (
                      <>
                        {" "}
                        <a href={privacyHref}>{t("compliance.privacyLink")}</a>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
            <p className="gtm-note">{t("compliance.note")}</p>
          </div>
        </section>

        <section className="gtm-section" id="faq">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("faq.eyebrow")}</p>
            <h2>{t("faq.title")}</h2>
            <p>{t("faq.body")}</p>
            <div className="gtm-faq">
              {faq.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>
                    {item.a}
                    {item.link ? (
                      <>
                        {" "}
                        <a href={item.link.href}>{item.link.label}</a>
                      </>
                    ) : null}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("disclosure.eyebrow")}</p>
            <h2>{t("disclosure.title")}</h2>
            <p>{t("disclosure.body")}</p>
            <ul className="gtm-points">
              {disclosure.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="gtm-note">
              <a className="ms-btn ms-btn-secondary gtm-action" href={disclosureContact}>
                {t("disclosure.cta")}
              </a>
            </p>
          </div>
        </section>

        <section className="gtm-section gtm-close">
          <div className="gtm-container">
            <h2>{t("close.title")}</h2>
            <p>{t("close.body")}</p>
            <div className="gtm-actions">
              <SignupLink label={l("plans.cta")} />
              <a className="ms-btn ms-btn-secondary gtm-action" href={DOCS_URL}>
                {t("close.cta")}
              </a>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="security" contact={contact} legal={legalLinks()} />
    </div>
  );
}
