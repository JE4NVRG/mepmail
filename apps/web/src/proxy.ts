import { env } from "@millionsend/config";
import { type NextRequest, NextResponse } from "next/server";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  attributionCookieValue,
  shouldReplaceAttribution,
} from "@/lib/attribution";

/** Paths the hosted unsubscribe flow needs; nothing else answers on its host. */
const UNSUBSCRIBE_HOST_PATHS = ["/unsubscribe/", "/logo/", "/_next/", "/favicon.ico"];

/**
 * The hosted unsubscribe pages may live on their own host (UNSUBSCRIBE_BASE_URL)
 * so recipients and link scanners never touch the dashboard's origin. That
 * host then answers the unsubscribe flow and its assets only: the dashboard,
 * the auth pages and everything else 404 there. The dashboard's own host
 * keeps serving the flow too — links in mail already sent point at it.
 *
 * The hook also records the channel each visit arrived on, into a
 * first-party cookie the server reads back at sign-up (captureAttribution).
 */
export function proxy(request: NextRequest): NextResponse {
  const response = routeByHost(request);
  if (response.status === 404) return response;
  return captureAttribution(request, response);
}

function routeByHost(request: NextRequest): NextResponse {
  const requestHeaders = new Headers(request.headers);
  // Overwrite caller input: only this request URL determines the return target.
  requestHeaders.set("x-mepmail-next", request.nextUrl.pathname + request.nextUrl.search);
  const next = () => NextResponse.next({ request: { headers: requestHeaders } });
  const own = env.UNSUBSCRIBE_BASE_URL;
  if (!own) return next();
  const host = request.headers.get("host")?.toLowerCase();
  if (host !== new URL(own).host.toLowerCase()) return next();
  const { pathname } = request.nextUrl;
  if (UNSUBSCRIBE_HOST_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
    return next();
  }
  return new NextResponse(null, { status: 404 });
}

/**
 * Records the channel a visit arrived on, so the account it later creates can
 * be attributed.
 *
 * The capture sits in front of every page because it has to survive the whole
 * visit: a visitor lands on /?utm_source=linkedin, reads for two minutes, then
 * clicks through to /pricing and finally to /signup. Only the first request
 * carries the campaign parameters, and only the browser sends a Referer, so
 * whoever sees that request has to write it down — this hook does.
 *
 * The cookie carries no identifier, no address and no user agent: the campaign
 * fields, the referrer's origin and the landing path, which is the same
 * information the analytics snippet already sends to Umami. Nothing is written
 * when a visit names no channel, so a plain visit leaves no cookie behind. The
 * raw visit is stored as seen; the channel rules belong to the server that
 * writes the row (packages/core funnel-events attributionFromVisit).
 */
function captureAttribution(request: NextRequest, response: NextResponse): NextResponse {
  const value = attributionCookieValue(request.nextUrl, request.headers.get("referer"));
  if (!value) return response;
  if (!shouldReplaceAttribution(request.cookies.get(ATTRIBUTION_COOKIE)?.value, value)) {
    return response;
  }
  response.cookies.set({
    name: ATTRIBUTION_COOKIE,
    value,
    path: "/",
    maxAge: ATTRIBUTION_MAX_AGE_SECONDS,
    sameSite: "lax",
    httpOnly: false,
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}
