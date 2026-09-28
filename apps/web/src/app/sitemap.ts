import type { MetadataRoute } from "next";

// Public, indexable pages: the landing and the auth entry points (mirrors
// robots.ts). The dashboard has no public URLs of its own.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.APP_BASE_URL ?? "https://mepmail.je4ndev.com").replace(/\/+$/, "");
  const lastModified = new Date();
  return [
    { url: `${base}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/signup`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/login`, lastModified, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/terms`, lastModified, changeFrequency: "yearly", priority: 0.4 },
    { url: `${base}/privacy`, lastModified, changeFrequency: "yearly", priority: 0.4 },
    { url: `${base}/refund`, lastModified, changeFrequency: "yearly", priority: 0.4 },
  ];
}
