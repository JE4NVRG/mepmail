import { describe, expect, it } from "vitest";
import { languageAlternates, localizedPath } from "@/lib/public-locale-url";

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
});
