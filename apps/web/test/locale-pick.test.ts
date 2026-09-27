import { describe, expect, it } from "vitest";
import { pickLocale } from "@/lib/locale-cookie";

describe("pickLocale", () => {
  it("returns pt-BR for a pt-BR header", () => {
    expect(pickLocale("pt-BR,pt;q=0.9,en;q=0.8")).toBe("pt-BR");
  });

  it("resolves language-only pt and other pt regions to pt-BR", () => {
    expect(pickLocale("pt")).toBe("pt-BR");
    expect(pickLocale("pt-PT,pt;q=0.9")).toBe("pt-BR");
  });

  it("returns en for en and other en regions", () => {
    expect(pickLocale("en-US,en;q=0.9")).toBe("en");
    expect(pickLocale("en-GB")).toBe("en");
  });

  it("honours q-ordering over header order", () => {
    expect(pickLocale("en;q=0.8, pt-BR;q=0.9")).toBe("pt-BR");
    expect(pickLocale("pt-BR;q=0.2, en;q=0.9")).toBe("en");
  });

  it("falls back to English for unknown or missing headers", () => {
    expect(pickLocale("fr-FR,de;q=0.9")).toBe("en");
    expect(pickLocale("")).toBe("en");
    expect(pickLocale(null)).toBe("en");
    expect(pickLocale(undefined)).toBe("en");
  });
});
