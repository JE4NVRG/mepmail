import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listStarters, STARTER_KEYS } from "../src/server/starter-templates";

const h = vi.hoisted(() => ({ locale: "pt-BR" }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => h.locale,
  getTranslations: async () => (key: string) => key,
}));
const { PublicStarterGallery } = await import("@/components/public-starter-gallery");

afterEach(() => {
  h.locale = "pt-BR";
});

function signupDestinations(markup: string) {
  return [...markup.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => {
    const signup = new URL(match[1] ?? "", "https://fixture.example");
    expect(signup.pathname).toBe("/signup");
    expect([...signup.searchParams.keys()]).toEqual(["next"]);
    return signup.searchParams.get("next");
  });
}

function expectDecorativeSSR(markup: string, count: number) {
  // The sample email loads in the browser only after entering the viewport.
  expect(markup).not.toMatch(/<iframe\b|\bsrcdoc=|&lt;!doctype|<script\b|VOLTEI10|4242/i);
  expect(markup.match(/class="cro-starter-preview" aria-hidden="true" inert=""/g)).toHaveLength(
    count,
  );
}

describe("public starters and editor intent", () => {
  for (const locale of ["en", "pt-BR"] as const) {
    it(`${locale}: carries each of the ten real starters through signup without sample email SSR`, async () => {
      h.locale = locale;
      const markup = renderToStaticMarkup(await PublicStarterGallery({}));
      const destinations = signupDestinations(markup);
      expect(destinations).toHaveLength(10);
      expect(destinations).toEqual(
        STARTER_KEYS.map((key) => `/templates/new?starter=${encodeURIComponent(key)}`),
      );
      for (const template of listStarters(locale)) expect(markup).toContain(template.name);
      expectDecorativeSSR(markup, 10);
      expect(markup).not.toContain("templates-gallery.webp");
    });

    it(`${locale}: shows four localized, actionable hero models with deferred decorative previews`, async () => {
      h.locale = locale;
      const markup = renderToStaticMarkup(await PublicStarterGallery({ compact: true }));
      expect(signupDestinations(markup)).toEqual(
        ["welcome", "verify-email", "order-confirmation", "shipping-update"].map(
          (key) => `/templates/new?starter=${key}`,
        ),
      );
      expect(markup).toContain(locale === "en" ? "Welcome" : "Boas-vindas");
      expectDecorativeSSR(markup, 4);
    });
  }

  it("keeps the eventual iframe sandboxed, noninteractive and viewport deferred", () => {
    // SSR has no iframe. Pin the later client boundary's restrictions separately.
    const preview = readFileSync(
      fileURLToPath(new URL("../src/components/deferred-template-preview.tsx", import.meta.url)),
      "utf8",
    );
    expect(preview).toContain("new IntersectionObserver(");
    expect(preview).toContain('await import("@/server/starter-templates")');
    expect(preview).toContain('sandbox=""');
    expect(preview).toContain("tabIndex={-1}");
    expect(preview).toContain('loading="lazy"');
    expect(preview).not.toMatch(/allow-scripts|allow-same-origin/);
  });
});
