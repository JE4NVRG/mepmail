import { ATTRIBUTION_COOKIE, cookieValue, parseAttributionCookie } from "@/lib/attribution";

/**
 * The public site's own funnel events, as pure rules.
 *
 * The components that fire them (components/public-events.tsx) need the browser
 * — a cookie, a query string, a pathname — but the decisions themselves are
 * data-in/data-out, so they live here and are asserted without a DOM. The names
 * are the launch plan's (je4ndev-gtm launch-ops.md §3.2): the arrival events
 * name the channel a campaign link carries, and every one of them is Umami's
 * `window.umami.track("<name>", {...})` shape, sent through lib/analytics.
 */

/** One event to fire: its Umami name and the props it carries. */
export interface PublicFunnelEvent {
  name: string;
  props: Record<string, string>;
}

/**
 * The arrival event a landing URL names, or null for a visit with no campaign
 * link. The three channels the launch plan tracks are told apart exactly as its
 * UTM table writes them: Show HN sends `utm_medium=show_hn`, Product Hunt
 * `utm_medium=launch` (its generic medium, so the check is on the value), and
 * Reddit is named by `utm_source=reddit` because both subs share `medium=post`.
 * A URL that matches none of them — a direct visit, an internal link — fires
 * nothing, so the report never counts a non-campaign arrival as a channel one.
 */
export function arrivalEvent(search: string): PublicFunnelEvent | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const medium = params.get("utm_medium");
  const source = params.get("utm_source");
  let name: string | null = null;
  if (medium === "show_hn") name = "hn_arrival";
  else if (medium === "launch") name = "ph_arrival";
  else if (source === "reddit") name = "reddit_arrival";
  if (!name) return null;
  const content = params.get("utm_content");
  return { name, props: content ? { utm_content: content } : {} };
}

/**
 * The utm_source of the visit, out of the attribution cookie the proxy wrote.
 *
 * Read straight from `document.cookie` by the CTA that carries it into the
 * sign-up: the cookie is first-party and not httpOnly, and it is the same
 * value the server reads to attribute the created account, so `signup_start`
 * and `signup_complete` agree on the channel. A visit with no cookie (direct,
 * cleared) has no source, and the caller then omits the prop rather than
 * claiming "direct" for a channel that was never measured.
 */
export function visitSource(cookieHeader: string | undefined | null): string | undefined {
  const visit = parseAttributionCookie(cookieValue(cookieHeader ?? null, ATTRIBUTION_COOKIE));
  return visit?.source ?? undefined;
}
