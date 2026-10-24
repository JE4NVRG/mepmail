import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { isLoopbackUrl } from "./url.js";

/**
 * The product funnel, measured server-side.
 *
 * Umami (self-hosted) can only see what the visitor's browser tells it: a
 * pageview, a click. Everything that happens after the request — the account
 * being created, the address being verified, the first send, the payment —
 * happens where no tracker runs, and a visitor with a blocker or with JS off
 * would be invisible anyway. So these events are emitted by the server
 * that owns them, to the same Umami instance, and the report joins them to
 * the channel the visit came in on.
 *
 * Only the self-hosted collector receives an opaque team UUID; no person identifiers.
 * Workspace UUIDs are pseudonymous internal measurement, not anonymous identity.
 * No personal contact fields are emitted: the payload carries the channel, the
 * language and the plan, and the ledger row carries the event name. No
 * address, no IP, no account id — every server event lands in
 * Umami as its own anonymous session, as the tracker's own events do.
 */
export const FUNNEL_EVENT_NAMES = [
  "account_created",
  "signup_complete",
  "first_send",
  "subscription_paid",
  "email_verified",
  "first_email_sent",
  "checkout_started",
  "payment_succeeded",
] as const;

export type FunnelEventName = (typeof FUNNEL_EVENT_NAMES)[number];

/** Where each event is attributed in Umami's page views; its dashboard reads the funnel by path. */
export const FUNNEL_EVENT_PATHS: Record<FunnelEventName, string> = {
  account_created: "/signup",
  signup_complete: "/signup",
  first_send: "/emails",
  subscription_paid: "/settings/billing",
  email_verified: "/verify-email",
  first_email_sent: "/emails",
  checkout_started: "/settings/billing",
  payment_succeeded: "/settings/billing",
};

/** Cookie the proxy writes a visit's raw channel into, read back at sign-up. */
export const ATTRIBUTION_COOKIE = "mm_attr";

/** Long enough to cover a visitor who signs up weeks after clicking an ad. */
export const ATTRIBUTION_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Channel of a sign-up: what the landing visit could see, normalized. */
export interface SignupAttribution {
  /** utm_source, else the referrer's host, else "direct". Never empty. */
  source: string;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  /** Host of the external referrer, if the visit had one. */
  referrer: string | null;
  /** Pathname of the visit's first landing. */
  landingPath: string | null;
}

/** The raw shape the proxy stores: whatever the visit's URL and Referer had. */
export interface RawVisitAttribution {
  source?: unknown;
  medium?: unknown;
  campaign?: unknown;
  content?: unknown;
  term?: unknown;
  referrer?: unknown;
  path?: unknown;
}

/** The propagation ceiling for one field: long enough for a real campaign id, short enough to read. */
const FIELD_MAX = 200;

/**
 * One field as the ledger stores it: control characters dropped (a cookie is
 * echoed into a page), trimmed, bounded, empty read as absent.
 */
function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return trimmed === "" ? null : trimmed.slice(0, FIELD_MAX);
}

/**
 * Host of a referrer value, with no scheme and no path — a referrer's query
 * string can carry the visitor's own identifiers, and the channel only ever
 * needed the host. Values that are not a URL at all are kept as typed.
 */
function referrerHost(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return raw;
  }
}

/** A pathname, without query or fragment — "/" when the value is unusable. */
function landingPath(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  try {
    return new URL(raw, "http://landing.invalid").pathname.slice(0, FIELD_MAX);
  } catch {
    return null;
  }
}

/**
 * Normalizes one landing visit into attribution. The source falls back to the
 * referrer's host and then to "direct" — the row always names a channel, so a
 * campaign we failed to read is never silently counted as an organic one.
 */
export function attributionFromVisit(visit: RawVisitAttribution): SignupAttribution {
  const referrer = referrerHost(visit.referrer);
  return {
    source: clean(visit.source) ?? referrer ?? "direct",
    medium: clean(visit.medium),
    campaign: clean(visit.campaign),
    content: clean(visit.content),
    term: clean(visit.term),
    referrer,
    landingPath: landingPath(visit.path),
  };
}

/**
 * Attribution out of the cookie the proxy wrote, or null when the account
 * arrived without one (a direct sign-up, a cleared cookie, a social callback
 * from another tab). A value that is not the JSON object we wrote is treated
 * the same way: a broken cookie is not a channel.
 */
