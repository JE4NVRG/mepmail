import { ADVERTISING_PUBLIC_PATHS } from "./advertising-consent.js";

export type MetaConversionMode = "production" | "test";

export interface MetaConversionConfig {
  enabled: boolean;
  datasetId?: string;
  accessToken?: string;
  graphVersion?: string;
  mode: MetaConversionMode;
  testEventCode?: string;
}

export type MetaConsent = "granted" | "denied" | "withdrawn";

export interface MetaConversionMatching {
  fbp?: string;
  fbc?: string;
}

interface MetaConversionBase {
  /** Persisted random UUID and original Unix seconds; retries must reuse both. */
  eventId: string;
  eventTime: number;
  eventSourceUrl: string;
  /** The caller must re-read current consent before claiming a persisted event. */
  consent: MetaConsent;
  matching?: MetaConversionMatching;
}

export type MetaConversionEvent = MetaConversionBase &
  (
    | { eventName: "Purchase"; amountPaidMinor: number; currency: string }
    | { eventName: "InitiateCheckout"; amountPaidMinor?: number; currency?: string }
    /** A finished sign-up: no value, no account or contact data, only the browser ids. */
    | { eventName: "CompleteRegistration"; amountPaidMinor?: undefined; currency?: undefined }
  );

export interface MetaServerEvent {
  event_name: "InitiateCheckout" | "Purchase" | "CompleteRegistration";
  event_id: string;
  event_time: number;
  action_source: "website";
  event_source_url: string;
  user_data: MetaConversionMatching;
  custom_data?: { value: number; currency: "USD" };
}

export type MetaConversionRejection =
  | "consent_denied"
  | "consent_withdrawn"
  | "consent_required"
  | "invalid_event"
  | "invalid_event_id"
  | "invalid_event_time"
  | "invalid_source_url"
  | "matching_absent"
  | "invalid_matching"
  | "invalid_amount"
  | "invalid_currency";

export type MetaConversionBuildResult =
  | { status: "built"; payload: MetaServerEvent }
  | { status: "rejected"; reason: MetaConversionRejection };

export type MetaConversionOutcome =
  | { status: "accepted"; mode: MetaConversionMode }
  | {
      status: "retry";
      reason: "rate_limited" | "server_error" | "network" | "timeout" | "invalid_response";
    }
  | { status: "dead"; reason: MetaConversionRejection | "client_error" }
  | { status: "disabled"; reason: "feature_disabled" | "configuration" };

export interface MetaFetchRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: "error";
}

