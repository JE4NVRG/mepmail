import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DocsLink } from "@/components/public-events";
import {
  PublicFooter,
  PublicHeader,
  type PublicSiteLabels,
  SignupLink,
} from "@/components/site-chrome";
import { StructuredData } from "@/components/structured-data";
import { LINUX_DOWNLOAD_URL, WINDOWS_STORE_URL } from "@/lib/desktop-download";
import { formatBrlPrice, formatUsd } from "@/lib/landing-pricing";
import { CORREIO_FROM_BRL_CENTS, CORREIO_FROM_CENTS, LAUNCH_OFFER } from "@/lib/launch-offer";
import { legalLinks } from "@/lib/legal-links";
import { signupMailboxHref } from "@/lib/public-intent";
import { correioJsonLd, faqJsonLd, siteBaseUrl } from "@/lib/structured-data";
import { titlePhrases } from "@/lib/title-phrases";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";
import "../site-v2.css";

const canonical = "/correio";
const docsOrigin = "https://docs.mepmail.dev";
/** Where a visitor without a domain lands: signing up opens the Correio, where an
 * existing Gmail, iCloud, Yahoo, Zoho or IMAP account connects for free. */
const MAIL_SIGNUP = "/signup?next=/mail";

type TextItem = { title: string; body: string };
type Kind = TextItem & { address: string };
type Integration = TextItem & { kind: string; status: string; link: string; path: string };
type FaqItem = { q: string; a: string };
type ComparisonRow = { label: string; sending: string; combined: string };

/**
 * /correio since v2 (Jean, 2026-10-19), while Correio is sold on its own: bone and serif,
 * the agent's permissions on a dark band, the free door for accounts people already have
 * on violet, and the three plans with their own buttons. Prices come from LAUNCH_OFFER.
 */
