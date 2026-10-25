import { afterEach, describe, expect, it, vi } from "vitest";
import { publicMarketingMessages } from "@/lib/public-message-scope";
import { newSubscriptionsPaused } from "@/server/new-subscriptions";
import enMail from "../messages/en/correio.json";
import enLanding from "../messages/en/landing.json";
import ptMail from "../messages/pt-BR/correio.json";
import ptLanding from "../messages/pt-BR/landing.json";

const obsolete =
  /switching our email delivery provider|trocando nosso provedor|public Mail subscriptions are not open|contratação pública do Correio ainda não|purchase unavailable|contratação indisponível|validated in this preview|validação nesta prévia|Mail requires a Send plan above|Correio exige um plano de Envio acima|initial closed access|acesso inicial fechado|~45k/i;

afterEach(() => vi.unstubAllEnvs());

describe("public offer consistency", () => {
  it.each(["en", "pt-BR"])("does not serialize obsolete or inactive offer copy in %s", (locale) => {
    for (const path of ["/", "/pricing", "/correio", "/envio", "/signup"]) {
      const messages = publicMarketingMessages(path, locale)!;
      expect(JSON.stringify(messages)).not.toMatch(obsolete);
      expect(messages.common).not.toHaveProperty("subscriptionsPaused");
    }
  });

  it.each([
    ["en", enMail, enLanding],
    ["pt-BR", ptMail, ptLanding],
  ] as const)(
    "states independent Mail, daily Starter cap and Stripe Pix in %s",
    (locale, mail, landing) => {
      expect(mail.faq.items[0]?.a).toMatch(
        locale === "en" ? /No\. Mail plans work on their own/ : /Não\./,
      );
      expect(landing.plans.items[1]?.volume).toBe(
        locale === "en"
          ? "1,500/day · daily cap, not a monthly allowance"
          : "1.500/dia · limite diário, não franquia mensal",
      );
      expect(landing.faq.items[6]?.a).toContain("Stripe");
      expect(landing.faq.items[6]?.a).toContain(
        locale === "en"
          ? "Pix starts with payment and has no free trial"
          : "no Pix, o acesso começa com o pagamento, sem teste grátis",
      );
      expect(mail.setup.steps[0]?.body).toContain(locale === "en" ? "US$ 29/month" : "US$ 29/mês");
    },
  );

  it.each(["false", "0", "", "TRUE"])("keeps the pause off for %s", (value) => {
    vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", value);
    expect(newSubscriptionsPaused()).toBe(false);
  });

  it.each(["true", "1"])("retains the emergency pause for %s", (value) => {
    vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", value);
    expect(newSubscriptionsPaused()).toBe(true);
  });
});
