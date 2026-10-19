import { createTranslator } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en/alternatives.json";
import enLanding from "../messages/en/landing.json";
import pt from "../messages/pt-BR/alternatives.json";
import ptLanding from "../messages/pt-BR/landing.json";
import { RESEND_PRICING_SOURCE, resendSavings } from "../src/lib/alternatives-resend";
import {
  comparisonRowsForLocale,
  formatComparisonPrice,
  formatUsd,
  formatVolume,
  resendQuote,
} from "../src/lib/landing-pricing";
import { signupHref } from "../src/lib/public-intent";

const current = vi.hoisted(() => ({ locale: "en" as "en" | "pt-BR" }));
const messages = {
  en: { alternatives: en, landing: enLanding },
  "pt-BR": { alternatives: pt, landing: ptLanding },
};
vi.mock("next-intl/server", () => ({
  getLocale: async () => current.locale,
  getTranslations: async (namespace: "alternatives" | "landing") =>
    createTranslator({ locale: current.locale, messages: messages[current.locale], namespace }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/alternatives/resend" }));
vi.mock("@/components/site-chrome", () => ({
  PublicHeader: () => null,
  PublicFooter: () => null,
}));
vi.mock("@/components/comparison-reference", () => ({ ComparisonReference: async () => null }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@millionsend/config", () => ({ env: {} }));

const { default: ResendAlternativePage } = await import("../src/app/alternatives/resend/page");

function textContent(markup: string) {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

afterEach(() => vi.unstubAllEnvs());

describe("Resend migration buyer journey", () => {
  for (const locale of ["en", "pt-BR"] as const) {
    const copy = messages[locale].alternatives;

    it(`${locale}: opens the paid sending plan without a Free gate or purchase action`, async () => {
      current.locale = locale;
      const html = renderToStaticMarkup(await ResendAlternativePage());
      const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)];
      const paid = new URL(links[0]?.[1] ?? "", "https://fixture.example");
      expect(paid.pathname).toBe("/signup");
      expect(paid.searchParams.get("next")).toBe("/settings/billing?plan=pro_100k");
      expect(links[0]?.[2]).toBe(copy.paidCta);
      expect(links.filter((link) => link[1] === signupHref("pro_100k"))).toHaveLength(2);
      expect(html).toContain(`href="/signup">${copy.freeLink}</a>`);
      expect(textContent(html)).toContain(copy.note);
      expect(html).not.toMatch(/<form\b|checkout\.stripe|billing\/portal|type="submit"/i);
    });

    it(`${locale}: links a concrete migration command to localized integration instructions`, async () => {
      current.locale = locale;
      const html = renderToStaticMarkup(await ResendAlternativePage());
      const docs = `https://docs.mepmail.dev${locale === "pt-BR" ? "/pt-BR" : ""}`;
      expect(html).toContain("<code>npx @mepmail/cli migrate --from resend</code>");
      expect(html).toContain(`href="${docs}/quickstart"`);
      expect(html).toContain(`href="${docs}/migrate-from-resend"`);
      expect(html).toContain(`href="/pricing${locale === "pt-BR" ? "?lang=pt-BR" : ""}"`);
      const text = textContent(html);
      expect(text).toContain(copy.steps.intro);
      for (const step of copy.steps.items) expect(text).toContain(step);
      for (const limit of copy.steps.limits) expect(text).toContain(limit);
      expect(text).toContain(copy.steps.note);
      expect(text).toContain("POST /contacts/imports");
      expect(text).toContain("POST /contacts/batch");
      expect(text).toContain("PATCH /contacts/{id}/topics");
      expect(text).toContain("DNS/DKIM");
      expect(text).toContain("reply_to");
      expect(text).toContain("Correio");
      expect(JSON.stringify([copy.lead, copy.steps, copy.close])).not.toMatch(
        /stay exactly|exatamente como|first test today|primeiro envio de teste hoje|in minutes|em minutos|zero downtime|sem downtime/i,
      );
    });

    for (const launch of [false, true]) {
      it(`${locale}, launch=${launch}: retains the shared recurring comparison, date and caveat`, async () => {
        current.locale = locale;
        vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", String(launch));
        const html = renderToStaticMarkup(await ResendAlternativePage());
        const rows = [...html.matchAll(/<tbody>(.*?)<\/tbody>/gs)][0]?.[1] ?? "";
        const cells = [...rows.matchAll(/<tr>(.*?)<\/tr>/gs)].map((row) =>
          [...(row[1] ?? "").matchAll(/<(?:td|th)\b[^>]*>(.*?)<\/(?:td|th)>/gs)].map((cell) =>
            textContent(cell[1] ?? ""),
          ),
        );
        const t = createTranslator({
          locale,
          messages: messages[locale],
          namespace: "alternatives",
        });
        expect(cells).toEqual(
          comparisonRowsForLocale(launch, locale).map((row) => [
            formatVolume(row.volume, locale),
            // The price, then the math behind it in Resend's own currency.
            `${formatComparisonPrice(row.resend, locale)} ${(() => {
              const quote = resendQuote(row.volume);
              return quote.extra > 0
                ? t("table.resendBasis", {
                    plan: quote.plan,
                    base: formatUsd(quote.base, locale),
                    extra: new Intl.NumberFormat(locale).format(quote.extra),
                    rate: formatUsd(quote.overagePer1k, locale),
                  })
                : t("table.resendBasisPlain", {
                    plan: quote.plan,
                    base: formatUsd(quote.base, locale),
                  });
            })()}`,
            formatComparisonPrice(row.mepmail, locale),
            t("table.rowAdvantage", {
              percent: resendSavings(row).pct,
              usd: formatComparisonPrice(resendSavings(row).usd, locale),
            }),
          ]),
        );
        expect(html).toContain(`href="${RESEND_PRICING_SOURCE.url}"`);
        expect(textContent(html)).toContain(RESEND_PRICING_SOURCE.checkedOn);
        expect(textContent(html)).toContain(copy.claim.body);
      });
    }
  }
});
