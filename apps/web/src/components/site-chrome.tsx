import type { ReactNode } from "react";
import { LandingLangSwitch } from "./landing-lang-switch";
import { LandingNav } from "./landing-nav";
import { SignupCta } from "./signup-cta";

/**
 * Public marketing chrome (header + footer) shared by the landing, /pricing and
 * /alternatives/resend, so the navigation is written once and every public page
 * links to the same places. Copy comes from the "landing" catalog — it is the
 * public site's catalog; page-specific copy lives in its own namespace.
 */

/** Which public page is rendering; only the landing has the in-page anchors. */
export type PublicPage = "landing" | "pricing" | "alternatives";

export interface PublicSiteLabels {
  skip: string;
  brandAria: string;
  navAria: string;
  langAria: string;
  nav: {
    compare: string;
    plans: string;
    mcp: string;
    how: string;
    pricing: string;
    alternatives: string;
    login: string;
    signup: string;
    /** Rótulo acessível do botão que abre a nav no mobile (ver landing-nav.tsx). */
    menu: string;
    badge: string;
  };
  footer: {
    tagline: string;
    points: string[];
    cta: string;
    colProduct: string;
    colAccount: string;
    colLegal: string;
    terms: string;
    privacy: string;
    refund: string;
    login: string;
    contact: string;
    credit: string;
    ghAria: string;
    rights: string;
    pricing: string;
    alternatives: string;
  };
}

/** Landing sections by anchor; from another page they resolve back home. */
function anchorHref(page: PublicPage, hash: string): string {
  return page === "landing" ? hash : `/${hash}`;
}

export function Wordmark() {
  return (
    <span className="gtm-wordmark">
      <img
        className="gtm-wordmark-dark"
        src="/logo/mepmail-wordmark.svg"
        alt=""
        width="143"
        height="20"
      />
      <img
        className="gtm-wordmark-light"
        src="/logo/mepmail-wordmark-light.svg"
        alt=""
        width="143"
        height="20"
      />
    </span>
  );
}

// CTA de criação de conta. Todas as ocorrências públicas (topo, hero, cards de
// plano, rodapé e as páginas /pricing e /alternatives/resend) passam por aqui —
// um único ponto, que dispara o evento de conversão `signup-cta` no Umami.
export function SignupLink({ label, className }: { label: string; className?: string }) {
  return <SignupCta className={className ?? "ms-btn ms-btn-primary gtm-action"} label={label} />;
}

export function PublicHeader({
  labels,
  page,
  banner,
}: {
  labels: PublicSiteLabels;
  page: PublicPage;
  /** Optional strip rendered between the skip link and the header (the landing's announcement). */
  banner?: ReactNode;
}): ReactNode {
  return (
    <>
      <a className="gtm-skip" href="#conteudo">
        {labels.skip}
      </a>
      {banner}
      <header className="gtm-header">
        <div className="gtm-container gtm-header-inner">
          <div className="gtm-brand-group">
            <a className="gtm-brand" href="/" aria-label={labels.brandAria}>
              <Wordmark />
            </a>
            <span className="gtm-brand-badge">
              <span className="gtm-brand-dot" aria-hidden="true" />
              {labels.nav.badge}
            </span>
          </div>
          <LandingNav label={labels.navAria} menuLabel={labels.nav.menu}>
            <div className="gtm-nav-links">
              <a href={anchorHref(page, "#comparativo")}>{labels.nav.compare}</a>
              <a href="/pricing" aria-current={page === "pricing" ? "page" : undefined}>
                {labels.nav.pricing}
              </a>
              <a href={anchorHref(page, "#planos")}>{labels.nav.plans}</a>
              <a
                href="/alternatives/resend"
                aria-current={page === "alternatives" ? "page" : undefined}
              >
                {labels.nav.alternatives}
              </a>
              <a href={anchorHref(page, "#mcp")}>{labels.nav.mcp}</a>
              <a href={anchorHref(page, "#como-funciona")}>{labels.nav.how}</a>
            </div>
            <div className="gtm-nav-actions">
              <LandingLangSwitch label={labels.langAria} />
              <span className="gtm-nav-divider" aria-hidden="true" />
              <a className="gtm-nav-login" href="/login">
                {labels.nav.login}
              </a>
            </div>
          </LandingNav>
          {/* A CTA fica FORA da .gtm-nav: ela precisa continuar visível na 1ª
              linha do header quando a nav colapsa no mobile (ver landing.css). */}
          <div className="gtm-header-cta">
            <SignupLink label={labels.nav.signup} />
          </div>
        </div>
      </header>
    </>
  );
}

export function PublicFooter({
  labels,
  page,
  contact,
  legal,
}: {
  labels: PublicSiteLabels;
  page: PublicPage;
  contact: string;
  legal: { terms: string; privacy: string; refund: string };
}): ReactNode {
  return (
    <footer className="gtm-footer">
      <div className="gtm-container gtm-footer-grid">
        <div className="gtm-footer-brand">
          <a className="gtm-brand" href="/" aria-label={labels.brandAria}>
            <Wordmark />
          </a>
          <p>{labels.footer.tagline}</p>
          {/*
            TODO(claim AWS): a nota de rodapé só volta a citar o número do SES
            ("up to 500k emails/day") depois da aprovação do production access —
            a cota em produção ainda não está aprovada. Restaurar em
            messages/{en,pt-BR}/landing.json → footer.points[0] quando sair.
          */}
          <ul className="gtm-footer-points">
            {labels.footer.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <SignupLink label={labels.footer.cta} />
        </div>
        <nav className="gtm-footer-col" aria-label={labels.footer.colProduct}>
          <h3>{labels.footer.colProduct}</h3>
          <a href={anchorHref(page, "#comparativo")}>{labels.nav.compare}</a>
          <a href="/pricing">{labels.footer.pricing}</a>
          <a href="/alternatives/resend">{labels.footer.alternatives}</a>
          <a href={anchorHref(page, "#planos")}>{labels.nav.plans}</a>
          <a href={anchorHref(page, "#mcp")}>{labels.nav.mcp}</a>
          <a href={anchorHref(page, "#como-funciona")}>{labels.nav.how}</a>
        </nav>
        <nav className="gtm-footer-col" aria-label={labels.footer.colAccount}>
          <h3>{labels.footer.colAccount}</h3>
          <SignupCta label={labels.nav.signup} />
          <a href="/login">{labels.footer.login}</a>
          <a href={contact}>{labels.footer.contact}</a>
        </nav>
        <nav className="gtm-footer-col" aria-label={labels.footer.colLegal}>
          <h3>{labels.footer.colLegal}</h3>
          <a href={legal.terms}>{labels.footer.terms}</a>
          <a href={legal.privacy}>{labels.footer.privacy}</a>
          <a href={legal.refund}>{labels.footer.refund}</a>
        </nav>
      </div>
      <div className="gtm-container gtm-footer-base">
        <p>{labels.footer.rights}</p>
        <a
          className="gtm-footer-gh"
          href="https://github.com/je4ndev"
          target="_blank"
          rel="noreferrer"
        >
          <span className="gtm-sr-only">{labels.footer.ghAria}</span>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.31 9.31 0 0 1 12 6.98c.85 0 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.07.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.59.69.49A10.13 10.13 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
          </svg>
        </a>
        <p className="gtm-footer-credit">
          {labels.footer.credit}{" "}
          <a href="https://github.com/je4ndev" target="_blank" rel="noreferrer">
            Je4nDev
          </a>
        </p>
      </div>
    </footer>
  );
}
