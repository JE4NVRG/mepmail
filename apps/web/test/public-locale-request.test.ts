import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ headers: new Headers(), cookie: "pt-BR", locale: "en" }));
vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({ get: () => ({ value: h.cookie }) }),
}));
vi.mock("next-intl/server", () => ({
  getRequestConfig: (fn: unknown) => fn,
  getLocale: async () => h.locale,
}));
vi.mock("@millionsend/config", () => ({ env: {} }));

import requestConfig from "@/i18n/request";
import { proxy } from "@/proxy";
import { publicPageUrls } from "@/server/public-seo";

async function resolve(url: string) {
  const response = proxy(
    new NextRequest(url, {
      headers: { "accept-language": "pt-BR", cookie: `NEXT_LOCALE=${h.cookie}` },
    }),
  );
  h.headers = new Headers({ "accept-language": "pt-BR" });
  const locale = response.headers.get("x-middleware-request-x-mepmail-url-locale");
  if (locale) h.headers.set("x-mepmail-url-locale", locale);
  const value = await requestConfig({ requestLocale: Promise.resolve(undefined) });
  h.locale = value.locale ?? "en";
  return value;
}

describe("public URL → request locale → metadata", () => {
  beforeEach(() => {
    h.cookie = "pt-BR";
  });

  it.each(["/pricing", "/correio", "/alternatives/resend"])(
    "renders the English catalog and reciprocal canonical metadata for %s despite PT preferences",
    async (path) => {
      expect((await resolve(`https://mepmail.dev${path}?utm_source=fixture`)).locale).toBe("en");
      const seo = await publicPageUrls(path);
      expect(seo.alternates.canonical).toBe(path);
      expect(seo.alternates.languages).toEqual({
        en: path,
        "pt-BR": `${path}?lang=pt-BR`,
        "x-default": path,
      });
      expect(seo.ogLocale).toBe("en_US");
    },
  );

  it.each(["/pricing", "/correio", "/alternatives/resend"])(
    "keeps explicit Portuguese and its self-canonical for %s",
    async (path) => {
      h.cookie = "en";
      expect((await resolve(`https://mepmail.dev${path}?lang=pt-BR`)).locale).toBe("pt-BR");
      const seo = await publicPageUrls(path);
      expect(seo.alternates.canonical).toBe(`${path}?lang=pt-BR`);
      expect(seo.alternates.languages).toEqual({
        en: path,
        "pt-BR": `${path}?lang=pt-BR`,
        "x-default": path,
      });
      expect(seo.ogLocale).toBe("pt_BR");
    },
  );

  it.each(["/login?next=%2Femails", "/signup?next=%2Ftemplates", "/mailboxes", "/settings"])(
    "preserves Portuguese preference outside the public canonical set: %s",
    async (path) => {
      expect((await resolve(`https://mepmail.dev${path}`)).locale).toBe("pt-BR");
    },
  );

  it("also loads the actual English and Portuguese pricing messages", async () => {
    const en = await resolve("https://mepmail.dev/pricing");
    const pt = await resolve("https://mepmail.dev/pricing?lang=pt-BR");
    expect(en.messages?.pricing).toEqual((await import("../messages/en/pricing.json")).default);
    expect(pt.messages?.pricing).toEqual((await import("../messages/pt-BR/pricing.json")).default);
  });
});
