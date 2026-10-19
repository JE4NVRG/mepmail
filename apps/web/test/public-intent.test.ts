import { createTranslator, NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enLanding from "../messages/en/landing.json";
import enPricing from "../messages/en/pricing.json";
import ptLanding from "../messages/pt-BR/landing.json";
import ptPricing from "../messages/pt-BR/pricing.json";
import {
  inAppBrowser,
  openInBrowserHref,
  paidRung,
  pricingFocus,
  requestedPlan,
  signupHref,
} from "../src/lib/public-intent";

/**
 * What a visitor came for survives the sign-up (2026-10-14: the Meta "Send" ads landed on a
 * page that opened on Mail, every plan button went to a bare /signup, and a sign-up from
 * Instagram's browser lost its way at the confirmation link).
 */

const FB_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/483.0.0.53.70;]";
const IG_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.25.94 (iPhone15,3; iOS 17_6; pt_BR; pt; scale=3.00; 1290x2796; 646225546)";
const FB_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/483.0.0.42.104;FBBV/672224466;FBDV/iPhone16,2;FBMD/iPhone;FBSN/iOS;FBSV/18.0;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/5]";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("the plan picked on a public page", () => {
  it("is carried by the sign-up into Billing, for paid plans only", () => {
    expect(signupHref("pro_100k")).toBe("/signup?next=%2Fsettings%2Fbilling%3Fplan%3Dpro_100k");
    expect(signupHref("scale_2_5m")).toBe("/signup?next=%2Fsettings%2Fbilling%3Fplan%3Dscale_2_5m");
    for (const value of ["free", undefined, null, "", "pro_999k", "../admin"])
      expect(signupHref(value), String(value)).toBe("/signup");
  });

  it("is read back by Billing, which opens the comparison on it", () => {
    expect(requestedPlan({ plan: "pro_100k" })).toBe("pro_100k");
    expect(requestedPlan({ plan: "starter" })).toBe("starter");
    for (const plan of [undefined, "free", "pro_100k_extra", ["pro_100k", "starter"]])
      expect(requestedPlan({ plan }), JSON.stringify(plan)).toBeNull();
    expect(paidRung(42)).toBeNull();
  });
});

describe("a Send campaign lands on Send", () => {
  it("reads ?focus=send or a utm_campaign that names send", () => {
    expect(pricingFocus({ focus: "send" })).toBe("send");
    expect(pricingFocus({ utm_campaign: "mepmail_send_us_20261013" })).toBe("send");
    expect(pricingFocus({ utm_campaign: "mepmail_send_br_20261013" })).toBe("send");
    expect(pricingFocus({ utm_campaign: "send-launch" })).toBe("send");
    for (const utm_campaign of [
      "mepmail_correio_br",
      "mepmail_x_acquisition_20261010",
      "sender_tips",
      "resend_switch",
      undefined,
    ])
      expect(pricingFocus({ utm_campaign }), String(utm_campaign)).toBeNull();
    expect(pricingFocus({ focus: ["send", "send"] })).toBeNull();
  });
});

describe("an app's built-in browser", () => {
  it("is recognized on Android and iOS, and a phone's own browser is not", () => {
    expect(inAppBrowser(FB_ANDROID)).toBe("android");
    expect(inAppBrowser(IG_IPHONE)).toBe("ios");
    expect(inAppBrowser(FB_IPHONE)).toBe("ios");
    expect(inAppBrowser(CHROME_ANDROID)).toBeNull();
    expect(inAppBrowser(SAFARI_IPHONE)).toBeNull();
    expect(inAppBrowser("")).toBeNull();
  });

  it("offers Android a way to the same page in Chrome, falling back to the page", () => {
    const href = "https://mepmail.dev/signup?next=%2Fsettings%2Fbilling%3Fplan%3Dpro_100k";
    expect(openInBrowserHref(href)).toBe(
      `intent://mepmail.dev/signup?next=%2Fsettings%2Fbilling%3Fplan%3Dpro_100k#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`,
    );
    expect(openInBrowserHref("http://mepmail.dev/signup")).toBeNull();
    expect(openInBrowserHref("not a url")).toBeNull();
  });
});

