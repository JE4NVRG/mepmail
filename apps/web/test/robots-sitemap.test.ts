import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import robots from "../src/app/robots";
import sitemap from "../src/app/sitemap";
import { INDEXNOW_KEY } from "../src/lib/indexnow";

// Regression guard for the SEO incident of 2026-09-28: robots.ts had
// `Disallow: /` with no `/sitemap.xml` exception, so Google could not fetch the
// sitemap at all ("Couldn't fetch the sitemap — General HTTP error") while the
// file itself answered 200. The legal pages were also listed in the sitemap but
// carried `noindex` inherited from the root layout. The allow list itself is
// asserted in src/app/llms.txt/route.test.ts.

type RobotsRule = { userAgent: string; allow: string[]; disallow: string };

const allowedPaths = (): string[] => {
  const { rules } = robots();
  const rule = (Array.isArray(rules) ? rules[0] : rules) as RobotsRule | undefined;
  return rule?.allow ?? [];
};

// These rules use prefix matching and an optional end anchor, including query.
const isAllowed = (pathAndQuery: string, allow: string[]): boolean =>
  allow.some((entry) => {
    const prefix = entry.replace(/\$$/, "");
    return entry.endsWith("$") ? pathAndQuery === prefix : pathAndQuery.startsWith(prefix);
  });

describe("robots.txt + sitemap.xml agreement", () => {
  beforeEach(() => vi.stubEnv("APP_BASE_URL", undefined));
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("declares the sitemap on the runtime base URL, like sitemap.ts does", () => {
    expect(robots().sitemap).toBe("https://mepmail.dev/sitemap.xml");
    expect(sitemap().every((entry) => new URL(entry.url).origin === "https://mepmail.dev")).toBe(
      true,
    );

    // Self-hostable installs (AGPL) must never be pointed at our domain.
    vi.stubEnv("APP_BASE_URL", "https://mepmail.example.com/");
    expect(robots().sitemap).toBe("https://mepmail.example.com/sitemap.xml");
    expect(
      sitemap().every((entry) => new URL(entry.url).origin === "https://mepmail.example.com"),
    ).toBe(true);

    vi.stubEnv("APP_BASE_URL", "https://moved.example.com");
    expect(robots().sitemap).toBe("https://moved.example.com/sitemap.xml");
    expect(sitemap()[0]?.url).toBe("https://moved.example.com/");
  });

  it("allows public landing query strings while keeping private routes blocked", () => {
    const allow = allowedPaths();
    for (const path of ["/", "/?utm_source=google", "/?next=%2Ftemplates%2Fnew"]) {
      expect(isAllowed(path, allow), path).toBe(true);
    }
    for (const path of ["/emails", "/api/trpc", "/settings?tab=profile", "/console"]) {
      expect(isAllowed(path, allow), path).toBe(false);
    }
  });

  it("lets crawlers fetch the public images, the manifest and the agent-facing files", () => {
    const allow = allowedPaths();
    for (const path of [
      "/logos/integrations/n8n.svg",
      "/product/templates-gallery.webp",
      "/manifest.webmanifest",
      "/llms.txt",
      "/auth.md",
      "/.well-known/agent-skills/mepmail/SKILL.md",
      "/apple-icon.png",
    ]) {
      expect(isAllowed(path, allow), path).toBe(true);
    }
    for (const path of ["/mail", "/mailboxes", "/empty-states/emails.webp"]) {
      expect(isAllowed(path, allow), path).toBe(false);
    }
  });

  it("does not advertise request time as a page update", () => {
    expect(sitemap().every((entry) => entry.lastModified === undefined)).toBe(true);
  });

  it("allows every URL the sitemap advertises", () => {
    const allow = allowedPaths();
    const urls = sitemap();
    // 6 URLs from the SEO fix + the three public pages added with /pricing,
    // /alternatives/resend and /integrations, plus the two institutional pages
    // (/security and /support), /changelog and the guides (index + 3); each in English and
    // in Portuguese.
    expect(urls).toHaveLength(32);

    for (const entry of urls) {
      const { pathname, search } = new URL(entry.url as string);
      expect(
        isAllowed(pathname + search, allow),
        `${pathname}${search} is advertised but not allowed by robots.txt`,
      ).toBe(true);
    }
  });

  it("advertises /correio only while Mail is open, and robots lets crawlers in", () => {
    const has = () =>
      sitemap().some((entry) => new URL(entry.url as string).pathname === "/correio");
    expect(has()).toBe(false);
    vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
    const urls = sitemap();
    // /correio, the desktop downloads and the Linux app's page, in both languages.
    expect(urls).toHaveLength(38);
    expect(has()).toBe(true);
    expect(urls.find((entry) => entry.url.endsWith("/desktop/correio/linux"))?.priority).toBe(0.6);
    expect(isAllowed("/desktop/correio/linux", allowedPaths())).toBe(true);
    expect(urls.find((entry) => entry.url.endsWith("/download"))?.priority).toBe(0.8);
    expect(isAllowed("/download", allowedPaths())).toBe(true);
    expect(isAllowed("/desktop/correio/windows", allowedPaths())).toBe(false);
    expect(urls.find((entry) => entry.url.endsWith("/correio"))?.priority).toBe(0.9);
    expect(isAllowed("/correio", allowedPaths())).toBe(true);
    expect(isAllowed("/correio/opengraph-image", allowedPaths())).toBe(true);
  });

  it("lists every page in English and in Portuguese, both with the same hreflang set", () => {
    // Crawlers send neither the cookie nor Accept-Language: without its own URL the
    // Portuguese copy was never indexed.
    const urls = sitemap();
    const english = urls.filter((entry) => !entry.url.includes("?"));
    expect(english).toHaveLength(16);
    for (const entry of english) {
      const portuguese = `${entry.url}?lang=pt-BR`;
      const twin = urls.find((other) => other.url === portuguese);
      expect(twin, portuguese).toBeDefined();
      const languages = {
        en: entry.url,
        "pt-BR": portuguese,
        "x-default": entry.url,
      };
      expect(entry.alternates?.languages).toEqual(languages);
      expect(twin?.alternates?.languages).toEqual(languages);
      expect(twin?.priority).toBe(entry.priority);
    }
    expect(urls.some((entry) => entry.url === "https://mepmail.dev/?lang=pt-BR")).toBe(true);
  });

  it("serves the IndexNow key file and lets crawlers fetch it", () => {
    const file = fileURLToPath(new URL(`../public/${INDEXNOW_KEY}.txt`, import.meta.url));
    expect(readFileSync(file, "utf8")).toBe(INDEXNOW_KEY);
    expect(INDEXNOW_KEY).toMatch(/^[0-9a-f]{32}$/);
    expect(isAllowed(`/${INDEXNOW_KEY}.txt`, allowedPaths())).toBe(true);
  });

  it("advertises the institutional pages with their own priority and allows them", () => {
    const urls = sitemap();
    const priorityOf = (pathname: string): number | undefined =>
      urls.find((entry) => new URL(entry.url as string).pathname === pathname)?.priority;

    expect(priorityOf("/security")).toBe(0.7);
    expect(priorityOf("/support")).toBe(0.6);
    expect(priorityOf("/changelog")).toBe(0.6);
    // All three are linked from the public footer, so all three must be crawlable.
    expect(allowedPaths()).toEqual(expect.arrayContaining(["/security", "/support", "/changelog"]));
  });
});
