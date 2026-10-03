import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MetaConversionConfig,
  MetaConversionEvent,
  MetaFetch,
  MetaFetchRequest,
} from "../src/meta-conversions.js";
import {
  buildMetaConversionPayload,
  metaConversionConfigured,
  readMetaConversionConfig,
  sendMetaConversion,
} from "../src/meta-conversions.js";

const token = "test-only-private-token";
const config: MetaConversionConfig = {
  enabled: true,
  datasetId: "1234567890",
  accessToken: token,
  graphVersion: "v23.0",
  mode: "production",
};
const env = {
  META_CONVERSIONS_ENABLED: "true",
  META_DATASET_ID: config.datasetId,
  META_ACCESS_TOKEN: config.accessToken,
  META_GRAPH_API_VERSION: config.graphVersion,
  NODE_ENV: "production",
};
const purchase: MetaConversionEvent = {
  eventName: "Purchase",
  eventId: "8f3059a8-7c30-48ba-bafe-9bd2b233cbb5",
  eventTime: 1_791_003_200,
  eventSourceUrl: "https://mepmail.dev/pricing",
  consent: "granted",
  matching: { fbp: "fb.1.1791000000123.1234567890", fbc: "fb.1.1791000000123.ClickId-abc_DEF123" },
  amountPaidMinor: 14_239,
  currency: "USD",
};
const event = (patch: Record<string, unknown> = {}): MetaConversionEvent =>
  ({ ...purchase, ...patch }) as MetaConversionEvent;
const response = (status = 200, body: unknown = { events_received: 1 }) => ({
  status,
  json: async () => body,
});
const acceptingFetch = () => vi.fn<MetaFetch>(async () => response());

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Incomplete test fixture or missing asserted result");
  return value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Meta explicit configuration", () => {
  it("defaults off, with no credential or Graph version fallback", () => {
    expect(readMetaConversionConfig({})).toEqual({ enabled: false, mode: "production" });
    expect(metaConversionConfigured(readMetaConversionConfig({}))).toBe(false);
    expect(readMetaConversionConfig(env)).toEqual(config);
  });

  it.each([undefined, "false", "0", "1", "TRUE", " true "])(
    "requires exact opt-in: %s",
    (enabled) => {
      expect(readMetaConversionConfig({ ...env, META_CONVERSIONS_ENABLED: enabled })).toEqual({
        enabled: false,
        mode: "production",
      });
    },
  );

  it.each(["META_DATASET_ID", "META_ACCESS_TOKEN", "META_GRAPH_API_VERSION"])(
    "fails closed without %s",
    (key) => {
      expect(readMetaConversionConfig({ ...env, [key]: undefined })).toEqual({
        enabled: false,
        mode: "production",
      });
      expect(readMetaConversionConfig({ ...env, [key]: "" })).toEqual({
        enabled: false,
        mode: "production",
      });
    },
  );

  it.each([
    { datasetId: "123/other?token=private" },
    { datasetId: "0" },
    { accessToken: " token " },
    { accessToken: "secret\r\nHeader: value" },
    { graphVersion: "https://another.example" },
    { graphVersion: "v23.0/123?access_token=private" },
    { mode: "unknown" },
    { enabled: "true" },
  ])("rejects unsafe or invalid injected config %j", (patch) => {
    expect(metaConversionConfigured({ ...config, ...patch } as MetaConversionConfig)).toBe(false);
  });

  it("reads only its allowlisted fields, with no enrichment or unrelated environment access", () => {
    const source = {
      ...env,
      get STRIPE_SECRET_KEY(): string {
        throw new Error("Unrelated secret was accessed");
      },
      get DATABASE_URL(): string {
        throw new Error("Unrelated secret was accessed");
      },
    };
    expect(readMetaConversionConfig(source)).toEqual(config);
  });

  it("requires test code for non-production test mode and never silently sends it in production", () => {
    expect(readMetaConversionConfig({ ...env, NODE_ENV: "test" })).toEqual({
      enabled: false,
      mode: "test",
    });
    expect(readMetaConversionConfig({ ...env, META_TEST_EVENT_CODE: "TEST123" })).toEqual({
      enabled: false,
      mode: "production",
    });
    expect(metaConversionConfigured({ ...config, testEventCode: "TEST123" })).toBe(false);
    const testConfig = readMetaConversionConfig({
      ...env,
      NODE_ENV: "development",
      META_TEST_EVENT_CODE: "TEST123",
    });
    expect(testConfig).toMatchObject({ enabled: true, mode: "test", testEventCode: "TEST123" });
    expect(
      readMetaConversionConfig({ ...env, META_TEST_EVENT_CODE: "TEST123" }, { mode: "test" }),
    ).toEqual(testConfig);
  });
});

