/**
 * Logos of the surfaces MepMail really plugs into, vendored as monochrome SVGs
 * under public/logos/integrations (see that folder's README for provenance).
 *
 * Only integrations we can point at are listed here: the n8n community node,
 * the Slack/Discord/Telegram notification channels, the languages with an
 * official SDK that the API is drop-in compatible with, Docker for self-hosting
 * and cURL for the raw API. There is deliberately NO logo for MCP — no vendor
 * mark stands for it, so the strip draws a text chip instead.
 */

export interface StackLogo {
  /** simple-icons slug, also the file name inside public/logos/integrations. */
  slug: string;
  /** Proper brand name used as alt text. */
  name: string;
  /** Shown on the landing strip; the /integrations mural shows every entry. */
  home: boolean;
}

/** Slug of the drawn "MCP" chip: a stack entry with no vendor logo. */
export const MCP_CHIP = "mcp";

export const STACK_LOGOS: readonly StackLogo[] = [
  { slug: "n8n", name: "n8n", home: true },
  { slug: "slack", name: "Slack", home: true },
  { slug: "discord", name: "Discord", home: true },
  { slug: "telegram", name: "Telegram", home: true },
  { slug: "nodedotjs", name: "Node.js", home: true },
  { slug: "python", name: "Python", home: true },
  { slug: "php", name: "PHP", home: true },
  { slug: "ruby", name: "Ruby", home: false },
  { slug: "go", name: "Go", home: true },
  { slug: "docker", name: "Docker", home: true },
  { slug: "curl", name: "cURL", home: true },
];

export const HOME_STACK_LOGOS: readonly StackLogo[] = STACK_LOGOS.filter((logo) => logo.home);

/** Resolves a card's slug to its logo; undefined means "render the MCP chip". */
export function stackLogo(slug: string): StackLogo | undefined {
  return STACK_LOGOS.find((logo) => logo.slug === slug);
}

export function logoSrc(slug: string): string {
  return `/logos/integrations/${slug}.svg`;
}
