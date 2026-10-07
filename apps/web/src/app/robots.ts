import type { MetadataRoute } from "next";

// Resolve APP_BASE_URL when requested, including after a domain migration.
export const dynamic = "force-dynamic";

// The dashboard is private: crawlers get the public pages (the landing, the
// standalone pricing page, the Correio page, the comparison page, the integrations, security and
// support pages, the auth entry points and the legal pages) plus the static
// assets those pages need to render, and nothing else. `/sitemap.xml` stays
// crawlable on purpose — it is the file that advertises those same public URLs
// to crawlers. Keep this list in step with sitemap.ts whenever a public route
// is added.
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.APP_BASE_URL ?? "https://mepmail.dev").replace(/\/+$/, "");
  return {
    rules: {
      userAgent: "*",
      allow: [
        "/$",
        "/?",
        "/pricing",
        "/correio",
        "/alternatives",
        "/integrations",
        "/security",
        "/support",
        "/changelog",
        "/login",
        "/signup",
        "/terms",
        "/privacy",
        "/refund",
        "/auth/",
        "/sitemap.xml",
        "/_next/",
        "/logo/",
        "/fonts/",
        "/og.png",
        "/favicon.ico",
      ],
      disallow: "/",
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
