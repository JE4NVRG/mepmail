import { getTranslations } from "next-intl/server";
import {
  PublicFooter,
  PublicHeader,
  type PublicPage,
  type PublicSiteLabels,
} from "@/components/site-chrome";
import { legalLinks } from "@/lib/legal-links";
import "./legal-document.css";

export type LegalSection = {
  title: string;
  body?: string[];
  list?: string[];
};

export type LegalDoc = {
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
  contact: string;
};

/** The public site's support address, the same the other public pages publish. */
const CONTACT = "mailto:suporte@mepmail.dev";

/**
 * The legal pages wear the public chrome, so they are reachable by navigation
 * and carry the language switcher. site-chrome owns the PublicPage union and no
 * member of it is the legal set: "alternatives" is the member that marks no nav
 * item as current here and keeps the section anchors pointing at the home page.
 */
const CHROME_PAGE: PublicPage = "alternatives";

/**
 * One legal document (terms, privacy, refund) inside the public header and
 * footer. The document itself comes from the "legal" catalog, untouched.
 */
export async function LegalDocument({ doc }: { doc: LegalDoc }) {
  const l = await getTranslations("landing");
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;

  return (
    <div className="gtm legal">
      <PublicHeader labels={site} page={CHROME_PAGE} />
      <main id="conteudo" className="legal-main">
        <h1>{doc.title}</h1>
        <p className="legal-updated">{doc.updated}</p>
        <p className="legal-intro">{doc.intro}</p>
        {doc.sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {(section.body ?? []).map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {section.list ? (
              <ul>
                {section.list.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
        <p className="legal-contact">{doc.contact}</p>
      </main>
      <PublicFooter labels={site} page={CHROME_PAGE} contact={CONTACT} legal={legalLinks()} />
    </div>
  );
}