export type MetaFetch = (
  url: string,
  request: MetaFetchRequest,
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface MetaConversionTransport {
  fetch: MetaFetch;
  timeoutMs?: number;
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fbpFormat = /^fb\.\d{1,2}\.[1-9]\d{12}\.\d{1,20}$/;
const fbcFormat = /^fb\.\d{1,2}\.[1-9]\d{12}\.[A-Za-z0-9_-]{1,500}$/;
const publicSources = new Set([
  "https://mepmail.dev",
  ...ADVERTISING_PUBLIC_PATHS.map((path) => `https://mepmail.dev${path}`),
]);

/** No default API version, credentials, automatic request enrichment, or browser Pixel. */
export function metaConversionConfigured(config: MetaConversionConfig): boolean {
  return (
    config != null &&
    config.enabled === true &&
    typeof config.datasetId === "string" &&
    /^[1-9]\d{0,29}$/.test(config.datasetId) &&
    typeof config.accessToken === "string" &&
    /^[\x21-\x7e]{1,4096}$/.test(config.accessToken) &&
    typeof config.graphVersion === "string" &&
    /^v[1-9]\d{0,2}\.\d{1,2}$/.test(config.graphVersion) &&
    ((config.mode === "production" && config.testEventCode === undefined) ||
      (config.mode === "test" &&
        typeof config.testEventCode === "string" &&
        /^[A-Za-z0-9_-]{1,100}$/.test(config.testEventCode)))
  );
}

/** Read only the named Meta settings and the deployment's test/development guard. */
export function readMetaConversionConfig(
  env: Record<string, string | undefined>,
  options: { mode?: MetaConversionMode } = {},
): MetaConversionConfig {
  const mode =
    options.mode ??
    (env.NODE_ENV === "test" || env.NODE_ENV === "development" ? "test" : "production");
  const config: MetaConversionConfig = {
    enabled: env.META_CONVERSIONS_ENABLED === "true",
    mode,
    ...(env.META_DATASET_ID ? { datasetId: env.META_DATASET_ID } : {}),
    ...(env.META_ACCESS_TOKEN ? { accessToken: env.META_ACCESS_TOKEN } : {}),
    ...(env.META_GRAPH_API_VERSION ? { graphVersion: env.META_GRAPH_API_VERSION } : {}),
    ...(env.META_TEST_EVENT_CODE ? { testEventCode: env.META_TEST_EVENT_CODE } : {}),
  };
  // An incomplete or disabled configuration must not retain a credential for a caller to log.
  return metaConversionConfigured(config) ? config : { enabled: false, mode };
}

function reject(reason: MetaConversionRejection): MetaConversionBuildResult {
  return { status: "rejected", reason };
}

/** Only allowlisted fields are copied; no customer, subscription, email, IP, UA, or referrer. */
export function buildMetaConversionPayload(event: MetaConversionEvent): MetaConversionBuildResult {
  if (event == null || typeof event !== "object") return reject("invalid_event");
  if (event.consent === "withdrawn") return reject("consent_withdrawn");
  if (event.consent === "denied") return reject("consent_denied");
  if (event.consent !== "granted") return reject("consent_required");
  if (
    event.eventName !== "Purchase" &&
    event.eventName !== "InitiateCheckout" &&
    event.eventName !== "CompleteRegistration"
  )
    return reject("invalid_event");
  if (
    event.eventName === "CompleteRegistration" &&
    (event.amountPaidMinor !== undefined || event.currency !== undefined)
  )
    return reject("invalid_amount");
  if (typeof event.eventId !== "string" || !uuidV4.test(event.eventId))
    return reject("invalid_event_id");
  if (
    !Number.isSafeInteger(event.eventTime) ||
    event.eventTime <= 0 ||
    event.eventTime > 9_999_999_999
  ) {
    return reject("invalid_event_time");
  }
  if (!publicSources.has(event.eventSourceUrl)) return reject("invalid_source_url");

  const matching = event.matching;
  if (matching == null) return reject("matching_absent");
  if (typeof matching !== "object" || Array.isArray(matching)) return reject("invalid_matching");
  if (
    (matching.fbp !== undefined &&
      (typeof matching.fbp !== "string" || !fbpFormat.test(matching.fbp))) ||
    (matching.fbc !== undefined &&
      (typeof matching.fbc !== "string" || !fbcFormat.test(matching.fbc)))
  ) {
    return reject("invalid_matching");
  }
  if (matching.fbp === undefined && matching.fbc === undefined) return reject("matching_absent");

  let customData: MetaServerEvent["custom_data"];
  if (
    event.eventName === "Purchase" ||
    event.amountPaidMinor !== undefined ||
    event.currency !== undefined
  ) {
    if (event.currency !== "USD") return reject("invalid_currency");
    const cents = event.amountPaidMinor;
    if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0)
      return reject("invalid_amount");
    const value = cents / 100;
    if (Math.round(value * 100) !== cents) return reject("invalid_amount");
    customData = { value, currency: "USD" };
  }

  return {
    status: "built",
    payload: {
      event_name: event.eventName,
      event_id: event.eventId,
      event_time: event.eventTime,
      action_source: "website",
      event_source_url:
        event.eventSourceUrl === "https://mepmail.dev"
          ? "https://mepmail.dev/"
          : event.eventSourceUrl,
      user_data: {
        ...(matching.fbp !== undefined ? { fbp: matching.fbp } : {}),
        ...(matching.fbc !== undefined ? { fbc: matching.fbc } : {}),
      },
      ...(customData !== undefined ? { custom_data: customData } : {}),
    },
  };
}

/** One attempt only. The outbox owns retries, consent concurrency, and financial classification. */
export async function sendMetaConversion(
  event: MetaConversionEvent,
  config: MetaConversionConfig,
  transport: MetaConversionTransport,
): Promise<MetaConversionOutcome> {
  try {
    if (config?.enabled !== true) return { status: "disabled", reason: "feature_disabled" };
    if (!metaConversionConfigured(config)) return { status: "disabled", reason: "configuration" };
    const built = buildMetaConversionPayload(event);
    if (built.status === "rejected") return { status: "dead", reason: built.reason };
    const timeoutMs = transport.timeoutMs ?? 5_000;
    if (
      typeof transport.fetch !== "function" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000
    ) {
      return { status: "disabled", reason: "configuration" };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<MetaConversionOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "retry", reason: "timeout" });
      }, timeoutMs);
    });
    const attempt = async (): Promise<MetaConversionOutcome> => {
      try {
        // The Graph endpoint is fixed. Redirects must not forward this private request elsewhere.
        const response = await transport.fetch(
          `https://graph.facebook.com/${config.graphVersion}/${config.datasetId}/events`,
          {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              data: [built.payload],
              access_token: config.accessToken,
              ...(config.mode === "test" ? { test_event_code: config.testEventCode } : {}),
            }),
          },
        );
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
          return { status: "retry", reason: "invalid_response" };
        }
        if (response.status === 429) return { status: "retry", reason: "rate_limited" };
        if (response.status >= 500) return { status: "retry", reason: "server_error" };
        if (response.status < 200 || response.status >= 300)
          return { status: "dead", reason: "client_error" };
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return { status: "retry", reason: "invalid_response" };
        }
        if (
          body == null ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          "error" in body ||
          !("events_received" in body) ||
          body.events_received !== 1
        ) {
          return { status: "retry", reason: "invalid_response" };
        }
        return { status: "accepted", mode: config.mode };
      } catch {
        return { status: "retry", reason: controller.signal.aborted ? "timeout" : "network" };
      }
    };
    try {
      return await Promise.race([attempt(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    // Never propagate provider failures or their potentially private error text to payment callers.
    return { status: "retry", reason: "network" };
  }
}