export function attributionFromCookieValue(
  value: string | undefined | null,
): SignupAttribution | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return attributionFromVisit(parsed as RawVisitAttribution);
  } catch {
    return null;
  }
}

/**
 * The User-Agent the emitter presents to the collector.
 *
 * Umami drops anything its bot filter recognizes, and a request with no
 * browser token at all (`node`, `curl`, or a bare `Umami-Server/1.0`) is
 * filtered as a bot: `POST /api/send` still answers `{"beep":"boop"}` and
 * nothing is stored (verified against Umami 3.4.0). The API only records
 * what a browser-shaped client sends, so the emitter sends the browser shape.
 */
export const UMAMI_COLLECTOR_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** How long the collector gets before the event is dropped; analytics never blocks a request. */
export const FUNNEL_SEND_TIMEOUT_MS = 2_500;

/** Optional self-hosted collector. Disabled collection never disables the local ledger. */
export interface FunnelEventTarget {
  endpoint: string | null;
  websiteId: string | null;
  /** Host the events are attributed to: this deployment's own dashboard host. */
  hostname: string;
  /** Injected in tests; global fetch otherwise. */
  fetch?: typeof fetch | undefined;
  /** Injected in tests. */
  timeoutMs?: number | undefined;
  log?: ((message: string) => void) | undefined;
}

/** Props Umami stores per event. Strings only: the report reads them as string values. */
export interface FunnelEventProps {
  source?: string | null | undefined;
  medium?: string | null | undefined;
  campaign?: string | null | undefined;
  locale?: string | null | undefined;
  plan?: string | null | undefined;
  [key: string]: string | null | undefined;
}

/** The body `POST /api/send` takes for one named event. */
export interface UmamiEventBody {
  type: "event";
  payload: {
    website: string;
    hostname: string;
    url: string;
    name: string;
    data?: Record<string, string>;
  };
}

/**
 * Props as the wire takes them: absent fields dropped rather than sent empty,
 * so the report distinguishes "no campaign" from "campaign not recorded".
 */
