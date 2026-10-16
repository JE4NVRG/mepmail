import { getLocale, getTranslations } from "next-intl/server";
import { COMPARISON_FX, formatComparisonPrice } from "@/lib/landing-pricing";

/** Sources and a like-for-volume example, without implying feature parity. */
export async function ComparisonReference() {
  const locale = await getLocale();
  const t = await getTranslations("landing.comparisonReference");
  const price = (usd: number) =>
    formatComparisonPrice(locale === "pt-BR" ? usd * COMPARISON_FX.brlPerUsd : usd, locale);
  return (
    <aside className="gtm-claim" aria-label={t("title")}>
      <h3>{t("title")}</h3>
      <p className="gtm-note">
        {t("example", { pro: price(35), overage: price(20 + 50 * 0.9), scale: price(90) })}
      </p>
      <p className="gtm-note">
        {t.rich("pricingSource", {
          link: (chunks) => (
            <a href="https://resend.com/pricing.md" target="_blank" rel="noreferrer">
              {chunks}
            </a>
          ),
        })}
      </p>
      {locale === "pt-BR" ? (
        <p className="gtm-note">
          {t.rich("currency", {
            rate: String(COMPARISON_FX.brlPerUsd).replace(".", ","),
            date: "15/10/2026",
            link: (chunks) => (
              <a href={COMPARISON_FX.url} target="_blank" rel="noreferrer">
                {chunks}
              </a>
            ),
          })}
        </p>
      ) : null}
      <p className="gtm-note">
        {t.rich("capabilities", {
          resend: (chunks) => (
            <a href="https://resend.com/docs/mcp-server" target="_blank" rel="noreferrer">
              {chunks}
            </a>
          ),
          inboxes: (chunks) => (
            <a href="https://resend.com/pricing" target="_blank" rel="noreferrer">
              {chunks}
            </a>
          ),
          plunk: (chunks) => (
            <a href="https://www.useplunk.com/features/mcp" target="_blank" rel="noreferrer">
              {chunks}
            </a>
          ),
        })}
      </p>
    </aside>
  );
}
