import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en/support.json";
import pt from "../messages/pt-BR/support.json";

const current = vi.hoisted(() => ({ locale: "pt-BR" }));
vi.mock("@/components/site-chrome", () => ({
  PublicHeader: () => createElement("header", null, "MepMail"),
  PublicFooter: () => createElement("footer", null, "MepMail"),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => {
    const copy = current.locale === "pt-BR" ? pt : en;
    const translate = (key: string) => {
      if (namespace !== "support") return key;
      return key
        .split(".")
        .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], copy);
    };
    return Object.assign(translate, { raw: translate });
  },
}));

const { default: SupportPage } = await import("@/app/support/page");

describe("localized support page", () => {
  it.each(["pt-BR", "en"])(
    "keeps existing channels alongside the disabled chat in %s",
    async (locale) => {
      current.locale = locale;
      const copy = locale === "pt-BR" ? pt : en;
      const html = renderToStaticMarkup(await SupportPage());
      expect(html).toContain(copy.hero.title);
      expect(html).toContain(copy.assistant.pending);
      expect(html).toContain("gtm-support-hero");
      expect(html.match(/<details>/g)).toHaveLength(copy.faq.items.length);
      // Every contact on the page reaches the owner directly.
      expect(html).toContain('href="mailto:jean@mepmail.dev"');
      expect(html).not.toContain("@je4ndev.com");
      expect(html).toContain('href="/updates"');
      expect(html).not.toContain("elozi.je4ndev.com/widget.js");
      expect(html).not.toContain("<button");
    },
  );
});
