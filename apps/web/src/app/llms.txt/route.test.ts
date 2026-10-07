import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import { GET } from "./route";

describe("crawler entry points", () => {
  it("llms.txt points agents at the public docs source", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("https://docs.mepmail.dev");
    expect(body).toContain("https://mepmail.dev/auth.md");
    expect(body).toContain("https://api.mepmail.dev/mcp");
    // Correio is announced to agents with its own MCP endpoint and guide.
    expect(body).toContain("https://mepmail.dev/correio");
    expect(body).toContain("https://api.mepmail.dev/mcp/correio");
    expect(body).toContain("https://docs.mepmail.dev/mailboxes");
    expect(body).not.toContain("millionsend.com");
  });

  it("robots lets crawlers into the public pages and keeps the rest out", () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const allow = (rule?.allow ?? []) as string[];
    expect(rule?.disallow).toBe("/");
    // The sitemap must stay reachable: `Disallow: /` without this exception is
    // what made Google report "Couldn't fetch the sitemap".
    for (const path of [
      "/$",
      "/pricing",
      "/correio",
      "/alternatives",
      "/changelog",
      "/login",
      "/signup",
      "/terms",
      "/privacy",
      "/refund",
      "/sitemap.xml",
      "/auth/",
      "/_next/",
      "/logo/",
      "/fonts/",
      "/og.png",
      "/favicon.ico",
    ]) {
      expect(allow).toContain(path);
    }
    expect(robots().sitemap).toBe("https://mepmail.dev/sitemap.xml");
  });
});
