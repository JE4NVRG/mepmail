import { appHostname, umamiFunnel } from "@millionsend/config";
import {
  attributionFromVisit,
  emitFunnelEvent,
  type FunnelEventRequest,
  type FunnelEventTarget,
  type SignupAttribution,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { ATTRIBUTION_COOKIE, cookieValue, parseAttributionCookie } from "@/lib/attribution";

/**
 * Where the web app sends its funnel events, and what they carry.
 *
 * Thin on purpose: the target comes from the environment (umamiFunnel), the
 * rules live in @millionsend/core. Every entry point here is best-effort, so a
 * missing collector, an unreachable Umami or a table a migration has not
 * created yet can never fail a sign-up, a verification or a payment.
 */
export function funnelTarget(): FunnelEventTarget {
  const { endpoint, websiteId } = umamiFunnel();
  return { endpoint, websiteId, hostname: appHostname() };
}

/** Emits one funnel event, swallowing anything that a measurement may not break. */
export async function emitFunnel(db: Db, event: FunnelEventRequest): Promise<boolean> {
  try {
    return await emitFunnelEvent(db, funnelTarget(), event);
  } catch (error) {
    console.error(`funnel event ${event.name} skipped`, error);
    return false;
  }
}

/**
 * Persists the channel a sign-up came in on, from the cookie the proxy left on
 * the visitor's first landing. Returns the normalized attribution so the
 * sign-up event carries the same channel the row does, or null when the
 * account arrived with no cookie — a direct sign-up, a cleared browser, a
 * social callback whose cookie never reached us. A missing row is honest: the
 * report shows it as "(nao medido)", never as organic traffic it might not
 * have been.
 *
 * Called with the request headers the auth hook holds, because those are the
 * only place the cookie is visible: the row is written from the same request
 * that creates the user.
 */
export async function recordSignupAttribution(
  db: Db,
  userId: string,
  cookieHeader: string | null,
): Promise<SignupAttribution | null> {
  const visit = parseAttributionCookie(cookieValue(cookieHeader, ATTRIBUTION_COOKIE) ?? undefined);
  if (!visit) return null;
  const attribution = attributionFromVisit(visit);
  try {
    await db
      .insert(schema.signupAttribution)
      .values({ userId, ...attribution })
      .onConflictDoNothing();
    return attribution;
  } catch (error) {
    // A missing migration, an account deleted while its first request was in
    // flight: the account itself is already created, so this is logged and
    // dropped rather than failing the sign-up.
    console.error("signup attribution not recorded", error);
    return null;
  }
}

/** Props a sign-up's events carry, built from what the cookie said. */
export function attributionProps(
  attribution: SignupAttribution | null,
  locale: string,
): Record<string, string | null> {
  return {
    source: attribution?.source ?? null,
    medium: attribution?.medium ?? null,
    campaign: attribution?.campaign ?? null,
    locale,
  };
}
