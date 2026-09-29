import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PublicFooter, PublicHeader, type PublicSiteLabels } from "@/components/site-chrome";
import { DOCS_URL } from "@/lib/docs-links";
import { legalLinks } from "@/lib/legal-links";
import "../landing.css";

const contact = "mailto:jean@je4ndev.com";
const disclosureContact = "mailto:security@je4ndev.com";
const canonical = "/security";

type ControlCard = { name: string; body: string; bullets: string[] };
type SubprocessorRow = { provider: string; role: string; location: string };

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
      images: [{ url: "/og.png", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/**
 * Página pública /security: os controles que existem de fato no produto (cada
 * afirmação verificável no código ou na infraestrutura), a lista de
 * subprocessadores e uma seção de honestidade sobre certificações — SOC 2 e
 * ISO 27001 estão no roadmap e não são mantidos hoje. A copy vive no namespace
 * "security"; o chrome e o catálogo público vêm de "landing".
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
  const controls = t.raw("controls.items") as ControlCard[];
  const columns = t.raw("subprocessors.columns") as string[];
  const rows = t.raw("subprocessors.rows") as SubprocessorRow[];
  const certifications = t.raw("certifications.items") as string[];
  const disclosure = t.raw("disclosure.bullets") as string[];

  return (
    <div className="gtm">
      <PublicHeader labels={site} page="security" />
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("hero.eyebrow")}</p>
            <h1>{t("hero.title")}</h1>
            <p className="gtm-lead">{t("hero.lead")}</p>
            <p className="gtm-note">{t("hero.note")}</p>
          </div>
        </section>

        <section className="gtm-section gtm-alt">
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

        <section className="gtm-section">
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
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("certifications.eyebrow")}</p>
            <h2>{t("certifications.title")}</h2>
            <p>{t("certifications.body")}</p>
            <ul className="gtm-points">
              {certifications.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="gtm-section">
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
            <a className="ms-btn ms-btn-secondary gtm-action" href={DOCS_URL}>
              {t("close.cta")}
            </a>
          </div>
        </section>
      </main>
      <PublicFooter labels={site} page="security" contact={contact} legal={legalLinks()} />
    </div>
  );
}
