import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLAN_RUNGS } from "@millionsend/core";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("conversion correction contracts", () => {
  for (const locale of ["en", "pt-BR"]) {
    it(`${locale}: benefits lead, MCP follows, price draft stays provisional`, () => {
      const copy = JSON.parse(read(`../messages/${locale}/landing.json`));
      expect(copy.announce.text + copy.hero.title + copy.hero.lead).not.toMatch(
        /MCP|AI agents|agentes de IA/,
      );
      expect(copy.hero.lead).toMatch(/compat/i);
      expect(copy.hero.lead).toMatch(/support|suporte/);
      expect(copy.plans.choiceBody).toContain("US$119");
      expect(copy.plans.choiceBody).toMatch(/Without overage enabled|Sem excedente habilitado/);
      const suffix = locale === "en" ? "" : ".pt-BR";
      for (const doc of ["migrate-from-resend", "concepts/domains"]) {
        const content = read(`../../docs/content/docs/${doc}${suffix}.mdx`);
        expect(content).toContain("`us-east-1`");
        expect(content).not.toContain("`sa-east-1`");
      }
    });
  }
  it("preserves the existing catalog pending approved repricing; does not render the draft", () => {
    const small = PLAN_RUNGS.find((rung) => rung.key === "pro_100k");
    const large = PLAN_RUNGS.find((rung) => rung.key === "pro_200k");
    expect(small).toMatchObject({ included: 110000, priceCents: 2000, overageCentsPer1k: 90 });
    expect(large).toMatchObject({ included: 220000, priceCents: 10000, overageCentsPer1k: 35 });
    if (!small || !large) throw new Error("Missing Pro plans");
    expect(
      small.priceCents +
        Math.ceil((large.included - small.included) / 1000) * (small.overageCentsPer1k ?? 0),
    ).toBe(11900);
    expect(read("../../../packages/billing/src/provision.ts")).toContain(
      'transform_quantity: { divide_by: 1000, round: "up" }',
    );
    for (const route of ["../src/app/page.tsx", "../src/app/pricing/page.tsx"]) {
      expect(read(route)).not.toContain('("plans.choiceBody")');
    }
  });
});
