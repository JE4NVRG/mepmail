import { describe, expect, it } from "vitest";
import { permissiveDispatchProjection } from "../src/dispatch-html-projection.js";

describe("permissive dispatch projection", () => {
  it("keeps text, alt text and links from ordinary marketing HTML", () => {
    const html = [
      "<html><head><style>.x{display:none}</style></head><body><center>",
      '<img src="https://cdn.mepmail.dev/logo.png" alt="Logo MepMail">',
      '<p style="display:block;text-decoration:none">Seu teste gratis de 14 dias</p>',
      '<a href="https://mepmail.dev/pricing" target="_blank" rel="noopener">Ver planos</a>',
      "</center></body></html>",
    ].join("");
    const out = permissiveDispatchProjection(html) ?? "";
    expect(out).toContain("Seu teste gratis de 14 dias");
    expect(out).toContain("Logo MepMail");
    expect(out).toContain("Link destination: https://mepmail.dev/pricing");
  });

  it("refuses documents that could render text the judge cannot read", () => {
    expect(permissiveDispatchProjection("<div><script>alert(1)</script></div>")).toBeNull();
    expect(permissiveDispatchProjection('<div style="content: phish"></div>')).toBeNull();
    expect(
      permissiveDispatchProjection('<a href="https://x.dev" style="background:url(a)">x</a>'),
    ).toBeNull();
  });

  it("refuses an empty document with no text and no links", () => {
    expect(permissiveDispatchProjection("<div><span></span></div>")).toBeNull();
  });
});
