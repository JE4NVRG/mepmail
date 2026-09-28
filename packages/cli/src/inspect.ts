import { type KeySource, TARGET_KEY_ENV, TARGET_URL_ENV } from "./config.js";
import type { Context } from "./context.js";
import { ApiError, AuthError, cursorGuard, type Http } from "./http.js";

/**
 * The read-only half of the MepMail API, for the day-to-day commands
 * (`doctor`, `emails`). Wire shapes stay snake_case on purpose: `--json`
 * mirrors the API field for field, so a script can read either side the same
 * way. Nothing here writes, and nothing here prints a key.
 */

/** GET /health — public; the CLI asks for it before trusting the key. */
export interface HealthWire {
  status: string;
  revision?: string | null | undefined;
}

/** GET /usage (full-access keys): only the fields `doctor` shows. */
export interface UsageWire {
  cloud: boolean;
  plan: string | null;
  limits: {
    emails_per_day: number | null;
    domains: number | null;
  };
  today: { emails_sent: number };
  team?: { id: string; name: string } | undefined;
  app_url: string | null;
}

export interface DomainWire {
  id: string;
  name: string;
  status: string;
}

export interface EmailSummaryWire {
  id: string;
  from: string;
  to: string[];
  /** Present on the API's rows; the CLI prints only `to`. */
  cc?: string[] | null | undefined;
  bcc?: string[] | null | undefined;
  reply_to?: string | null | undefined;
  subject: string;
  created_at: string;
  scheduled_at: string | null;
  /** `queued`, `sent`, `delivered`, `bounced`, `complained`… — `queued_quota` is internal and never sent. */
  last_event: string;
}

export interface EmailWire extends EmailSummaryWire {
  object: "email";
  html: string | null;
  text: string | null;
  message_id?: string | undefined;
  score: number | null;
}

/** GET /emails: one keyset page, oldest first (the API's own order). */
export interface EmailPageWire {
  object: "list";
  data: EmailSummaryWire[];
  has_more: boolean;
}

/** GET /deliverability: the guardrail that can pause sending (`sending_paused`). */
export interface DeliverabilityWire {
  guardrail_status: "ok" | "warning" | "paused";
  score: number | null;
  hard_bounce_rate: number | null;
  complaint_rate: number | null;
  window_days?: number | undefined;
}

/** Exit code for a request that could not be completed: 0 ok, 1 usage, 2 network/API. */
export const API_FAILURE_EXIT = 2;

/** The API's page ceiling for the cursor walks. */
const PAGE = 100;

export function createInspector(http: Http) {
  return {
    health: async (): Promise<HealthWire> => (await http.get<HealthWire>("/health")).body,
    usage: async (): Promise<UsageWire> => (await http.get<UsageWire>("/usage")).body,
    deliverability: async (): Promise<DeliverabilityWire> =>
      (await http.get<DeliverabilityWire>("/deliverability")).body,
    /** Every domain of the team, verified or not: the cursor is walked to the end. */
    domains: async (): Promise<DomainWire[]> => {
      const rows: DomainWire[] = [];
      const guard = cursorGuard("/domains");
      let after: string | undefined;
      for (;;) {
        const { body } = await http.get<{ data: DomainWire[]; has_more: boolean }>("/domains", {
          query: { limit: PAGE, after },
        });
        guard(body.data, after);
        rows.push(...body.data);
        const last = body.data.at(-1);
        if (!body.has_more || last === undefined) return rows;
        after = last.id;
      }
    },
    /** One page; `after` is the id of the last email printed. */
    listEmails: async ({
      limit,
      after,
    }: {
      limit: number;
      after?: string | undefined;
    }): Promise<EmailPageWire> =>
      (await http.get<EmailPageWire>("/emails", { query: { limit, after } })).body,
    getEmail: async (id: string): Promise<EmailWire> =>
      (await http.get<EmailWire>(`/emails/${encodeURIComponent(id)}`)).body,
  };
}

export type Inspector = ReturnType<typeof createInspector>;

/**
 * What a 404 means for the request that failed: `route` when the instance has
 * no such endpoint at all (an older build, or a `--to-url` pointing at
 * something else), `resource` when the route exists and the item behind it does
 * not. The API answers both with the same status, so only the caller knows
 * which request it made.
 */
export type NotFoundKind = "route" | "resource";

/**
 * One actionable line for a failed request. The API's own message comes first
 * (it names the exact cause), this names what to do about it.
 */
export function apiFailureHint(
  error: unknown,
  baseUrl: string,
  notFound: NotFoundKind = "route",
): string {
  if (error instanceof AuthError) {
    return error.status === 403
      ? `${TARGET_KEY_ENV} was accepted but is sending-only (403); the reads here need a full-access key (ms_…).`
      : `MepMail rejected the key (401). Check ${TARGET_KEY_ENV}: a full-access key (ms_…) of this team, not a Resend key.`;
  }
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return `no answer from ${baseUrl}: check --to-url / ${TARGET_URL_ENV}, DNS, and that the instance is up (docker compose ps).`;
    }
    if (error.status === 404) {
      return notFound === "resource"
        ? "no email with this id in this team: ids are per-team, and `mepmail emails list` prints the ones this key can read."
        : `${baseUrl} has no such endpoint: either it is not the API URL of this team, or the instance predates this CLI version.`;
    }
    if (error.status === 429) {
      return "the key is rate limited right now; wait a few seconds and retry.";
    }
    if (error.status === 400 || error.status === 422) {
      return "MepMail refused the request as invalid: retrying cannot fix it — correct the arguments above (`mepmail --help`).";
    }
    return `MepMail answered ${error.status}; retry in a moment, and check the instance logs if it keeps failing.`;
  }
  return "unexpected failure; run again with --verbose to log every request.";
}

/** Reports a failed request on stderr (never on stdout, which `--json` owns) and its exit code. */
export function reportFailure(
  ctx: Context,
  error: unknown,
  baseUrl: string,
  notFound: NotFoundKind = "route",
): number {
  ctx.log.error(error instanceof Error ? error.message : String(error));
  ctx.log.error(apiFailureHint(error, baseUrl, notFound));
  return API_FAILURE_EXIT;
}

/** Where the key comes from; the key itself is never printed, here or anywhere. */
export function keySourceLabel(source: KeySource): string {
  switch (source) {
    case "env":
      return `${TARGET_KEY_ENV} (env)`;
    case "flag":
      return "--to-key (visible in process lists)";
    case "stdin":
      return "--to-key-stdin";
    case "prompt":
      return "terminal prompt";
  }
}

/** What a dry run can honestly say about the key: where it comes from, never its value. */
export function keyDryRunLabel(ctx: Context): string {
  const { source, value } = ctx.config.toKey;
  const where = keySourceLabel(source);
  if (value !== null) return `${where} · set`;
  return source === "stdin" ? `${where} · set (read when the command runs)` : `${where} · missing`;
}

/** The URL both day-to-day commands report, so a dry run and a real run agree on the host. */
export const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};
