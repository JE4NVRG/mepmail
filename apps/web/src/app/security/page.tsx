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
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "../site-v2.css";

const contact = "mailto:suporte@mepmail.dev";
const disclosureContact = "mailto:suporte@mepmail.dev";
const canonical = "/security";

type Card = { kind: string; name: string; body: string; bullets: string[] };
type ControlCard = { name: string; body: string; bullets: string[] };
type SubprocessorRow = { provider: string; role: string; location: string };
type PartnerRow = { provider: string; role: string };
type ComplianceRow = { label: string; state: string; tone: string; body: string };
type FaqItem = { q: string; a: string; link?: { label: string; href: string } };

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls(canonical);
  const t = await getTranslations("security");
  const description = t("meta.description");
  return {
    title: { absolute: t("meta.title") },
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
    <div className="gtm v2">
      <PublicHeader labels={site} page="security" />
      <main id="conteudo">
        <section className="v2-dark v2-sec v2s-hero">
          <div className="v2-wrap v2-stack">
            <p className="v2-eyebrow">{t("hero.eyebrow")}</p>
            <h1 className="v2-display">
              {t.rich("hero.title", { highlight: (chunks) => <span>{chunks}</span> })}
            </h1>
            <p className="v2-lead">{t("hero.lead")}</p>
            <ul className="v2-actions v2s-badges">
              {badges.map((badge) => (
                <li className="v2-pill v2-pill-dark-ok" key={badge}>
                  {badge}
                </li>
              ))}
            </ul>
            <div className="v2-actions">
              <SignupLink label={l("plans.cta")} className="v2-btn v2-btn-bone" />
              <a className="v2-btn v2-btn-line" href={DOCS_URL}>
                {t("hero.ctaDocs")}
              </a>
            </div>
            <p className="v2-note">{t("hero.note")}</p>
          </div>
        </section>

        <section className="v2-light v2-sec">
          <div className="v2-wrap">
            <p className="v2-eyebrow">{t("protection.eyebrow")}</p>
            <h2 className="v2-h2">{t("protection.title")}</h2>
            <p className="v2-lead v2-gap-sm">{t("protection.body")}</p>
            <div className="v2-grid">
              {protection.map((card) => (
                <article className="v2-card v2-cell" key={card.name}>
                  <p className="v2-eyebrow v2-eyebrow-mono">{card.kind}</p>
                  <h3 className="v2-h3-sm">{card.name}</h3>
                  <p className="v2-body">{card.body}</p>
                  <details className="v2s-more">
                    <summary>{t("more")}</summary>
                    <ul className="v2s-points">
                      {card.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </details>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="v2-dark v2-sec">
          <div className="v2-wrap">
            <p className="v2-eyebrow">{t("advantages.eyebrow")}</p>
            <h2 className="v2-h2">{t("advantages.title")}</h2>
            <p className="v2-lead v2-gap-sm">{t("advantages.body")}</p>
            <div className="v2-grid">
              {advantages.map((card) => (
                <article className="v2-card v2-cell" key={card.name}>
                  <p className="v2-eyebrow v2-eyebrow-mono">{card.kind}</p>
                  <h3 className="v2-h3-sm">{card.name}</h3>
                  <p className="v2-body">{card.body}</p>
                  <details className="v2s-more">
                    <summary>{t("more")}</summary>
                    <ul className="v2s-points">
                      {card.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </details>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="v2-light v2-sec" id="controles">
          <div className="v2-wrap">
            <p className="v2-eyebrow">{t("controls.eyebrow")}</p>
            <h2 className="v2-h2">{t("controls.title")}</h2>
            <p className="v2-lead v2-gap-sm">{t("controls.body")}</p>
            <div className="v2-grid">
              {controls.map((control) => (
                <article className="v2-card v2-cell" key={control.name}>
                  <h3 className="v2-h3-sm">{control.name}</h3>
                  <p className="v2-body">{control.body}</p>
                  <details className="v2s-more">
                    <summary>{t("more")}</summary>
                    <ul className="v2s-points">
                      {control.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </details>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="v2-dark v2-sec" id="subprocessadores">
          <div className="v2-wrap">
            <p className="v2-eyebrow">{t("subprocessors.eyebrow")}</p>
            <h2 className="v2-h2">{t("subprocessors.title")}</h2>
            <p className="v2-lead v2-gap-sm">{t("subprocessors.body")}</p>
            <section
              className="v2-table-box v2s-table"
              aria-label={t("subprocessors.title")}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a tabela com overflow precisa de foco para rolagem por teclado
              tabIndex={0}
            >
              <table className="v2-table">
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
            <p className="v2-note v2s-gap">{t("subprocessors.note")}</p>

            <h3 className="v2-h3 v2s-gap">{t("partners.title")}</h3>
            <p className="v2-body">{t("partners.body")}</p>
            <ul className="v2s-partners">
              {partners.map((partner) => (
                <li key={partner.provider}>
                  <strong>{partner.provider}</strong>
                  <span>{partner.role}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="v2-light v2-sec" id="compliance">
          <div className="v2-wrap">
            <p className="v2-eyebrow">{t("compliance.eyebrow")}</p>
            <h2 className="v2-h2">{t("compliance.title")}</h2>
            <p className="v2-lead v2-gap-sm">{t("compliance.body")}</p>
            <ul className="v2s-status">
              {compliance.map((row) => (
                <li className="v2-card" key={row.label}>
                  <p className="v2s-status-head">
                    <strong>{row.label}</strong>
                    <span
                      className={`v2-pill ${row.tone === "ok" ? "v2-pill-ok" : "v2-pill-wait"}`}
                    >
                      {row.state}
                    </span>
                  </p>
                  <p className="v2-body">
                    {row.body}
                    {row.tone === "ok" ? (
                      <>
                        {" "}
                        <a className="v2-link-accent" href={privacyHref}>
                          {t("compliance.privacyLink")}
                        </a>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
            <p className="v2-note v2s-gap">{t("compliance.note")}</p>
          </div>
        </section>

        <section className="v2-dark v2-sec" id="faq">
          <div className="v2-wrap v2-narrow">
            <p className="v2-eyebrow">{t("faq.eyebrow")}</p>
            <h2 className="v2-h2">{t("faq.title")}</h2>
            <p className="v2-lead v2-gap-sm">{t("faq.body")}</p>
            <div className="v2s-faq">
              {faq.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p className="v2-body">
                    {item.a}
                    {item.link ? (
                      <>
                        {" "}
                        <a className="v2-link-accent" href={item.link.href}>
                          {item.link.label}
                        </a>
                      </>
                    ) : null}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="v2-light v2-sec" id="disclosure">
          <div className="v2-wrap v2-narrow">
            <p className="v2-eyebrow">{t("disclosure.eyebrow")}</p>
            <h2 className="v2-h2">{t("disclosure.title")}</h2>
            <p className="v2-lead v2-gap-sm">{t("disclosure.body")}</p>
            <ul className="v2s-points v2s-gap">
              {disclosure.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="v2s-gap">
              <a className="v2-btn v2-btn-ink" href={disclosureContact}>
                {t("disclosure.cta")}
              </a>
            </p>
          </div>
        </section>

        <section className="v2-violet v2-sec v2-center">
          <div className="v2-wrap v2-stack">
            <h2 className="v2-h2">{t("close.title")}</h2>
            <p className="v2-lead">{t("close.body")}</p>
            <div className="v2-actions">
              <SignupLink label={l("plans.cta")} className="v2-btn v2-btn-bone" />
              <a className="v2-btn v2-btn-line" href={DOCS_URL}>
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
