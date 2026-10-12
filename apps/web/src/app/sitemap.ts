import type { MetadataRoute } from "next";
import { GUIDE_SLUGS, guidePath } from "@/lib/guides";
import { languageAlternates, localizedPath } from "@/lib/public-locale-url";

// Resolve APP_BASE_URL when requested, rather than freezing it at build time.
export const dynamic = "force-dynamic";

// Public, indexable pages: the landing, the standalone pricing page, the
// Correio page, the desktop downloads and the Linux page (once Mail is open and indexable),
// the "Resend alternative" comparison, the integrations, security and support
// pages and the auth entry points (mirrors robots.ts). The dashboard has no public URLs of its own.
// Each page is listed in English (the plain path) and in Portuguese (?lang=pt-BR),
// both carrying the same hreflang set (see lib/public-locale-url.ts).
export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.APP_BASE_URL ?? "https://mepmail.dev").replace(/\/+$/, "");
  // /correio carries noindex while Mail is closed; advertise it only when open.
  const correio: MetadataRoute.Sitemap =
    process.env.MAILBOX_EARLY_ACCESS_OPEN === "true"
      ? [
          { url: `${base}/correio`, changeFrequency: "weekly", priority: 0.9 },
          { url: `${base}/download`, changeFrequency: "monthly", priority: 0.8 },
          { url: `${base}/desktop/correio/linux`, changeFrequency: "monthly", priority: 0.6 },
        ]
      : [];
  // Omit lastModified until each page has a reliable editorial update date.
  const pages: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/pricing`, changeFrequency: "monthly", priority: 0.9 },
    ...correio,
    { url: `${base}/alternatives/resend`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/integrations`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/security`, changeFrequency: "yearly", priority: 0.7 },
    { url: `${base}/support`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/changelog`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/guides`, changeFrequency: "monthly", priority: 0.6 },
    ...GUIDE_SLUGS.map((slug) => ({
      url: `${base}${guidePath(slug)}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    { url: `${base}/signup`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/login`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "yearly", priority: 0.4 },
    { url: `${base}/privacy`, changeFrequency: "yearly", priority: 0.4 },
    { url: `${base}/refund`, changeFrequency: "yearly", priority: 0.4 },
  ];
  return pages.flatMap((page) => {
    const path = page.url.slice(base.length);
    const languages = Object.fromEntries(
      Object.entries(languageAlternates(path)).map(([lang, href]) => [lang, `${base}${href}`]),
    );
    return [
      { ...page, alternates: { languages } },
      { ...page, url: `${base}${localizedPath(path, "pt-BR")}`, alternates: { languages } },
    ];
  });
}