export function funnelEventData(props: FunnelEventProps): Record<string, string> | undefined {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    const cleaned = clean(value);
    if (cleaned) data[key] = cleaned;
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

/** One funnel event as Umami's collection endpoint expects it. */
export function buildFunnelEventPayload(params: {
  name: FunnelEventName;
  websiteId: string;
  hostname: string;
  url?: string;
  props?: FunnelEventProps;
}): UmamiEventBody {
  const data = params.props ? funnelEventData(params.props) : undefined;
  return {
    type: "event",
    payload: {
      website: params.websiteId,
      hostname: params.hostname,
      url: params.url ?? FUNNEL_EVENT_PATHS[params.name],
      name: params.name,
      ...(data ? { data } : {}),
    },
  };
}

/**
 * Sends one event. Best-effort by contract: analytics is never allowed to
 * fail the request that produced the event, so a refusal, a timeout or an
 * offline collector is logged and swallowed.
 */
/** Log only operational facts: never SQL errors, tokens or request bodies. */
function funnelLog(target: FunnelEventTarget, message: string): void {
  try {
    (target.log ?? console.warn)(message);
  } catch {
    // An observer must not become a domain failure.
  }
}

export async function sendFunnelEvent(
  body: UmamiEventBody,
  target: FunnelEventTarget,
): Promise<boolean> {
  if (!target.endpoint || !target.websiteId) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Race also bounds injected transports which do not honor AbortSignal.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("collector timeout"));
      }, target.timeoutMs ?? FUNNEL_SEND_TIMEOUT_MS);
    });
    const response = await Promise.race([
      (target.fetch ?? fetch)(target.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-umami-website-id": target.websiteId,
          "user-agent": UMAMI_COLLECTOR_USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) {
      funnelLog(target, `funnel event ${body.payload.name}: collector answered ${response.status}`);
      return false;
    }
    return true;
  } catch {
    funnelLog(target, `funnel event ${body.payload.name}: collector unreachable or timed out`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Five campaign dimensions, with old report aliases retained. */
function attributionProps(row: Partial<SignupAttribution> | undefined): FunnelEventProps {
  return {
    source: row?.source ?? null,
    medium: row?.medium ?? null,
    campaign: row?.campaign ?? null,
    content: row?.content ?? null,
    term: row?.term ?? null,
    utm_source: row?.source ?? null,
    utm_medium: row?.medium ?? null,
    utm_campaign: row?.campaign ?? null,
    utm_content: row?.content ?? null,
    utm_term: row?.term ?? null,
  };
}

/**
 * The channel props of one account: what the visit cookie said at sign-up, if
 * a row exists. Used for the events that happen before the account has a team
 * (the sign-up itself, the address verification).
 */
export async function userFunnelProps(db: Db, userId: string): Promise<FunnelEventProps> {
  const [row] = await db
    .select({
      source: schema.signupAttribution.source,
      medium: schema.signupAttribution.medium,
      campaign: schema.signupAttribution.campaign,
      content: schema.signupAttribution.content,
      term: schema.signupAttribution.term,
    })
    .from(schema.signupAttribution)
    .where(eq(schema.signupAttribution.userId, userId))
    .limit(1);
  // Only the metadata projection is read: never select user/email, risk signals or IP.
  const [account] = await db
    .select({ props: schema.funnelEvents.props })
    .from(schema.funnelEvents)
    .where(
      and(
        eq(schema.funnelEvents.dedupeKey, `account:${userId}`),
        eq(schema.funnelEvents.name, "account_created"),
      ),
    )
    .limit(1);
  const [risk] = await db
    .select({ level: schema.userSignupRisk.level })
    .from(schema.userSignupRisk)
    .where(eq(schema.userSignupRisk.userId, userId))
    .limit(1);
  const requestedProduct = clean(account?.props?.requested_product);
  const requestedPlan = clean(account?.props?.requested_plan);
  const product =
    requestedProduct === "send" || requestedProduct === "mail" ? requestedProduct : null;
  return {
    ...attributionProps(row ?? account?.props ?? undefined),
    risk_level: risk?.level ?? "unknown",
    bot_status: "unknown",
    is_suspected: risk ? (risk.level === "good" ? "false" : "true") : "unknown",
    is_internal: "unknown",
    is_qa: "unknown",
    requested_product: product,
    requested_plan: requestedPlan,
    product,
  };
}

/** Snapshot only existing state. Absence of risk evidence is not human confirmation. */
export async function teamFunnelProps(db: Db, teamId: string): Promise<FunnelEventProps> {
  const [team] = await db
    .select({
      plan: schema.teams.plan,
      suspendedAt: schema.teams.suspendedAt,
      sendReviewAt: schema.teams.sendReviewAt,
      sendReviewClearedAt: schema.teams.sendReviewClearedAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId))
    .limit(1);
  if (!team) throw new Error("funnel team missing");
  const [owner] = await db
    .select({ userId: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.role, "owner")))
    .limit(1);
  const [risk] = await db
    .select({ level: schema.teamSignupRisk.level })
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, teamId))
    .limit(1);
  const held =
    !!team.sendReviewAt &&
    (!team.sendReviewClearedAt || team.sendReviewAt > team.sendReviewClearedAt);
  const level = risk?.level ?? "unknown";
  const attribution = owner ? await userFunnelProps(db, owner.userId) : {};
  return {
    ...attribution,
    team_id: teamId,
    product: attribution.product ?? "send",
    plan: team.plan,
    risk_level: level,
    bot_status: "unknown", // Neither suspension nor a signup score proves automation.
    is_suspected:
      team.suspendedAt || held || level === "hold" || level === "sandbox"
        ? "true"
        : level === "good"
          ? "false"
          : "unknown",
    is_internal: team.plan === "system" ? "true" : "unknown",
    is_qa: "unknown", // Baseline has no authoritative QA-team marker; never infer from names/email.
    is_suspended: team.suspendedAt ? "true" : "false",
    is_send_held: held ? "true" : "false",
  };
}

/** One event to emit; `resolve` runs only for the call that wins the claim. */
export interface FunnelEventRequest {
  name: FunnelEventName;
  /**
   * Unique per event instance: the ledger's unique key. A repeat of the same
   * key is a no-op, which is what makes a Stripe redelivery or a second
   * "first email" harmless.
   */
  dedupeKey: string;
  teamId?: string | null;
  /** Props known to the caller (no lookup needed). */
  props?: FunnelEventProps;
  /** Props that need a read (channel, plan); skipped when the claim is lost. */
  resolve?: ((db: Db) => Promise<FunnelEventProps>) | undefined;
}