describe("Meta consented payload", () => {
  it("uses actual USD paid cents, original identity/time, and only the public website URL", () => {
    expect(buildMetaConversionPayload(purchase)).toEqual({
      status: "built",
      payload: {
        event_name: "Purchase",
        event_id: purchase.eventId,
        event_time: purchase.eventTime,
        action_source: "website",
        event_source_url: "https://mepmail.dev/pricing",
        user_data: purchase.matching,
        custom_data: { value: 142.39, currency: "USD" },
      },
    });
    const oneCent = buildMetaConversionPayload(event({ amountPaidMinor: 1 }));
    expect(oneCent.status === "built" && oneCent.payload.custom_data?.value).toBe(0.01);
  });

  it.each([
    ["denied", "consent_denied"],
    ["withdrawn", "consent_withdrawn"],
    [undefined, "consent_required"],
    ["unknown", "consent_required"],
  ])("does not build with consent %s", (consent, reason) => {
    expect(buildMetaConversionPayload(event({ consent }))).toEqual({ status: "rejected", reason });
  });

  it.each([
    "https://mepmail.dev/app/private-team",
    "https://mepmail.dev/pricing?email=private%40example.com",
    "https://mepmail.dev/#private",
    "https://user:private@mepmail.dev/",
    "https://mepmail.dev:444/pricing",
    "http://mepmail.dev/",
    "https://mepmail.dev.evil.example/pricing",
    "https://mepmail.dev./pricing",
    "https://mepmail.dev/private/../pricing",
    "https://mepmail.dev/%70ricing",
    "https://mepmail.dev/pricing/",
    "javascript:private",
  ])("rejects private or non-allowlisted source %s", (eventSourceUrl) => {
    expect(buildMetaConversionPayload(event({ eventSourceUrl }))).toEqual({
      status: "rejected",
      reason: "invalid_source_url",
    });
  });

  it.each(["https://mepmail.dev", "https://mepmail.dev/", "https://mepmail.dev/pricing"])(
    "accepts public source %s",
    (eventSourceUrl) => {
      expect(buildMetaConversionPayload(event({ eventSourceUrl })).status).toBe("built");
    },
  );

  it.each([undefined, {}, { email: "private@example.com" }])(
    "suppresses events without allowed matching: %j",
    (matching) => {
      expect(buildMetaConversionPayload(event({ matching }))).toEqual({
        status: "rejected",
        reason: "matching_absent",
      });
    },
  );

  it.each([
    { fbp: "private@example.com" },
    { fbc: "https://private.example/path" },
    { fbp: "fb.1.1791000000123.123\nprivate" },
    { fbc: "fb.1.1791000000123.ClickId?email=private" },
    { fbp: "fb.1.1791000000.123" },
    { fbp: "" },
    { fbp: required(purchase.matching).fbp, fbc: "malformed" },
    { fbp: 123 },
    [],
  ])("rejects malformed matching even alongside a valid cookie: %j", (matching) => {
    expect(buildMetaConversionPayload(event({ matching }))).toEqual({
      status: "rejected",
      reason: "invalid_matching",
    });
  });

  it("copies only fbp/fbc and never enriches with identity or private context", () => {
    const privateInput = event({
      customerId: "cus_private",
      subscriptionId: "sub_private",
      referrer: "https://private.example/",
      matching: {
        ...purchase.matching,
        email: "private@example.com",
        phone: "123456789",
        client_ip_address: "127.0.0.1",
        client_user_agent: "private UA",
        external_id: "private-team",
      },
    });
    const built = buildMetaConversionPayload(privateInput);
    expect(built.status).toBe("built");
    if (built.status !== "built") throw new Error("Expected an allowlisted payload");
    expect(Object.keys(built.payload.user_data).sort()).toEqual(["fbc", "fbp"]);
    expect(JSON.stringify(built.payload)).not.toMatch(
      /private|cus_|sub_|client_|external_id|email|phone|referrer/,
    );
  });

  it.each([{ fbp: required(purchase.matching).fbp }, { fbc: required(purchase.matching).fbc }])(
    "accepts either consented cookie without inventing another: %j",
    (matching) => {
      const built = buildMetaConversionPayload(event({ matching }));
      expect(built.status === "built" && built.payload.user_data).toEqual(matching);
    },
  );

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined])(
    "rejects unpaid or unsafe Purchase value: %s",
    (amountPaidMinor) => {
      expect(buildMetaConversionPayload(event({ amountPaidMinor }))).toEqual({
        status: "rejected",
        reason: "invalid_amount",
      });
    },
  );

  it.each(["BRL", "usd", "", undefined])("does not convert or invent currency: %s", (currency) => {
    expect(buildMetaConversionPayload(event({ currency }))).toEqual({
      status: "rejected",
      reason: "invalid_currency",
    });
  });

  it("builds InitiateCheckout without an invented catalog value", () => {
    const checkout = event({
      eventName: "InitiateCheckout",
      amountPaidMinor: undefined,
      currency: undefined,
    });
    const built = buildMetaConversionPayload(checkout);
    expect(built.status === "built" && built.payload.event_name).toBe("InitiateCheckout");
    expect(built.status === "built" && Object.hasOwn(built.payload, "custom_data")).toBe(false);
    const valued = buildMetaConversionPayload(
      event({ eventName: "InitiateCheckout", amountPaidMinor: 549 }),
    );
    expect(valued.status === "built" && valued.payload.custom_data).toEqual({
      value: 5.49,
      currency: "USD",
    });
    expect(
      buildMetaConversionPayload(event({ eventName: "InitiateCheckout", amountPaidMinor: 0 })),
    ).toEqual({ status: "rejected", reason: "invalid_amount" });
  });

  it.each([
    "cus_private",
    "team_123",
    "00000000-0000-0000-0000-000000000000",
    "8f3059a8-7c30-18ba-bafe-9bd2b233cbb5",
  ])("requires an opaque random UUID: %s", (eventId) => {
    expect(buildMetaConversionPayload(event({ eventId }))).toEqual({
      status: "rejected",
      reason: "invalid_event_id",
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 1_791_003_200_000])(
    "rejects invalid or millisecond event time: %s",
    (eventTime) => {
      expect(buildMetaConversionPayload(event({ eventTime }))).toEqual({
        status: "rejected",
        reason: "invalid_event_time",
      });
    },
  );

  it("rejects arbitrary event names, rather than adding tracking scope", () => {
    expect(buildMetaConversionPayload(event({ eventName: "PageView" }))).toEqual({
      status: "rejected",
      reason: "invalid_event",
    });
  });
});

