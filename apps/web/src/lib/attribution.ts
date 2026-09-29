/**
 * The visit's channel, as recorded in the browser and read back at sign-up.
 *
 * Split out of the Next proxy (src/proxy.ts) because both sides of the
 * handshake need it and neither should import the other: the proxy writes the
 * cookie on the way in, the server reads it when an account is created. The
 * value is deliberately raw — the campaign parameters exactly as typed, the
 * referrer's origin, the landing path — and the channel rules (falling back to
 * the referrer's host, then to "direct") live with the row that is written, in
 * packages/core funnel-events.
 *
 * The cookie is JSON encoded by NextResponse.cookies at the HTTP boundary.
 * The helper supplies raw JSON, avoiding a second layer of URI encoding.
 */

/** Cookie the proxy writes and the sign-up hook reads. */
export const ATTRIBUTION_COOKIE = "mm_attr";

/** Same lifetime on both sides; a visitor who signs up weeks later still attributes. */
export const ATTRIBUTION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/** Only what the funnel reads: the campaign fields, plus referrer and landing path. */
const CAMPAIGN_PARAMS = [
  ["source", "utm_source"],
  ["medium", "utm_medium"],
  ["campaign", "utm_campaign"],
  ["content", "utm_content"],
  ["term", "utm_term"],
] as const;

/** The raw visit as the cookie stores it; keys match RawVisitAttribution in @millionsend/core. */
export interface RawVisitCookie {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  referrer?: string;
  path?: string;
}

/** One field as the cookie stores it: trimmed, control characters dropped, bounded. */
function bounded(value: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return trimmed === "" ? null : trimmed.slice(0, 200);
}

/** The referrer's origin when it is a different site, else null. */
function externalOrigin(referer: string | null, ownOrigin: string): string | null {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return url.origin === ownOrigin ? null : url.origin;
  } catch {
    return null;
  }
}

/**
 * The cookie value for one request, or null when there is nothing to record.
 *
 * Cross-origin referrers only: a referrer on our own host is our own page, and
 * recording it would report the dashboard as a traffic source. A visit is only
 * worth writing when it names a channel — a utm_source or an external
 * referrer — which is also the rule the server applies, so a cookie holding
 * only utm_campaign never becomes a sign-up's "source".
 */
export function attributionCookieValue(url: URL, referer: string | null): string | null {
  const visit: RawVisitCookie = {};
  for (const [key, param] of CAMPAIGN_PARAMS) {
    const value = bounded(url.searchParams.get(param) ?? "");
    if (value) visit[key] = value;
  }
  const origin = externalOrigin(referer, url.origin);
  if (origin) visit.referrer = origin;
  if (!visit.source && !visit.referrer) return null;
  visit.path = url.pathname.slice(0, 200);
  return JSON.stringify(visit);
}

/** The visit out of a cookie the proxy wrote; null when it is absent or malformed. */
export function parseAttributionCookie(value: string | undefined | null): RawVisitCookie | null {
  if (!value) return null;
  try {
    // Aceita JSON do NextRequest e até duas camadas do cookie legado.
    // Não decodifica percentuais literais dentro de um objeto já decodificado.
    let decoded = value;
    for (let layer = 0; layer < 2 && decoded.startsWith("%"); layer++) {
      decoded = decodeURIComponent(decoded);
    }
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as RawVisitCookie;
  } catch {
    return null;
  }
}

/** One cookie's value out of a request's Cookie header. */
export function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** Whether a cookie value carries an explicit campaign (a utm_source). */
export function cookieHasCampaign(value: string | undefined | null): boolean {
  const visit = parseAttributionCookie(value);
  return typeof visit?.source === "string" && visit.source !== "";
}

/**
 * Whether an incoming visit replaces the cookie already on file.
 *
 * First touch wins, because the click that brought the visitor is what earned
 * the sign-up: a later visit with no campaign — a bookmark, an internal link,
 * a direct return — must not overwrite it with "direct". An explicit new
 * campaign does replace it: following a different ad genuinely changes where
 * this visitor came from.
 */
export function shouldReplaceAttribution(existing: string | undefined, incoming: string): boolean {
  return !cookieHasCampaign(existing) || cookieHasCampaign(incoming);
}
