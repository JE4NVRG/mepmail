import type { MetadataRoute } from "next";

// The dashboard is private: crawlers get the public pages (the landing and
// the auth entry points) plus the static assets those pages need to render,
// and nothing else.
export default function robots(): MetadataRoute.Robots {
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
        "/_next/",
        "/logo/",
        "/fonts/",
        "/og.png",
        "/favicon.ico",
      ],
      disallow: "/",
    },
  };
}
