import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LandingCalculator, type CalcLabels } from "@/components/landing-calculator";
import { LandingLangSwitch } from "@/components/landing-lang-switch";
import { PRICE_ROWS, formatUsd } from "@/lib/landing-pricing";
import { hasSession } from "@/server/auth";
import "./landing-calc.css";
import "./landing.css";

const contact = "mailto:jean@je4ndev.com";

const comparison = PRICE_ROWS.map((row) => [
  row.label,
  formatUsd(row.mepmail),
  formatUsd(row.resend),
  formatUsd(row.sendgrid),
  formatUsd(row.postmark),
  formatUsd(row.mailgun),
  row.savings,
]);

const cellKeys = ["MepMail", "Resend", "SendGrid", "Postmark", "Mailgun", "vantagem"] as const;

const plans = [
  { name: "Free", price: "US$ 0" },
  { name: "Starter", price: "US$ 9" },
  { name: "Pro 100K", price: "US$ 20" },
  { name: "Pro 200K", price: "US$ 100" },
  { name: "Scale 500K", price: "US$ 199" },
  { name: "Scale 1M", price: "US$ 319" },
  { name: "Scale 1.5M", price: "US$ 429" },
  { name: "Scale 2.5M", price: "US$ 549" },
] as const;

type PlanCopy = { volume: string; limits: string; overage: string; attachment: string };
type FaqItem = { q: string; a: string };

