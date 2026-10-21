/**
 * Public guides (/guides/<slug>): how-tos for the searches people make before they
 * buy email (Keyword Planner, Brazil, 2026-10-12). Copy lives in messages/<locale>/
 * guides.json under items.<slug>; this list is the routes, the sitemap and the index.
 */
export const GUIDE_SLUGS = [
  "custom-domain-email",
  "email-authentication",
  "transactional-email",
  "ai-agent-email-mcp",
  "smtp-relay-setup",
] as const;
export type GuideSlug = (typeof GUIDE_SLUGS)[number];

/** Editorial date of the current copy, shown on the page and in the Article data. */
export const GUIDES_UPDATED = "2026-10-21";

export function isGuideSlug(value: string): value is GuideSlug {
  return (GUIDE_SLUGS as readonly string[]).includes(value);
}

export const guidePath = (slug: GuideSlug) => `/guides/${slug}`;

export type GuideSection = {
  title: string;
  body?: string[];
  steps?: string[];
  /** A config or code sample, rendered under the prose as a labelled block. */
  code?: { label: string; content: string };
};
export type GuideCopy = {
  meta: { title: string; description: string };
  card: string;
  eyebrow: string;
  title: string;
  lead: string;
  sections: GuideSection[];
  faq: { q: string; a: string }[];
  cta: { title: string; body: string; button: string; docs?: { label: string; href: string } };
};
