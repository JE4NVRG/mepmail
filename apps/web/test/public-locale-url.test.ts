import { describe, expect, it } from "vitest";
import {
  isCanonicalPublicPath,
  languageAlternates,
  localeNavigationHref,
  localizedPath,
} from "@/lib/public-locale-url";

describe("public page URLs per language", () => {
  it("keeps English on the plain path and gives Portuguese ?lang=pt-BR", () => {
    expect(localizedPath("/pricing", "en")).toBe("/pricing");
    expect(localizedPath("/pricing", "pt-BR")).toBe("/pricing?lang=pt-BR");
    expect(localizedPath("/", "pt-BR")).toBe("/?lang=pt-BR");
  });

  it("names both languages and the negotiating plain path as x-default", () => {
    expect(languageAlternates("/correio")).toEqual({
      en: "/correio",
      "pt-BR": "/correio?lang=pt-BR",
      "x-default": "/correio",
    });
  });
  it("restricts deterministic URLs to known public pages, including the complete sitemap", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    for (const entry of sitemap())
      expect(isCanonicalPublicPath(new URL(entry.url).pathname)).toBe(true);
    for (const path of ["/pricing/", "/status", "/desktop/correio/linux"]) {
      expect(isCanonicalPublicPath(path)).toBe(true);
    }
    for (const path of [
      "/login",
      "/signup",
      "/settings",
      "/mail",
      "/mailboxes",
      "/api/trpc",
      "/pricing/private",
      "/support/chat",
    ]) {
      expect(isCanonicalPublicPath(path), path).toBe(false);
    }
  });

  it("switches public URLs while preserving campaign, return query and fragment", () => {
    const url = new URL("https://mepmail.dev/pricing?utm_source=fixture&next=%2Femails#plans");
    const pt = localeNavigationHref(url, "pt-BR");
    expect(pt).toBe("/pricing?utm_source=fixture&next=%2Femails&lang=pt-BR#plans");
    expect(localeNavigationHref(new URL(pt ?? "", url), "en")).toBe(
      "/pricing?utm_source=fixture&next=%2Femails#plans",
    );
    expect(url.searchParams.has("lang")).toBe(false);
  });

  it("removes duplicate language parameters and preserves preference-only navigation elsewhere", () => {
    const duplicate = new URL("https://mepmail.dev/correio?lang=en&lang=pt-BR&focus=mail");
    expect(localeNavigationHref(duplicate, "pt-BR")).toBe("/correio?lang=pt-BR&focus=mail");
    expect(localeNavigationHref(duplicate, "en")).toBe("/correio?focus=mail");
    expect(
      localeNavigationHref(new URL("https://mepmail.dev/settings?tab=profile"), "pt-BR"),
    ).toBeNull();
    expect(
      localeNavigationHref(new URL("https://mepmail.dev/login?lang=en&next=%2Femails"), "pt-BR"),
    ).toBe("/login?lang=pt-BR&next=%2Femails");
  });
});
