import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  headers: new Headers(),
  cookie: "pt-BR",
  cookies: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => state.headers,
  cookies: async () => {
    state.cookies();
    return { get: () => ({ value: state.cookie }) };
  },
}));
vi.mock("next-intl/server", () => ({ getRequestConfig: (fn: unknown) => fn }));
vi.mock("next-intl/plugin", () => ({ default: () => (config: unknown) => config }));
vi.mock("@millionsend/config", () => ({ env: {} }));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import requestConfig from "@/i18n/request";
import { publicClientMessages } from "@/lib/client-messages";
import { publicMarketingMessages } from "@/lib/public-message-scope";
import { proxy } from "@/proxy";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

beforeEach(() => {
  state.headers = new Headers({ "accept-language": "pt-BR" });
  state.cookie = "pt-BR";
  state.cookies.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("marketing client serialization is not server translation filtering", () => {
  it.each(["en", "pt-BR"])("preserves public/auth keys and drops app controls in %s", (locale) => {
    const original = publicClientMessages("/", locale)!;
    const serializedBefore = JSON.stringify(original);
    for (const path of [
      "/",
      "/pricing",
      "/signup",
      "/login",
      "/support/chat",
      "/desktop/correio/linux",
    ]) {
      const selected = publicMarketingMessages(`${path}?lang=${locale}`, locale)!;
      expect(Object.keys(selected).sort()).toEqual(["auth", "common", "correio", "landing"]);
      expect(selected.auth).toEqual(original.auth);
      expect(selected.landing).toEqual(original.landing);
      expect(selected.correio).toEqual(original.correio);
      expect(selected).not.toHaveProperty("supportTickets");
      expect(selected).not.toHaveProperty("console");
      expect(selected.common).not.toHaveProperty("supportView");
      expect(selected.common).not.toHaveProperty("teamSwitcher");
      expect(selected.common).not.toHaveProperty("commandPalette");
      expect(selected.common).toHaveProperty("advertising");
      expect(selected.common).not.toHaveProperty("subscriptionsPaused");
      expect(JSON.stringify(selected).length).toBeLessThan(serializedBefore.length);
    }
    expect(JSON.stringify(original)).toBe(serializedBefore);
    expect(original.common).toHaveProperty("supportView");
  });

  it.each([
    undefined,
    null,
    "",
    "//evil.invalid/",
    "https://mepmail.dev/",
    "/console",
    "/api",
    "/mailboxes",
    "/settings",
    "/guides/not-a-guide",
    "/pricing/private",
    "/%70ricing",
    "/pricing#private",
    "/pricing\\private",
  ])("retains the app fallback for an absent, malformed or nonpublic target: %s", (path) =>
    expect(publicMarketingMessages(path, "en")).toBeUndefined(),
  );

  it("does not invent a fallback language", () => {
    expect(publicMarketingMessages("/pricing/", "pt-BR")).toBeDefined();
    expect(publicMarketingMessages("/", "unsupported")).toBeUndefined();
  });

  it("uses the proxy's overwritten request target, never caller pathname metadata", () => {
    const response = proxy(
      new NextRequest("https://mepmail.dev/settings", {
        headers: { "x-mepmail-next": "/pricing", "x-mepmail-url-locale": "en" },
      }),
    );
    const target = response.headers.get("x-middleware-request-x-mepmail-next");
    expect(target).toBe("/settings");
    expect(publicMarketingMessages(target, "en")).toBeUndefined();
    expect(response.headers.get("x-middleware-request-x-mepmail-url-locale")).toBeNull();
  });

  it("keeps full server namespaces while avoiding unnecessary public locale-cookie reads", async () => {
    state.headers.set("x-mepmail-url-locale", "en");
    const resolved = await requestConfig({ requestLocale: Promise.resolve(undefined) });
    expect(resolved.locale).toBe("en");
    expect(state.cookies).not.toHaveBeenCalled();
    expect(resolved.messages).toHaveProperty("pricing");
    expect(resolved.messages).toHaveProperty("console");
    expect(resolved.messages).toHaveProperty("support");
    expect(resolved.messages?.common).toHaveProperty("supportView");
    expect(resolved.messages?.pricing).toEqual(
      (await import("../messages/en/pricing.json")).default,
    );
  });

  it("retains cookie negotiation for auth and unrecognized locale metadata", async () => {
    for (const locale of [undefined, "invalid"]) {
      if (locale) state.headers.set("x-mepmail-url-locale", locale);
      else state.headers.delete("x-mepmail-url-locale");
      const resolved = await requestConfig({ requestLocale: Promise.resolve(undefined) });
      expect(resolved.locale).toBe("pt-BR");
    }
    expect(state.cookies).toHaveBeenCalledTimes(2);
  });
});

describe("public SEO and security boundaries", () => {
  it("advertises the indexable status page in both locales without opening private crawling", () => {
    vi.stubEnv("APP_BASE_URL", "https://fixture.invalid");
    const rules = robots().rules;
    expect(rules).toMatchObject({ disallow: "/" });
    expect(rules).toMatchObject({ allow: expect.arrayContaining(["/status", "/_next/"]) });
    const entries = sitemap();
    const status = entries.filter((entry) =>
      entry.url.startsWith("https://fixture.invalid/status"),
    );
    expect(status).toHaveLength(2);
    for (const page of status) {
      expect(page.alternates?.languages).toEqual({
        en: "https://fixture.invalid/status",
        "pt-BR": "https://fixture.invalid/status?lang=pt-BR",
        "x-default": "https://fixture.invalid/status",
      });
    }
    expect(
      entries.some((page) => /\/(console|settings|mailboxes|docs)(?:[/?]|$)/.test(page.url)),
    ).toBe(false);
    expect(new Set(entries.map((page) => page.url)).size).toBe(entries.length);
  });

  it("preserves noindex gates and does not enable shared caching of cookie-themed documents", () => {
    const root = source("../src/app/layout.tsx");
    expect(root).toContain("robots: { index: false, follow: false }");
    expect(root).toContain("(await cookies()).get(THEME_KEY)");
    expect(root).toContain(
      'publicMarketingMessages((await headers()).get("x-mepmail-next"), locale)',
    );
    expect(root).not.toMatch(/force-static|s-maxage|unstable_cache|use cache/);
    expect(source("../src/i18n/request.ts")).not.toMatch(/unstable_cache|use cache/);
    expect(root).toContain("MepMail | Email API and mailboxes for apps and agents");
    expect(root).toContain("MepMail | API de e-mail e caixas para apps e agentes");
  });

  it("retains existing CSP/desktop compatibility and hardening until a trusted desktop build exists", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const config = (await import("../next.config")).default;
    const rules = (await config.headers?.()) ?? [];
    const common = rules.find((rule) => rule.source === "/:path*")!.headers;
    const value = (name: string) => common.find((header) => header.key === name)?.value;
    expect(value("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect(value("X-Frame-Options")).toBe("DENY");
    expect(value("X-Content-Type-Options")).toBe("nosniff");
    expect(value("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(value("Content-Security-Policy")).toContain(
      "ipc: http://ipc.localhost https://ipc.localhost",
    );
    expect(value("Content-Security-Policy")).not.toContain("'unsafe-eval'");
  });
});
