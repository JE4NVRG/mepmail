import { describe, expect, it } from "vitest";
import {
  hasUnsafeDispatchCharacters,
  normalizeDispatchText,
  projectDispatchHtml,
} from "../src/dispatch-html-projection.js";

describe("normalizeDispatchText", () => {
  it("drops a leading BOM, soft hyphens and CR line endings", () => {
    expect(normalizeDispatchText("\uFEFF<p>a\u00ADb</p>\r\n")).toBe("<p>ab</p>\n");
  });

  it("keeps obfuscation characters so the safety check still rejects them", () => {
    const value = normalizeDispatchText("a\u200Bb\u202Ec");
    expect(hasUnsafeDispatchCharacters(value)).toBe(true);
  });

  it("lets a template with a BOM and CRLF reach the projector", () => {
    const html = "\uFEFF<html><body>\r\n<p>Oferta da semana</p>\r\n</body></html>";
    expect(projectDispatchHtml(normalizeDispatchText(html))).toContain("Oferta da semana");
  });
});
