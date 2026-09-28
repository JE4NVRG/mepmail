import { afterEach, describe, expect, it } from "vitest";
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

// Minimal robots matcher: "/$" only matches the root, everything else matches
// the exact path or a path inside it.
const isAllowed = (pathname: string, allow: string[]): boolean =>
  allow.some((entry) => {
    const prefix = entry.replace(/\$$/, "");
    if (prefix === "/") return pathname === "/";
    return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  });

describe("robots.txt + sitemap.xml agreement", () => {
  afterEach(() => {
    delete process.env.APP_BASE_URL;
  });

  it("declares the sitemap on the runtime base URL, like sitemap.ts does", () => {
    expect(robots().sitemap).toBe("https://mepmail.je4ndev.com/sitemap.xml");

    // Self-hostable installs (AGPL) must never be pointed at our domain.
    process.env.APP_BASE_URL = "https://mepmail.example.com/";
    expect(robots().sitemap).toBe("https://mepmail.example.com/sitemap.xml");
  });

  it("allows every URL the sitemap advertises", () => {
    const allow = allowedPaths();
    const urls = sitemap();
    expect(urls).toHaveLength(6);

    for (const entry of urls) {
      const { pathname } = new URL(entry.url as string);
      expect(
        isAllowed(pathname, allow),
        `${pathname} is advertised but not allowed by robots.txt`,
      ).toBe(true);
    }
  });
});
