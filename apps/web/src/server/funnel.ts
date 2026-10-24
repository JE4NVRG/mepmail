import { appHostname, umamiFunnel } from "@millionsend/config";
import {
  attributionFromVisit,
  emitFunnelEvent,
  type FunnelEventRequest,
  type FunnelEventTarget,
  isLoopbackUrl,
  type SignupAttribution,
} from "@millionsend/core";
import { PLAN_RUNG_KEYS } from "@millionsend/core/plans";
import { type Db, schema } from "@millionsend/db";
import { and, asc, eq } from "drizzle-orm";
import { ATTRIBUTION_COOKIE, cookieValue, parseAttributionCookie } from "@/lib/attribution";
import { MAILBOX_PLAN_ORDER } from "@/lib/mailbox-plans";

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
    const hostname = appHostname().toLowerCase();
    if (process.env.MEPMAIL_LOCAL_PREVIEW === "1" || isLoopbackUrl(`http://${hostname}`))
      return false;
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
    content: attribution?.content ?? null,
    term: attribution?.term ?? null,
    utm_source: attribution?.source ?? null,
    utm_medium: attribution?.medium ?? null,
    utm_campaign: attribution?.campaign ?? null,
    utm_content: attribution?.content ?? null,
    utm_term: attribution?.term ?? null,
    locale,
  };
}

/** Untrusted navigation intent is metadata only, never billing or capability. */
export function requestedFunnelIntent(cookieHeader: string | null): Record<string, string> {
  try {
    const raw = cookieValue(cookieHeader, "mm_funnel_intent");
    if (!raw || raw.length > 1024) return {};
    const v: unknown = JSON.parse(decodeURIComponent(raw));
    if (!v || typeof v !== "object") return {};
    const { version, product, plan, selection_state } = v as Record<string, unknown>;
    if (version !== 1 || (product !== "send" && product !== "mail")) return {};
    if (plan === "choose" || (plan === undefined && selection_state === "unselected"))
      return { requested_product: product, requested_selection_state: "unselected" };
    if (plan === undefined && selection_state === "unknown")
      return { requested_product: product, requested_selection_state: "unknown" };
    if (typeof plan !== "string") return {};
    const catalog: readonly string[] = product === "send" ? PLAN_RUNG_KEYS : MAILBOX_PLAN_ORDER;
    return catalog.includes(plan) || plan === "free"
      ? { requested_product: product, requested_plan: plan }
      : {};
  } catch {
    return {};
  }
}

/** Run only after the actual team/membership/risk transaction committed. */
export async function trackTeamSignup(db: Db, userId: string, teamId: string): Promise<void> {
  try {
    const [first] = await db
      .select({ id: schema.teams.id })
      .from(schema.teamMembers)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
      .where(and(eq(schema.teamMembers.userId, userId), eq(schema.teamMembers.role, "owner")))
      .orderBy(asc(schema.teams.createdAt), asc(schema.teams.id))
      .limit(1);
    if (first?.id !== teamId) return;
    await emitFunnel(db, {
      name: "signup_complete",
      dedupeKey: `signup:${userId}`,
      teamId,
      props: { measurement_version: "2" },
    });
  } catch (error) {
    console.error("team signup funnel skipped", error);
  }
}
