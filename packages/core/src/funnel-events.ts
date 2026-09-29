import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";

/**
 * The product funnel, measured server-side.
 *
 * Umami (self-hosted) can only see what the visitor's browser tells it: a
 * pageview, a click. Everything that happens after the request — the account
 * being created, the address being verified, the first send, the payment —
 * happens where no tracker runs, and a visitor with a blocker or with JS off
 * would be invisible anyway. So these five events are emitted by the server
 * that owns them, to the same Umami instance, and the report joins them to
 * the channel the visit came in on.
 *
 * Nothing here identifies a person: the payload carries the channel, the
 * language and the plan, and the ledger row carries the event name. No
 * address, no IP, no account id — which is also why every event lands in
 * Umami as its own anonymous session, as the tracker's own events do.
 */
export const FUNNEL_EVENT_NAMES = [
  "signup_complete",
  "email_verified",
  "first_email_sent",
  "checkout_started",
  "payment_succeeded",
] as const;

export type FunnelEventName = (typeof FUNNEL_EVENT_NAMES)[number];

/** Where each event is attributed in Umami's page views; its dashboard reads the funnel by path. */
export const FUNNEL_EVENT_PATHS: Record<FunnelEventName, string> = {
  signup_complete: "/signup",
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

/** Where events go. Both null disables emission entirely (self-host default). */
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
export async function sendFunnelEvent(
  body: UmamiEventBody,
  target: FunnelEventTarget,
): Promise<boolean> {
  if (!target.endpoint || !target.websiteId) return false;
  const doFetch = target.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? FUNNEL_SEND_TIMEOUT_MS);
  try {
    const response = await doFetch(target.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-umami-website-id": target.websiteId,
        "user-agent": UMAMI_COLLECTOR_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      target.log?.(`funnel event ${body.payload.name}: collector answered ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    target.log?.(`funnel event ${body.payload.name}: collector unreachable (${String(error)})`);
    return false;
  } finally {
    clearTimeout(timer);
  }
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
    })
    .from(schema.signupAttribution)
    .where(eq(schema.signupAttribution.userId, userId))
    .limit(1);
  return {
    source: row?.source ?? null,
    medium: row?.medium ?? null,
    campaign: row?.campaign ?? null,
  };
}

/**
 * The channel and plan a team's events carry: the plan it is on, and the
 * channel its owner signed up on. Read only after an event has won its claim,
 * so the one-query-per-team cost lands on the event that is actually emitted
 * instead of on every accepted email.
 */
export async function teamFunnelProps(db: Db, teamId: string): Promise<FunnelEventProps> {
  const [team] = await db
    .select({ plan: schema.teams.plan })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId))
    .limit(1);
  const [owner] = await db
    .select({
      source: schema.signupAttribution.source,
      medium: schema.signupAttribution.medium,
      campaign: schema.signupAttribution.campaign,
    })
    .from(schema.teamMembers)
    .innerJoin(
      schema.signupAttribution,
      eq(schema.signupAttribution.userId, schema.teamMembers.userId),
    )
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.role, "owner")))
    .limit(1);
  return {
    plan: team?.plan ?? null,
    source: owner?.source ?? null,
    medium: owner?.medium ?? null,
    campaign: owner?.campaign ?? null,
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
  // Nothing to measure when the instance has no collector: skip the ledger
  // too, so a self-host never accumulates rows nobody reads.
  if (!target.endpoint || !target.websiteId) return false;
  const claim = await db
    .insert(schema.funnelEvents)
    .values({
      name: event.name,
      dedupeKey: event.dedupeKey,
      teamId: event.teamId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.funnelEvents.id });
  if (claim.length === 0) return false;

  const log = target.log ?? ((message: string) => console.warn(message));
  try {
    const resolved = event.resolve ? await event.resolve(db) : {};
    const props = { ...resolved, ...event.props };
    await db
      .update(schema.funnelEvents)
      .set({ props: funnelEventData(props) ?? {} })
      .where(eq(schema.funnelEvents.id, claim[0]?.id ?? ""));
    await sendFunnelEvent(
      buildFunnelEventPayload({
        name: event.name,
        websiteId: target.websiteId,
        hostname: target.hostname,
        props,
      }),
      target,
    );
    return true;
  } catch (error) {
    // The claim is already durable; a failure past it is a lost data point,
    // never a failed signup or a failed send.
    log(`funnel event ${event.name}: ${String(error)}`);
    return false;
  }
}
