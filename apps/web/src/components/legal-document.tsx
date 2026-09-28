import Link from "next/link";
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

export type LegalLinks = {
  terms: string;
  privacy: string;
  refund: string;
};

const ROUTES: Array<{ href: string; key: keyof LegalLinks }> = [
  { href: "/terms", key: "terms" },
  { href: "/privacy", key: "privacy" },
  { href: "/refund", key: "refund" },
];

export function LegalDocument({ doc, links }: { doc: LegalDoc; links: LegalLinks }) {
  return (
    <div className="legal">
      <header className="legal-top">
        <Link className="legal-brand" href="/" aria-label="MepMail">
          <img
            className="legal-wordmark-dark"
            src="/logo/mepmail-wordmark.svg"
            alt="MepMail"
            width={150}
            height={20}
          />
          <img
            className="legal-wordmark-light"
            src="/logo/mepmail-wordmark-light.svg"
            alt=""
            width={150}
            height={20}
          />
        </Link>
      </header>
      <main className="legal-main">
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
      <footer className="legal-foot">
        <nav aria-label="Legal">
          {ROUTES.map((route) => (
            <Link key={route.href} href={route.href}>
              {links[route.key]}
            </Link>
          ))}
        </nav>
        <p>© 2026 MepMail</p>
      </footer>
    </div>
  );
}
