import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import robots from "../src/app/robots";
import sitemap from "../src/app/sitemap";

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

  it("does not advertise request time as a page update", () => {
    expect(sitemap().every((entry) => entry.lastModified === undefined)).toBe(true);
  });

  it("allows every URL the sitemap advertises", () => {
    const allow = allowedPaths();
    const urls = sitemap();
    // 6 URLs from the SEO fix + the three public pages added with /pricing,
    // /alternatives/resend and /integrations, plus the two institutional pages
    // (/security and /support) and /changelog.
    expect(urls).toHaveLength(12);

    for (const entry of urls) {
      const { pathname } = new URL(entry.url as string);
      expect(
        isAllowed(pathname, allow),
        `${pathname} is advertised but not allowed by robots.txt`,
      ).toBe(true);
    }
  });

  it("advertises /correio only while Mail is open, and robots lets crawlers in", () => {
    const has = () =>
      sitemap().some((entry) => new URL(entry.url as string).pathname === "/correio");
    expect(has()).toBe(false);
    vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
    const urls = sitemap();
    expect(urls).toHaveLength(13);
    expect(has()).toBe(true);
    expect(urls.find((entry) => entry.url.endsWith("/correio"))?.priority).toBe(0.9);
    expect(isAllowed("/correio", allowedPaths())).toBe(true);
    expect(isAllowed("/correio/opengraph-image", allowedPaths())).toBe(true);
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
