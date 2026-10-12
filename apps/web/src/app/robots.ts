import type { MetadataRoute } from "next";
import { INDEXNOW_KEY } from "@/lib/indexnow";

// Resolve APP_BASE_URL when requested, including after a domain migration.
export const dynamic = "force-dynamic";

// The dashboard is private: crawlers get the public pages (the landing, the
// standalone pricing page, the Correio page, the comparison page, the integrations, security and
// support pages, the auth entry points and the legal pages), the static assets
// those pages need to render, and the agent-facing files (llms.txt, auth.md and
// .well-known), and nothing else. `/sitemap.xml` stays
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
        // The desktop downloads page.
        "/download",
        // The Linux app's page and its package links; the Windows installer stays out.
        "/desktop/correio/linux",
        "/alternatives",
        // The public how-to guides (lib/guides.ts).
        "/guides",
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
        "/logos/",
        "/product/",
        "/fonts/",
        "/og.png",
        "/og.jpg",
        "/favicon.ico",
        "/apple-icon.png",
        "/manifest.webmanifest",
        // Machine-readable descriptions for AI agents and crawlers.
        "/llms.txt",
        "/auth.md",
        "/.well-known/",
        // The IndexNow key file, which proves our URL announcements come from this host.
        `/${INDEXNOW_KEY}.txt`,
      ],
      disallow: "/",
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
