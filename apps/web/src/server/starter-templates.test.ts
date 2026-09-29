import { describe, expect, it } from "vitest";
import {
  isStarterKey,
  listStarters,
  listStartersWithContent,
  renderStarter,
  STARTER_KEYS,
} from "./starter-templates";

/** Same grammar the editor inserts and the send worker resolves. */
const MERGE_TOKEN_RE = /\{\{\{([A-Za-z0-9_]+)(?:\|([^{}]*))?\}\}\}/g;

describe("starter templates", () => {
  it("lists every key in canonical order, localized", () => {
    const en = listStarters("en");
    const pt = listStarters("pt-BR");
    expect(en.map((s) => s.key)).toEqual([...STARTER_KEYS]);
    expect(pt.map((s) => s.key)).toEqual([...STARTER_KEYS]);
    for (const s of en) {
      expect(s.name.trim().length).toBeGreaterThan(0);
      expect(s.description.trim().length).toBeGreaterThan(0);
    }
    // pt-BR and en are actually distinct copies.
    expect(en.map((s) => s.name).join("|")).not.toBe(pt.map((s) => s.name).join("|"));
  });

  it("renders full content per key and locale", () => {
    for (const key of STARTER_KEYS) {
      const en = renderStarter(key, "en");
      const pt = renderStarter(key, "pt-BR");
      expect(en.subject.trim().length).toBeGreaterThan(0);
      expect(pt.subject.trim().length).toBeGreaterThan(0);
      for (const detail of [en, pt]) {
        expect(detail.html).toContain("<!doctype html>");
        expect(detail.html).toContain("{{{"); // at least one merge token
        expect(detail.text.trim().length).toBeGreaterThan(0);
        expect(detail.html).not.toContain("undefined");
        expect(detail.text).not.toContain("undefined");
      }
    }
  });

  it("uses the builtins the merge picker and worker share", () => {
    expect(renderStarter("newsletter", "en").html).toContain("{{{UNSUBSCRIBE_URL}}}");
    expect(renderStarter("welcome", "en").html).toContain("{{{FIRST_NAME|there}}}");
    expect(renderStarter("welcome", "pt-BR").html).toContain("{{{FIRST_NAME|tudo bem}}}");
  });

  it("falls back to en for unknown locales and validates keys", () => {
    const fallback = renderStarter("welcome", "fr" as unknown as string);
    expect(fallback.subject).toBe(renderStarter("welcome", "en").subject);
    expect(isStarterKey("welcome")).toBe(true);
    expect(isStarterKey("nope")).toBe(false);
    expect(listStartersWithContent("en")).toHaveLength(STARTER_KEYS.length);
  });

  it("keeps the worker token grammar intact in every rendered body", () => {
    for (const key of STARTER_KEYS) {
      for (const locale of ["en", "pt-BR"] as const) {
        const { html, text } = renderStarter(key, locale);
        for (const chunk of [html, text]) {
          const tokens = chunk.match(MERGE_TOKEN_RE) ?? [];
          expect(tokens.length).toBeGreaterThan(0);
        }
        // No malformed braces: every opener has its closer.
        const opens = (html.match(/\{\{\{/g) ?? []).length;
        const closes = (html.match(/\}\}\}/g) ?? []).length;
        expect(opens).toBe(closes);
      }
    }
  });
});