export async function CorreioV2() {
  const [t, c, p, l, locale] = await Promise.all([
    getTranslations("correio.v2"),
    getTranslations("correio"),
    getTranslations("pricing"),
    getTranslations("landing"),
    getLocale(),
  ]);
  const brazil = locale === "pt-BR";
  const site = {
    skip: l("skip"),
    brandAria: l("brandAria"),
    navAria: l("navAria"),
    langAria: l("lang.aria"),
    nav: l.raw("nav"),
    footer: l.raw("footer"),
  } as PublicSiteLabels;
  const docs = `${docsOrigin}${brazil ? "/pt-BR" : ""}`;
  const number = new Intl.NumberFormat(locale);
  const money = (brlCents: number, usdCents: number) =>
    brazil ? formatBrlPrice(brlCents, locale) : formatUsd(usdCents / 100, locale);
  const otherMoney = (brlCents: number, usdCents: number) =>
    brazil ? formatUsd(usdCents / 100, locale) : formatBrlPrice(brlCents, locale);
  const mailFrom = money(CORREIO_FROM_BRL_CENTS, CORREIO_FROM_CENTS);
  const plans = LAUNCH_OFFER.correioPlans;
  const abroad = plans.map((plan) => otherMoney(plan.brlMonthlyCents, plan.monthlyCents));
  const kinds = t.raw("kinds.items") as Kind[];
  const permissions = c.raw("control.permissions") as TextItem[];
  const steps = t.raw("setup.steps") as TextItem[];
  const integrations = c.raw("integrations.items") as Integration[];
  const comparison = c.raw("comparison.rows") as ComparisonRow[];
  const faq = c.raw("faq.items") as FaqItem[];
  const base = siteBaseUrl();
  const graph = [
    correioJsonLd(base, `${base}${(await publicPageUrls(canonical)).url}`, c("meta.description")),
    faqJsonLd(faq),
  ];
  const b = (chunks: ReactNode) => <strong>{chunks}</strong>;

  return (
    <div className="gtm v2">
      <StructuredData graph={graph} />
      <PublicHeader labels={site} page="correio" />
      <main id="conteudo">
        <section className="v2-light v2-sec" aria-labelledby="correio-title">
          <div className="v2-wrap v2-row">
            <div className="v2-stack">
              <p className="v2-eyebrow">{t("hero.eyebrow")}</p>
              <h1 id="correio-title" className="v2-display">
                {titlePhrases(t("hero.title")).join(" ")}
              </h1>
              <p className="v2-lead">{t("hero.lead")}</p>
              <div className="v2-actions">
                <SignupLink
                  label={l("domainHero.cta")}
                  className="v2-btn v2-btn-ink"
                  mailboxPlan="choose"
                />
                <a className="v2-link" href="#planos">
                  {t("hero.plans")}
                </a>
              </div>
              <p className="v2-note">{t.rich("hero.note", { price: mailFrom, b })}</p>
              <p className="v2-actions">
                <span className="v2-pill v2-pill-ok">{c("release.heroStatus")}</span>
                <a className="v2-link-accent" href={MAIL_SIGNUP}>
                  {t("hero.noDomain")} <span aria-hidden="true">→</span>
                </a>
              </p>
            </div>
            <figure>
              <div className="v2-inbox">
                <p className="v2-inbox-bar">
                  <span className="v2-dot" aria-hidden="true" />
                  <span>{brazil ? "suporte@suaempresa.com.br" : "support@yourcompany.com"}</span>
                  <span>{t("inbox.count")}</span>
                </p>
                <div className="v2-inbox-body">
                  <ul className="v2-inbox-list">
                    <li className="v2-inbox-item is-current">
                      <strong>
                        <span>{c("demo.sender")}</span>
                        <span className="v2-address">{t("inbox.now")}</span>
                      </strong>
                      <span>{c("demo.subject")}</span>
                    </li>
                    <li className="v2-inbox-item">
                      <strong>
                        <span>{c("demo.otherSender")}</span>
                        <span>{t("inbox.time")}</span>
                      </strong>
                      <span>{c("demo.otherSubject")}</span>
                    </li>
                    <li className="v2-inbox-item">
                      <strong>
                        <span>{t("inbox.thirdSender")}</span>
                        <span>{t("inbox.yesterday")}</span>
                      </strong>
                      <span>{t("inbox.thirdSubject")}</span>
                    </li>
                  </ul>
                  <div className="v2-inbox-read">
                    <p>
                      <strong>{c("demo.sender")}:</strong> {c("demo.preview")}
                    </p>
                    <div className="v2-approval-draft">
                      <small>{c("demo.agent")}</small>
                      <p>{c("demo.reply")}</p>
                    </div>
                    <div className="v2-approval-row">
                      <span className="v2-pill v2-pill-wait">{c("demo.awaiting")}</span>
                      <span className="v2-fake-button" aria-hidden="true">
                        {c("demo.approve")}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <figcaption className="v2-fine v2-gap-sm">
                {c("demo.label")}. {c("demo.foot")}
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="v2-ink" aria-label={t("facts.aria")}>
          <ul className="v2-wrap v2-facts">
            <li className="v2-fact">
              <strong>{plans.map((plan) => plan.mailboxes).join(" · ")}</strong>
              <span>{t("facts.mailboxes")}</span>
            </li>
            <li className="v2-fact">
              <strong>
                {t("facts.domains", { count: Math.max(...plans.map((plan) => plan.domains)) })}
              </strong>
              <span>{t("facts.domainsLabel")}</span>
            </li>
            <li className="v2-fact">
              <strong>{t("facts.trial", { count: LAUNCH_OFFER.correioTrialDays })}</strong>
              <span>{t("facts.trialLabel")}</span>
            </li>
            <li className="v2-fact">
              <strong>{t("facts.free")}</strong>
              <span>{t("facts.freeLabel")}</span>
            </li>
          </ul>
        </section>

        <section className="v2-light v2-sec" aria-labelledby="correio-kinds-title">
          <div className="v2-wrap">
            <h2 id="correio-kinds-title" className="v2-h2">
              {t("kinds.title")}
            </h2>
            <div className="v2-grid">
              {kinds.map((kind, index) => (
                <article
                  className={`v2-card v2-cell${index === kinds.length - 1 ? " v2-card-ink" : ""}`}
                  key={kind.title}
                >
                  <span className="v2-address">{kind.address}</span>
                  <h3 className="v2-h3">{kind.title}</h3>
                  <p className="v2-body">{kind.body}</p>
                </article>
              ))}
            </div>
            <p className="v2-fine v2-gap">{c("use.exampleNote")}</p>
          </div>
        </section>

        <section className="v2-dark v2-sec" id="controle" aria-labelledby="correio-control-title">
          <div className="v2-wrap v2-row">
            <div className="v2-stack">
              <p className="v2-eyebrow">{c("control.eyebrow")}</p>
              <h2 id="correio-control-title" className="v2-h2">
                {t("control.title")}
              </h2>
              <p className="v2-body">{t("control.body")}</p>
            </div>
            <ol className="v2-perms">
              {permissions.map((permission, index) => {
                const gated = index === permissions.length - 1;
                return (
                  <li className={gated ? "is-gated" : undefined} key={permission.title}>
                    <span className="v2-perms-num" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="v2-perms-text">
                      <strong>{permission.title}</strong>
                      <span>{permission.body}</span>
                    </span>
                    <span className={`v2-pill ${gated ? "v2-pill-dark-wait" : "v2-pill-dark-ok"}`}>
                      {t(gated ? "control.gated" : "control.on")}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <section
          className="v2-light v2-sec"
          id="como-funciona"
          aria-labelledby="correio-setup-title"
        >
          <div className="v2-wrap">
            <h2 id="correio-setup-title" className="v2-h2">
              {t("setup.title")}
            </h2>
            <ol className="v2-steps">
              {steps.map((step, index) => (
                <li className="v2-step" key={step.title}>
                  <span className="v2-step-num" aria-hidden="true">
                    {index + 1}
                  </span>
                  <h3 className="v2-h3">{step.title}</h3>
                  <p className="v2-body">{step.body}</p>
                </li>
              ))}
            </ol>
            <p className="v2-card v2-gap-lg v2-note">
              <span>
                {t.rich("setup.history", { b })}{" "}
                <DocsLink className="v2-link-accent" href={`${docs}/concepts/domains`}>
                  {c("setup.docs")} <span aria-hidden="true">↗</span>
                </DocsLink>
              </span>
            </p>
          </div>
        </section>

        <section className="v2-violet v2-sec" id="ja-tenho" aria-labelledby="correio-free-title">
          <div className="v2-wrap v2-row">
            <div className="v2-stack">
              <p className="v2-eyebrow">{t("free.eyebrow")}</p>
              <h2 id="correio-free-title" className="v2-h2">
                {t("free.title")}
              </h2>
              <p className="v2-lead">{t("free.body")}</p>
            </div>
            <div className="v2-stack">
              <ul className="v2-actions">
                {["Gmail", "iCloud", "Yahoo", "Zoho", t("free.other")].map((provider) => (
                  <li className="v2-chip-round" key={provider}>
                    {provider}
                  </li>
                ))}
              </ul>
              <p>
                <a className="v2-btn v2-btn-bone" href={MAIL_SIGNUP}>
                  {t("free.cta")}
                </a>
              </p>
            </div>
          </div>
        </section>

        <section className="v2-dark v2-sec" aria-labelledby="correio-integrations-title">
          <div className="v2-wrap">
            <p className="v2-eyebrow">{c("integrations.eyebrow")}</p>
            <h2 id="correio-integrations-title" className="v2-h2">
              {c("integrations.title")}
            </h2>
            <p className="v2-lead v2-gap-sm">{c("integrations.body")}</p>
            <div className="v2-grid">
              {integrations.map((item, index) => (
                <article className="v2-card v2-card-raised v2-cell" key={item.kind}>
                  <span className="v2-address">{item.kind}</span>
                  <h3 className="v2-h3">{item.title}</h3>
                  <p className="v2-body">{item.body}</p>
                  <p className="v2-fine">{index === 0 ? c("release.restStatus") : item.status}</p>
                  <DocsLink className="v2-link-accent" href={`${docs}${item.path}`}>
                    {item.link} <span aria-hidden="true">↗</span>
                  </DocsLink>
                </article>
              ))}
            </div>
            <p className="v2-gap">
              <a className="v2-link-accent" href="/integrations">
                {c("integrations.all")} <span aria-hidden="true">→</span>
              </a>
            </p>
          </div>
        </section>

        <section className="v2-light v2-sec" id="planos" aria-labelledby="correio-plans-title">
          <div className="v2-wrap">
            <p className="v2-eyebrow">{c("plans.eyebrow")}</p>
            <h2 id="correio-plans-title" className="v2-h2">
              {t("plans.title")}
            </h2>
            <div className="v2-grid">
              {plans.map((plan) => {
                const featured = plan.id === "duo";
                const name = p(`correio.names.${plan.id}`);
                return (
                  <article
                    className={`v2-plan v2-cell${featured ? " is-featured" : ""}`}
                    key={plan.id}
                  >
                    <h3 className="v2-h3">{name}</h3>
                    <p className="v2-plan-for">{t(`plans.for.${plan.id}`)}</p>
                    <p className="v2-plan-price">
                      {money(plan.brlMonthlyCents, plan.monthlyCents)}
                      <small>{l("plans.perMonth")}</small>
                    </p>
                    <ul className="v2-plan-list">
                      <li>
                        <strong>{t("plans.mailboxCount", { count: plan.mailboxes })}</strong>{" "}
                        {t("plans.storage", { size: plan.storageGiB })}
                      </li>
                      <li>
                        {t("plans.recipients", {
                          count: number.format(plan.monthlyRecipientDeliveries),
                        })}
                      </li>
                      <li>
                        {t("plans.inbound", { count: number.format(plan.monthlyInboundMessages) })}
                      </li>
                      <li>{t("plans.domains", { count: plan.domains })}</li>
                    </ul>
                    <a
                      className={`v2-btn v2-btn-block ${featured ? "v2-btn-bone" : "v2-btn-line"}`}
                      href={signupMailboxHref(plan.id)}
                    >
                      {t("plans.cta", { plan: name })}
                    </a>
                  </article>
                );
              })}
            </div>
            <p className="v2-note v2-gap">
              {t("plans.note", { abroad: abroad.join(" · ") })} {c("release.plansNote")}
            </p>
            <details className="v2-details">
              <summary>{t("plans.limits")}</summary>
              <div>
                <p className="v2-note">{p("correio.noteLimits")}</p>
                <p className="v2-note">{c("plans.terms")}</p>
              </div>
            </details>
            <details className="v2-details">
              <summary>{t("plans.modalities")}</summary>
              <div>
                <div className="v2-table-box">
                  <table className="v2-table">
                    <caption className="gtm-sr-only">{c("comparison.caption")}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{c("comparison.feature")}</th>
                        <th scope="col">{c("comparison.sending")}</th>
                        <th scope="col">{c("comparison.combined")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.map((row, index) => (
                        <tr key={row.label}>
                          <th scope="row">{row.label}</th>
                          <td>{row.sending}</td>
                          <td>
                            {index === comparison.length - 1
                              ? c("release.availability")
                              : index === comparison.length - 2
                                ? c("release.billingPlans")
                                : row.combined}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
            <div className="v2-apps v2-gap-lg">
              <p>{t("apps.title")}</p>
              <a
                className="v2-btn v2-btn-bone"
                href={WINDOWS_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("apps.windows")} <span aria-hidden="true">↗</span>
              </a>
              <a className="v2-btn v2-btn-line" href={LINUX_DOWNLOAD_URL}>
                {t("apps.linux")}
              </a>
            </div>
          </div>
        </section>

        <section className="v2-light v2-sec" aria-labelledby="correio-faq-title">
          <div className="v2-wrap v2-narrow">
            <h2 id="correio-faq-title" className="v2-h2 v2-faq-title">
              {c("faq.title")}
            </h2>
            <div className="v2-faq">
              {faq.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="v2-ink v2-sec v2-center" aria-labelledby="correio-close-title">
          <div className="v2-wrap v2-stack">
            <h2 id="correio-close-title" className="v2-h2 v2-close-title">
              {t("close.title")}
            </h2>
            <div className="v2-actions">
              <SignupLink
                label={l("domainHero.cta")}
                className="v2-btn v2-btn-bone"
                mailboxPlan="choose"
              />
              <a className="v2-btn v2-btn-line" href="#planos">
                {t("close.plans")}
              </a>
            </div>
            <p className="v2-note">{t("close.note", { price: mailFrom })}</p>
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