// The pricing page itself, in both orders.
type Locale = "en" | "pt-BR";
const current = vi.hoisted(() => ({ locale: "en" as Locale }));
const messages = (locale: Locale) =>
  locale === "en"
    ? { landing: enLanding, pricing: enPricing }
    : { landing: ptLanding, pricing: ptPricing };

vi.mock("next-intl/server", () => ({
  getLocale: async () => current.locale,
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: current.locale,
      messages: messages(current.locale),
      namespace: namespace as never,
    }),
}));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/signup-cta", async () => {
  const intent = await import("../src/lib/public-intent");
  return {
    SignupCta: ({ label, rung }: { label: string; rung?: string }) =>
      createElement("a", { href: intent.signupHref(rung), "data-cta": "signup" }, label),
  };
});
vi.mock("@/components/site-chrome", () => ({
  PublicHeader: () => createElement("header", null, "MepMail"),
  PublicFooter: () => createElement("footer", null, "MepMail"),
  SignupLink: ({ label }: { label: string }) => createElement("a", { href: "/signup" }, label),
}));

const { default: Pricing } = await import("../src/app/pricing/page");

async function render(params: Record<string, string>) {
  const children = await Pricing({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: current.locale,
      messages: messages(current.locale),
      children,
    }),
  ).replace(/ /g, " ");
}

beforeEach(() => {
  vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
  vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
  vi.stubEnv("MAILBOX_STANDALONE_OPEN", "true");
});
afterEach(() => vi.unstubAllEnvs());

for (const locale of ["en", "pt-BR"] as const) {
  describe(`/pricing in ${locale}`, () => {
    it("opens on Send for a Send campaign, with Send plans before Mail and scenarios", async () => {
      current.locale = locale;
      const html = await render({ utm_campaign: "mepmail_send_us_20261013" });
      const h1 = html.match(/<h1>(.*?)<\/h1>/)?.[1] ?? "";
      expect(h1).toContain(locale === "en" ? "110,000 a month for" : "110 mil por mês por");
      expect(h1, h1).toMatch(locale === "en" ? /US\$\s29\./ : /R\$\s149\./);
      // The hero's main button signs up into Billing on Pro 110K.
      expect(html).toContain('href="/signup?next=%2Fsettings%2Fbilling%3Fplan%3Dpro_100k"');
      const at = (id: string) => html.indexOf(`id="${id}"`);
      const journey = ["planos", "pro110k", "correio", "cenarios"].map(at);
      expect(journey.every((position) => position > 0)).toBe(true);
      expect(journey).toEqual([...journey].sort((a, b) => a - b));
      // Both entry prices are available before the visitor reaches any plan section.
      const intro = html.slice(0, html.indexOf("</section>")).replace(/\u00a0/g, " ");
      expect(intro).toContain(locale === "en" ? "US$ 2.90" : "R$ 14,90");
      expect(intro).toContain(locale === "en" ? "US$ 0" : "R$ 0");
    });

    it("starts with the scenarios elsewhere, then Mail and Send, preserving each paid plan's intent", async () => {
      current.locale = locale;
      const html = await render({});
      const journey = ["cenarios", "correio", "planos", "pro110k"].map((id) =>
        html.indexOf(`id="${id}"`),
      );
      expect(journey.every((position) => position > 0)).toBe(true);
      expect(journey).toEqual([...journey].sort((a, b) => a - b));
      expect(html.match(/<h1>(.*?)<\/h1>/)?.[1]).not.toContain("110");
      const intro = html.slice(0, html.indexOf("</section>")).replace(/\u00a0/g, " ");
      expect(intro).toContain(locale === "en" ? "US$ 2.90" : "R$ 14,90");
      expect(intro).toContain(locale === "en" ? "US$ 0" : "R$ 0");
      for (const rung of ["starter", "pro_100k", "pro_200k", "scale_500k"])
        expect(html).toContain(`href="/signup?next=%2Fsettings%2Fbilling%3Fplan%3D${rung}"`);
    });
  });
}