/**
 * Emits one funnel event, at most once per dedupe key.
 *
 * The claim is an insert into the ledger — the insert is the lock, so two
 * concurrent callers converge on one emission. Losing the claim is the
 * common case (every email after the first, every Stripe redelivery) and
 * costs one conflict-checked insert, no reads and no HTTP.
 */
export async function emitFunnelEvent(
  db: Db,
  target: FunnelEventTarget,
  event: FunnelEventRequest,
): Promise<boolean> {
  // Canonical milestones are team-scoped. Account creation has its own name/key.
  if (
    ["signup_complete", "first_send", "subscription_paid"].includes(event.name) &&
    !event.teamId
  ) {
    funnelLog(target, `funnel event ${event.name}: rejected missing teamId`);
    return false;
  }
  // Preview and loopback contexts share real data in staging: no telemetry claim at all.
  // An unconfigured collector on a public production host is different and keeps its ledger.
  if (
    process.env.MEPMAIL_LOCAL_PREVIEW === "1" ||
    isLoopbackUrl(process.env.APP_BASE_URL) ||
    isLoopbackUrl(`http://${target.hostname}`)
  )
    return false;
  const configured = !!target.endpoint && !!target.websiteId;
  let claimId: string | undefined;
  try {
    // The unique ledger constraint is the concurrency lock, even with collection off.
    const claim = await db
      .insert(schema.funnelEvents)
      .values({
        name: event.name,
        dedupeKey: event.dedupeKey,
        teamId: event.teamId ?? null,
        props: { measurement_version: "2", collector_status: "pending" },
      })
      .onConflictDoNothing()
      .returning({ id: schema.funnelEvents.id });
    claimId = claim[0]?.id;
    if (!claimId) return false;
    const automatic: FunnelEventProps = event.teamId
      ? await teamFunnelProps(db, event.teamId)
      : {
          risk_level: "unknown",
          bot_status: "unknown",
          is_suspected: "unknown",
          is_internal: "unknown",
          is_qa: "unknown",
        };
    const resolved = event.resolve ? await event.resolve(db) : {};
    const props: FunnelEventProps = {
      ...automatic,
      ...resolved,
      ...event.props,
      measurement_version: "2",
    };
    // Identity and state snapshots come only from the selected real team, not caller overrides.
    for (const key of [
      "team_id",
      "risk_level",
      "bot_status",
      "is_suspected",
      "is_internal",
      "is_qa",
      "is_suspended",
      "is_send_held",
    ]) {
      delete props[key];
      const snapshot = event.teamId
        ? automatic[key]
        : key === "team_id"
          ? undefined
          : (resolved[key] ?? automatic[key]);
      if (snapshot !== undefined) props[key] = snapshot;
    }
    const data = funnelEventData(props) ?? {};
    await db
      .update(schema.funnelEvents)
      .set({ props: { ...data, collector_status: configured ? "pending" : "disabled" } })
      .where(eq(schema.funnelEvents.id, claimId));
    if (!configured) return false;
    const sent = await sendFunnelEvent(
      buildFunnelEventPayload({
        name: event.name,
        websiteId: target.websiteId ?? "",
        hostname: target.hostname,
        props,
      }),
      target,
    );
    await db
      .update(schema.funnelEvents)
      .set({ props: { ...data, collector_status: sent ? "http_accepted" : "failed" } })
      .where(eq(schema.funnelEvents.id, claimId));
    // HTTP acceptance is not proof Umami stored the event. No automatic replay.
    return sent;
  } catch {
    if (claimId) {
      try {
        await db
          .update(schema.funnelEvents)
          .set({
            props: { measurement_version: "2", collector_status: "ledger_or_enrichment_failed" },
          })
          .where(eq(schema.funnelEvents.id, claimId));
      } catch {
        // A pending row remains explicit evidence of an incomplete telemetry attempt.
      }
    }
    // Claim/update errors also stay inside this boundary; domain actions never fail.
    funnelLog(
      target,
      `funnel event ${event.name}: ledger/enrichment failed; collection not confirmed`,
    );
    return false;
  }
}