const EMPTY_PLAN_COPY: PlanCopy = { volume: "", limits: "", overage: "", attachment: "" };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("landing");
  const description = t("meta.description");
  return {
    title: { absolute: t("meta.title") },
    description,
    robots: { index: true, follow: true },
    openGraph: {
      title: t("meta.title"),
      description,
      type: "website",
      images: [{ url: "/og.png", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

function Wordmark() {
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

function SignupLink({ label }: { label: string }) {
  return (
    <a className="ms-btn ms-btn-primary gtm-action" href="/signup">
      {label}
    </a>
  );
}

export default async function RootPage() {
  if (await hasSession()) redirect("/emails");

  const t = await getTranslations("landing");
  const planCopy = t.raw("plans.items") as PlanCopy[];
  const points = t.raw("structure.points") as string[];
  const columns = t.raw("compare.columns") as string[];
  const steps = t.raw("how.items") as string[];
  const faq = t.raw("faq.items") as FaqItem[];
  const calc = t.raw("calc") as CalcLabels;

  return (
    <div className="gtm">
      <a className="gtm-skip" href="#conteudo">
        {t("skip")}
      </a>
      <header className="gtm-header">
        <div className="gtm-container gtm-header-inner">
          <a className="gtm-brand" href="/" aria-label={t("brandAria")}>
            <Wordmark />
          </a>
          <nav className="gtm-nav" aria-label={t("navAria")}>
            <a className="gtm-nav-extra" href="#comparativo">
              {t("nav.compare")}
            </a>
            <a className="gtm-nav-extra" href="#planos">
              {t("nav.plans")}
            </a>
            <a className="gtm-nav-extra" href="#como-funciona">
              {t("nav.how")}
            </a>
            <LandingLangSwitch label={t("lang.aria")} />
            <a href="/login">{t("nav.login")}</a>
            <SignupLink label={t("nav.signup")} />
          </nav>
        </div>
      </header>
      <main id="conteudo">
        <section className="gtm-section gtm-hero">
          <div className="gtm-container">
            <p className="gtm-eyebrow">
              {t.rich("hero.eyebrow", {
                badge: (chunks) => <span className="gtm-beta-badge">{chunks}</span>,
              })}
            </p>
            <h1>
              {t.rich("hero.title", {
                highlight: (chunks) => <span>{chunks}</span>,
              })}
            </h1>
            <p className="gtm-lead">{t("hero.lead")}</p>
            <div className="gtm-actions">
              <SignupLink label={t("hero.ctaSignup")} />
              <a className="ms-btn ms-btn-secondary gtm-action" href="#planos">
                {t("hero.ctaPlans")}
              </a>
            </div>
            <p className="gtm-note">{t("hero.note")}</p>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="comparativo">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("compare.eyebrow")}</p>
            <h2>{t("compare.title")}</h2>
            <p>{t("compare.intro")}</p>
            <section
              className="gtm-table-scroll"
              aria-label={t("compare.tableAria")}
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
                  {comparison.map(([volume, ...values]) => (
                    <tr key={volume}>
                      <th scope="row">{volume}</th>
                      {values.map((value, index) => (
                        <td key={cellKeys[index]}>{value}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <p className="gtm-note">{t("compare.slideNote")}</p>
            <LandingCalculator labels={{ ...calc, contact }} />
            <p className="gtm-note">{t("compare.refNote")}</p>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("structure.eyebrow")}</p>
            <h2>{t("structure.title")}</h2>
            <p>{t("structure.body")}</p>
            <ul className="gtm-points">
              {points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="gtm-section gtm-alt" id="planos">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("plans.eyebrow")}</p>
            <h2>{t("plans.title")}</h2>
            <p>{t("plans.intro")}</p>
            <div className="gtm-plan-grid">
              {plans.map((plan, index) => {
                const copy = planCopy[index] ?? EMPTY_PLAN_COPY;
                return (
                  <article className="ms-card gtm-plan" key={plan.name}>
                    <h3>{plan.name}</h3>
                    <p className="gtm-price">
                      {plan.price}
                      <span>{t("plans.perMonth")}</span>
                    </p>
                    <p className="gtm-volume">{copy.volume}</p>
                    <dl>
                      <div>
                        <dt>{t("plans.limitsLabel")}</dt>
                        <dd>{copy.limits}</dd>
                      </div>
                      <div>
                        <dt>{t("plans.overageLabel")}</dt>
                        <dd>{copy.overage}</dd>
                      </div>
                      <div>
                        <dt>{t("plans.attachmentLabel")}</dt>
                        <dd>{copy.attachment}</dd>
                      </div>
                    </dl>
                    <SignupLink label={t("plans.cta")} />
                  </article>
                );
              })}
            </div>
            <p className="gtm-note">{t("plans.note")}</p>
            <div className="gtm-offers">
              <p>
                {t.rich("plans.offerProactive", {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <p>
                {t.rich("plans.offerFirst3", {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
            </div>
            <p className="gtm-note">{t("plans.noteAttach")}</p>
          </div>
        </section>

        <section className="gtm-section" id="como-funciona">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("how.eyebrow")}</p>
            <h2>{t("how.title")}</h2>
            <ol className="gtm-steps">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="gtm-note">{t("how.note")}</p>
            <SignupLink label={t("hero.ctaSignup")} />
          </div>
        </section>

        <section className="gtm-section gtm-alt">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("deliverability.eyebrow")}</p>
            <h2>{t("deliverability.title")}</h2>
            <p>
              {t.rich("deliverability.body", {
                api: (chunks) => <code>{chunks}</code>,
                smtp: (chunks) => <code>{chunks}</code>,
              })}
            </p>
            <p className="gtm-note">{t("deliverability.note")}</p>
          </div>
        </section>

        <section className="gtm-section">
          <div className="gtm-container">
            <p className="gtm-eyebrow">{t("faq.eyebrow")}</p>
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

        <section className="gtm-section gtm-alt gtm-close">
          <div className="gtm-container">
            <h2>{t("close.title")}</h2>
            <p>{t("close.body")}</p>
            <SignupLink label={t("close.cta")} />
          </div>
        </section>
      </main>
      <footer className="gtm-footer">
        <div className="gtm-container gtm-footer-inner">
          <div>
            <a className="gtm-brand" href="/" aria-label={t("brandAria")}>
              <Wordmark />
            </a>
            <p>{t("footer.tagline")}</p>
          </div>
          <nav aria-label={t("footer.navAria")}>
            <a href="/login">{t("footer.login")}</a>
            <a href={contact}>{t("footer.contact")}</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
