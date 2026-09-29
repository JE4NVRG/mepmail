/**
 * Marks of the surfaces MepMail really plugs into, vendored as the vendor's own
 * full-colour SVGs under public/logos/integrations (see that folder's README for
 * the source URL of every file).
 *
 * Only integrations we can point at are listed here: the n8n community node,
 * the Slack/Discord/Telegram notification channels, the languages with an
 * official SDK that the API is drop-in compatible with, Docker for self-hosting
 * and cURL for the raw API. There is deliberately NO logo for MCP — no vendor
 * mark stands for it, so a card draws a text chip instead.
 *
 * `ratio` is the ink aspect ratio (width / height, measured from each file's
 * viewBox) of the vendored artwork. The bands normalise marks by HEIGHT, so the
 * ratio is what turns that height into a width: it reserves the right box for
 * each mark and keeps a wide lockup from being squeezed into a square.
 */

export interface StackLogo {
  /** simple-icons-style slug, also the file name inside public/logos/integrations. */
  slug: string;
  /** Proper brand name used as alt text. */
  name: string;
  /** Shown on the landing strip; the /integrations mural shows every entry. */
  home: boolean;
  /** Ink aspect ratio of the vendored file: width / height. */
  ratio: number;
}

/** Slug of the drawn "MCP" chip: a stack entry with no vendor logo. */
export const MCP_CHIP = "mcp";

export const STACK_LOGOS: readonly StackLogo[] = [
  { slug: "n8n", name: "n8n", home: true, ratio: 3.69 },
  { slug: "slack", name: "Slack", home: true, ratio: 1.001 },
  { slug: "discord", name: "Discord", home: true, ratio: 1.312 },
  { slug: "telegram", name: "Telegram", home: true, ratio: 1 },
  { slug: "nodedotjs", name: "Node.js", home: true, ratio: 3.353 },
  { slug: "python", name: "Python", home: true, ratio: 1 },
  { slug: "php", name: "PHP", home: true, ratio: 1.901 },
  { slug: "ruby", name: "Ruby", home: false, ratio: 1.003 },
  { slug: "go", name: "Go", home: true, ratio: 2.677 },
  { slug: "docker", name: "Docker", home: true, ratio: 4.397 },
  { slug: "curl", name: "cURL", home: true, ratio: 3.33 },
];

export const HOME_STACK_LOGOS: readonly StackLogo[] = STACK_LOGOS.filter((logo) => logo.home);

/**
 * Every mark, in band order. Both bands render real vendor logos only: the MCP
 * text chip belongs to the card that talks about MCP, never to a logo band.
 */
export const STACK_SLUGS: readonly string[] = STACK_LOGOS.map((logo) => logo.slug);

export const HOME_STACK_SLUGS: readonly string[] = HOME_STACK_LOGOS.map((logo) => logo.slug);

/** Resolves a card's slug to its logo; undefined means "render the MCP chip". */
export function stackLogo(slug: string): StackLogo | undefined {
  return STACK_LOGOS.find((logo) => logo.slug === slug);
}

export function logoSrc(slug: string): string {
  return `/logos/integrations/${slug}.svg`;
}
