import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Analytics self-hosted (Umami). O tracker é servido de OUTRA origem, logo
// precisa estar liberado em script-src (carregar o script) e em connect-src
// (o beacon de pageview/evento). Manter em sincronia com UMAMI_SCRIPT_URL em
// src/lib/analytics.ts — as duas pontas mudam juntas.
const UMAMI_ORIGIN = "https://umami.je4ndev.com";
// Public visitor support; keep in sync with src/lib/elozi-support.ts.
const ELOZI_ORIGIN = "https://elozi.je4ndev.com";

const config: NextConfig = {
  poweredByHeader: false,
  experimental: {
    // Keep visited page segments in the client router cache so sidebar
    // back-and-forth doesn't refetch RSC payloads every click. Safe at 30s:
    // dashboard pages are "use client" shells whose data flows through
    // react-query (its own freshness rules) — the cached payload holds no
    // user data that could go stale.
    staleTimes: { dynamic: 30, static: 180 },
  },
  async redirects() {
    return [
      {
        source: "/llms-full.txt",
        destination: "https://docs.mepmail.dev/llms-full.txt",
        permanent: true,
      },
    ];
  },
  async headers() {
    const scriptPolicy =
      process.env.NODE_ENV === "development"
        ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com ${UMAMI_ORIGIN}`
        : `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com ${UMAMI_ORIGIN}`;
    const contentSecurityPolicy = [
      "default-src 'self'",
      scriptPolicy,
      "style-src 'self' 'unsafe-inline'",
      // Team logos are served from S3_STORAGE_PUBLIC_URL, a runtime value this
      // build-time policy cannot name; images carry no script, so any https
      // origin is acceptable.
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      // Umami envia pageviews e eventos por fetch/beacon para a própria origem.
      `connect-src 'self' ${UMAMI_ORIGIN}`,
      "media-src 'self'",
      "object-src 'none'",
      // Turnstile renders its challenge in a Cloudflare frame.
      "frame-src https://challenges.cloudflare.com",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; ");
    // The optional Pixel is confined to public offer documents. A new document
    // is required when leaving those routes after its SDK has loaded.
    const publicMetaEnabled =
      process.env.NEXT_PUBLIC_META_PIXEL_ENABLED === "true" &&
      /^[0-9]{5,30}$/.test(process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "");
    const publicContentSecurityPolicy = contentSecurityPolicy
      .replace(scriptPolicy, `${scriptPolicy} https://connect.facebook.net`)
      .replace(
        `connect-src 'self' ${UMAMI_ORIGIN}`,
        `connect-src 'self' ${UMAMI_ORIGIN} https://www.facebook.com`,
      );
    const supportContentSecurityPolicy = contentSecurityPolicy
      .replace(scriptPolicy, `${scriptPolicy} ${ELOZI_ORIGIN}`)
      .replace(
        `connect-src 'self' ${UMAMI_ORIGIN}`,
        `connect-src 'self' ${UMAMI_ORIGIN} ${ELOZI_ORIGIN}`,
      );
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Browsers only honour HSTS over https, so plain-http self-hosts
          // are unaffected; no preload until every subdomain is TLS-clean.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      // Support links use document navigation so this policy takes effect.
      // The page destroys its visitor widget before leaving; microphone stays off.
      {
        source: "/support",
        headers: [{ key: "Content-Security-Policy", value: supportContentSecurityPolicy }],
      },
      ...(publicMetaEnabled
        ? // Mirrors META_PUBLIC_PATHS in src/lib/meta-public-events.ts.
          ["/", "/pricing", "/correio"].map((source) => ({
            source,
            headers: [
              { key: "Content-Security-Policy", value: publicContentSecurityPolicy },
              { key: "Referrer-Policy", value: "no-referrer" },
            ],
          }))
        : []),
    ];
  },
  // Workspace packages ship TS source with NodeNext-style "./file.js"
  // relative imports. Resolving those needs webpack's extensionAlias;
  // Turbopack has no equivalent yet (vercel/next.js#82945, checked
  // 2026-08), so dev/build scripts pass --webpack.
  transpilePackages: [
    "@millionsend/config",
    "@millionsend/core",
    "@millionsend/db",
    "@millionsend/ses",
  ],
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return webpackConfig;
  },
};

export default withNextIntl(config);
