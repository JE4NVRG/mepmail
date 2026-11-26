import { LAUNCH_OFFER } from "@/lib/launch-offer";

/**
 * schema.org JSON-LD for the public pages, so search engines and AI answers read who
 * publishes the site, what the products are, what they cost and the FAQ in the page's
 * own words. Prices come from the same LAUNCH_OFFER the pages render; every URL is
 * built on the runtime base URL, so a self-hosted install never points at ours.
 */
export type JsonLd = Record<string, unknown>;

/** The public site's own copies elsewhere (repository, registries and app store). */
const SAME_AS = [
  "https://github.com/JE4NVRG/mepmail",
  "https://apps.microsoft.com/detail/9nhpx6qrf0pb",
  "https://www.npmjs.com/package/@mepmail/mcp",
  "https://glama.ai/mcp/servers/JE4NVRG/mepmail",
  "https://docs.mepmail.dev",
];

export function siteBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "https://mepmail.dev").replace(/\/+$/, "");
}

const organizationId = (base: string) => `${base}/#organization`;

export function organizationJsonLd(base: string): JsonLd {
  return {
    "@type": "Organization",
    "@id": organizationId(base),
    name: "MepMail",
    url: `${base}/`,
    logo: `${base}/logo/mepmail-logo-400.png`,
    email: "suporte@mepmail.dev",
    sameAs: SAME_AS,
  };
}

/** Sending API, SMTP relay and official MCP server software product. */
export function sendingApiJsonLd(base: string, url: string, description: string): JsonLd {
  return {
    "@type": "SoftwareApplication",
    name: "MepMail Send",
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Email API, SMTP & MCP Server",
    operatingSystem: "Cloud, Web, Linux, macOS, Windows",
    url,
    description,
    publisher: { "@id": organizationId(base) },
    offers: [
      { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
      {
        "@type": "Offer",
        name: "Pro",
        price: decimal(LAUNCH_OFFER.sending.monthlyCents),
        priceCurrency: "USD",
      },
      {
        "@type": "Offer",
        name: "Pro (BRL)",
        price: decimal(LAUNCH_OFFER.sending.brlMonthlyCents),
        priceCurrency: "BRL",
      },
    ],
  };
}

export function breadcrumbJsonLd(
  base: string,
  items: readonly { name: string; path: string }[],
): JsonLd {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.path.startsWith("http") ? item.path : `${base}${item.path}`,
    })),
  };
}

export function websiteJsonLd(base: string, locale: string): JsonLd {
  return {
    "@type": "WebSite",
    "@id": `${base}/#website`,
    name: "MepMail",
    url: `${base}/`,
    inLanguage: locale,
    publisher: { "@id": organizationId(base) },
  };
}

/** schema.org prices are plain decimals: 290 cents -> "2.90". */
const decimal = (cents: number) => (cents / 100).toFixed(2);

/** Correio: the smallest plan, in dollars and, for Brazil, in reais. */
export function correioJsonLd(base: string, url: string, description: string): JsonLd {
  const smallest = LAUNCH_OFFER.correioPlans.reduce((min, plan) =>
    plan.monthlyCents < min.monthlyCents ? plan : min,
  );
  return {
    "@type": "SoftwareApplication",
    name: "MepMail Correio",
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Email",
    operatingSystem: "Web, Windows, Linux",
    url,
    description,
    publisher: { "@id": organizationId(base) },
    offers: [
      { "@type": "Offer", price: decimal(smallest.monthlyCents), priceCurrency: "USD" },
      { "@type": "Offer", price: decimal(smallest.brlMonthlyCents), priceCurrency: "BRL" },
    ],
  };
}

/** The desktop app: free to download, it opens the account's Correio. */
export function desktopAppJsonLd(
  base: string,
  url: string,
  description: string,
  version: string,
): JsonLd {
  return {
    "@type": "SoftwareApplication",
    name: "MepMail",
    applicationCategory: "CommunicationApplication",
    operatingSystem: "Windows, Linux",
    softwareVersion: version,
    url,
    description,
    publisher: { "@id": organizationId(base) },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
}

/** A guide: headline, description, its own URL and the editorial date. */
export function articleJsonLd(
  base: string,
  page: {
    url: string;
    headline: string;
    description: string;
    dateModified: string;
    locale: string;
  },
): JsonLd {
  return {
    "@type": "Article",
    headline: page.headline,
    description: page.description,
    url: page.url,
    mainEntityOfPage: page.url,
    inLanguage: page.locale,
    datePublished: page.dateModified,
    dateModified: page.dateModified,
    author: { "@id": organizationId(base) },
    publisher: { "@id": organizationId(base) },
    image: `${base}/og.jpg`,
  };
}

export function faqJsonLd(items: readonly { q: string; a: string }[]): JsonLd {
  return {
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

/** One document per page: a @graph keeps the entities linked by @id. */
export function jsonLdDocument(graph: JsonLd[]): string {
  // `<` is escaped so no string in the copy can ever close the script element.
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(
    /</g,
    "\\u003c",
  );
}
