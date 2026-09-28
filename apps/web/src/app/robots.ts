import type { MetadataRoute } from "next";

// The dashboard is private: crawlers get the public pages (the landing, the
// auth entry points and the legal pages) plus the static assets those pages
// need to render, and nothing else. `/sitemap.xml` stays crawlable on purpose
// — it is the file that advertises those same public URLs to crawlers. Keep
// this list in step with sitemap.ts whenever a public route is added.
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.APP_BASE_URL ?? "https://mepmail.je4ndev.com").replace(/\/+$/, "");
  return {
    rules: {
      userAgent: "*",
      allow: [
        "/$",
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