describe("Meta isolated single-attempt transport", () => {
  it.each([
    [{ ...config, enabled: false }, "feature_disabled"],
    [{ ...config, accessToken: undefined }, "configuration"],
    [{ ...config, graphVersion: undefined }, "configuration"],
  ])("does not call fetch with disabled or incomplete configuration", async (candidate, reason) => {
    const fetch = acceptingFetch();
    expect(
      await sendMetaConversion(purchase, candidate as MetaConversionConfig, { fetch }),
    ).toEqual({ status: "disabled", reason });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { consent: "denied" },
    { consent: "withdrawn" },
    { matching: undefined },
    { amountPaidMinor: 0 },
    { eventSourceUrl: "https://mepmail.dev/app/private" },
  ])("never attempts rejected events: %j", async (patch) => {
    const fetch = acceptingFetch();
    expect((await sendMetaConversion(event(patch), config, { fetch })).status).toBe("dead");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends one CAPI event with token in body only and forbids redirects", async () => {
    const fetch = acceptingFetch();
    expect(await sendMetaConversion(purchase, config, { fetch })).toEqual({
      status: "accepted",
      mode: "production",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = required(fetch.mock.calls[0]);
    expect(url).toBe("https://graph.facebook.com/v23.0/1234567890/events");
    expect(url).not.toContain(token);
    expect(url).not.toContain("?");
    expect(request.redirect).toBe("error");
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    const body = JSON.parse(request.body) as {
      data: unknown[];
      access_token: string;
      test_event_code?: string;
    };
    expect(body.access_token).toBe(token);
    expect(body.data).toHaveLength(1);
    expect(body).not.toHaveProperty("test_event_code");
  });

  it("labels test acceptance separately and includes code only in the test body", async () => {
    const testConfig: MetaConversionConfig = { ...config, mode: "test", testEventCode: "TEST123" };
    const fetch = acceptingFetch();
    expect(await sendMetaConversion(purchase, testConfig, { fetch })).toEqual({
      status: "accepted",
      mode: "test",
    });
    const [url, request] = required(fetch.mock.calls[0]);
    expect(url).not.toContain("TEST123");
    expect(JSON.parse(request.body).test_event_code).toBe("TEST123");
  });

  it("preserves event ID, original time, and request across externally scheduled retries", async () => {
    const before = JSON.stringify(purchase);
    const fetch = vi
      .fn<MetaFetch>()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response());
    expect(await sendMetaConversion(purchase, config, { fetch })).toEqual({
      status: "retry",
      reason: "rate_limited",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await sendMetaConversion(purchase, config, { fetch })).toEqual({
      status: "accepted",
      mode: "production",
    });
    expect(required(fetch.mock.calls[0])[1].body).toBe(required(fetch.mock.calls[1])[1].body);
    const data = JSON.parse(required(fetch.mock.calls[1])[1].body).data;
    expect(data[0].event_id).toBe(purchase.eventId);
    expect(data[0].event_time).toBe(purchase.eventTime);
    expect(JSON.stringify(purchase)).toBe(before);
  });

  it.each([
    [400, "dead", "client_error"],
    [401, "dead", "client_error"],
    [403, "dead", "client_error"],
    [302, "dead", "client_error"],
    [429, "retry", "rate_limited"],
    [500, "retry", "server_error"],
    [503, "retry", "server_error"],
  ])("sanitizes HTTP %s without reading error payload", async (status, outcome, reason) => {
    const json = vi.fn(async () => {
      throw new Error(`Private provider detail ${token}`);
    });
    const fetch = vi.fn<MetaFetch>(async () => ({ status: status as number, json }));
    expect(await sendMetaConversion(purchase, config, { fetch })).toEqual({
      status: outcome,
      reason,
    });
    expect(json).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    null,
    [],
    { events_received: 0 },
    { events_received: 2 },
    { events_received: "1" },
    { events_received: 1, error: { message: token } },
  ])("requires exactly one received event from a valid success body: %j", async (body) => {
    const fetch = vi.fn<MetaFetch>(async () => response(200, body));
    expect(await sendMetaConversion(purchase, config, { fetch })).toEqual({
      status: "retry",
      reason: "invalid_response",
    });
  });

  it("sanitizes malformed JSON and all network error messages", async () => {
    const jsonFailure = vi.fn<MetaFetch>(async () => ({
      status: 200,
      json: async () => {
        throw new Error(token);
      },
    }));
    expect(await sendMetaConversion(purchase, config, { fetch: jsonFailure })).toEqual({
      status: "retry",
      reason: "invalid_response",
    });
    const rejected = vi.fn<MetaFetch>(async () => {
      throw new Error(`https://provider.invalid/?access_token=${token}`);
    });
    const outcome = await sendMetaConversion(purchase, config, { fetch: rejected });
    expect(outcome).toEqual({ status: "retry", reason: "network" });
    expect(JSON.stringify(outcome)).not.toContain(token);
    const throwing: MetaFetch = () => {
      throw new Error(token);
    };
    await expect(sendMetaConversion(purchase, config, { fetch: throwing })).resolves.toEqual({
      status: "retry",
      reason: "network",
    });
  });

  it.each([0, -1, NaN, 30_001])("does not send with invalid timeout %s", async (timeoutMs) => {
    const fetch = acceptingFetch();
    expect(await sendMetaConversion(purchase, config, { fetch, timeoutMs })).toEqual({
      status: "disabled",
      reason: "configuration",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds an unresponsive fetch even when an injected transport ignores abort", async () => {
    vi.useFakeTimers();
    let request: MetaFetchRequest | undefined;
    const fetch = vi.fn<MetaFetch>((_url, options) => {
      request = options;
      return new Promise(() => {});
    });
    const pending = sendMetaConversion(purchase, config, { fetch, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ status: "retry", reason: "timeout" });
    expect(request?.signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a success response whose body never completes", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<MetaFetch>(async () => ({
      status: 200,
      json: () => new Promise(() => {}),
    }));
    const pending = sendMetaConversion(purchase, config, { fetch, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ status: "retry", reason: "timeout" });
    expect(required(fetch.mock.calls[0])[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its deadline after an accepted response and exports no payload or token", async () => {
    vi.useFakeTimers();
    const outcome = await sendMetaConversion(purchase, config, { fetch: acceptingFetch() });
    expect(outcome).toEqual({ status: "accepted", mode: "production" });
    expect(Object.keys(outcome).sort()).toEqual(["mode", "status"]);
    expect(JSON.stringify(outcome)).not.toContain(token);
    expect(vi.getTimerCount()).toBe(0);
  });
});
