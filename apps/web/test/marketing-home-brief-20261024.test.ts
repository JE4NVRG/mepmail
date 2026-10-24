import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "src/app/home-v2.tsx"), "utf8");

describe("marketing brief: factual Send-first entry", () => {
  it("puts Send first in document order and keeps a single main heading", () => {
    expect(source.indexOf("v2-door v2-door-dark")).toBeLessThan(source.indexOf("v2-door v2-light"));
    expect(source.match(/<h1\b/g)).toHaveLength(1);
    expect(source).toContain("growth.cta");
    expect(source).toContain("starter.brlPriceCents");
    expect(source).toContain("starter.priceCents");
  });
  it("links product-specific plans, public evidence and the real founder", () => {
    for (const href of [
      "/pricing?focus=send#planos",
      "/pricing?focus=mail#correio",
      "/delivery",
      "/terms",
      "https://x.com/JE4NVRG",
    ]) {
      expect(source).toContain(`href="${href}"`);
    }
  });
  it.each(["en", "pt-BR"])(
    "keeps truthful complete growth copy and aligned metadata in %s",
    (locale) => {
      const m = JSON.parse(readFileSync(resolve(root, `messages/${locale}/landing.json`), "utf8"));
      expect(m.meta.title).toBe(m.meta.domainTitle);
      expect(m.meta.description).toBe(m.meta.domainDescription);
      expect(Object.keys(m.home.growth)).toHaveLength(19);
      expect(m.home.growth.note).toContain("{free}");
      expect(m.home.growth.note).toContain("{starter}");
      expect(m.home.growth.founderLink).toContain("@JE4NVRG");
      expect(m.home.growth.deliveryBody).not.toMatch(/1[.,]1%|0[.,]0%|99[.,]9%/);
      expect(JSON.stringify(m.home.growth)).not.toMatch(
        /half the price|metade do preço|first 10|próximos 10|Sunday|domingo|security review|auditoria independente/i,
      );
    },
  );
  it("links GitHub directly and keeps the corresponding-source offer", () => {
    const footer = readFileSync(resolve(root, "src/components/site-chrome.tsx"), "utf8");
    expect(footer).toContain('<GithubLink href="https://github.com/JE4NVRG/mepmail">');
    expect(footer).toContain('<a href="/source"');
    expect(footer).toContain("sourceArchive ?? labels.footer.sourceDownload");
  });
});
