import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTranslator } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enCommon from "../messages/en/common.json";
import enLanding from "../messages/en/landing.json";
import enStatus from "../messages/en/status.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptLanding from "../messages/pt-BR/landing.json";
import ptStatus from "../messages/pt-BR/status.json";

const current = vi.hoisted(() => ({ locale: "en" as "en" | "pt-BR", theme: "dark" }));
const messages = {
  en: { common: enCommon, landing: enLanding, status: enStatus },
  "pt-BR": { common: ptCommon, landing: ptLanding, status: ptStatus },
};
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: current.theme }) }),
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => current.locale,
  getTranslations: async (namespace: "common.notFound" | "landing" | "status") =>
    createTranslator({ locale: current.locale, messages: messages[current.locale], namespace }),
}));

const { default: GlobalNotFound, generateMetadata } = await import("../src/app/global-not-found");

describe("unmatched-route 404", () => {
  it("renders a complete small localized document with internal recovery links and the existing theme", async () => {
    for (const locale of ["en", "pt-BR"] as const) {
      current.locale = locale;
      current.theme = locale === "pt-BR" ? "light" : "dark";
      const html = renderToStaticMarkup(await GlobalNotFound());
      expect(html).toContain(`<html lang="${locale}"`);
      expect(html.includes('data-theme="light"')).toBe(current.theme === "light");
      expect(html).toContain(messages[locale].common.notFound.title);
      expect(html).toContain('class="ms-digits ms-status-code">404<');
      expect([...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual([
        "/emails",
        "/support",
        "/status",
      ]);
      expect(Buffer.byteLength(html)).toBeLessThan(6_000);
      const metadata = await generateMetadata();
      expect(metadata.title).toContain(messages[locale].common.notFound.title);
      expect(metadata.robots).toEqual({ index: false, follow: false });
      expect(html).not.toMatch(
        /api\/auth|advertising-consent|umami|googletagmanager|connect\.facebook/,
      );
    }
  });

  it("uses the documented global boundary without moving data-level notFound out of the normal layout", () => {
    const read = (path: string) =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    expect(read("../next.config.ts")).toContain("globalNotFound: true");
    const global = read("../src/app/global-not-found.tsx");
    expect(global).not.toMatch(
      /NextIntlClientProvider|Providers|AdvertisingConsent|AndroidAppGuard|UmamiAnalytics/,
    );
    expect(read("../src/app/not-found.tsx")).toContain("getTranslations");
  });
});
