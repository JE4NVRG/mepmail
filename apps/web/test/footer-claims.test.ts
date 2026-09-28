import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const messages = fileURLToPath(new URL("../messages", import.meta.url));
const chrome = fileURLToPath(new URL("../src/components/site-chrome.tsx", import.meta.url));

// The AWS SES production quota is not approved yet, so the public footer states
// the service without a number (criterion of kanban t_b4e63b94). Pinning both
// the copy and the restoration TODO keeps the number from sneaking back in
// before the approval.
describe("public footer claim", () => {
  for (const locale of ["en", "pt-BR"]) {
    it(`${locale}: the footer carries no sending-quota number`, () => {
      const catalog = JSON.parse(readFileSync(join(messages, locale, "landing.json"), "utf8")) as {
        footer: { points: string[] };
      };
      expect(catalog.footer.points[0]).toContain("Amazon SES");
      for (const point of catalog.footer.points) {
        expect(point, point).not.toMatch(/\d/);
      }
    });
  }

  it("keeps the restoration TODO next to the footer points", () => {
    expect(readFileSync(chrome, "utf8")).toContain("TODO(claim AWS)");
  });
});
