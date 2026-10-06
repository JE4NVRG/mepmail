import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADVERTISING_CONSENT_COOKIE,
  ADVERTISING_CONSENT_MAX_AGE,
  ADVERTISING_POLICY_VERSION,
  advertisingCookie,
  consentSameOrigin,
  decodeConsentProof,
  encodeConsentProof,
  newConsentProof,
} from "../../../packages/billing/src/advertising-consent.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  session: vi.fn(),
  db: {},
}));
vi.mock("@millionsend/billing", () => ({
  ADVERTISING_CONSENT_COOKIE,
  ADVERTISING_CONSENT_MAX_AGE,
  ADVERTISING_POLICY_VERSION,
  advertisingCookie,
  consentSameOrigin,
  decodeConsentProof,
  encodeConsentProof,
  readAdvertisingConsent: mocks.read,
  saveAdvertisingConsent: mocks.save,
}));
vi.mock("@millionsend/config", () => ({ env: { BETTER_AUTH_SECRET: "offline-auth-secret" } }));
vi.mock("@millionsend/db", () => ({ getDb: () => mocks.db }));
vi.mock("@/lib/api-base-url", () => ({ appOrigin: () => "https://mepmail.dev" }));
vi.mock("@/server/auth", () => ({ getAuth: () => ({ api: { getSession: mocks.session } }) }));

import { GET, POST } from "../src/app/api/advertising-consent/route.js";

const request = (body: unknown, extra: Record<string, string> = {}) =>
  new Request("https://mepmail.dev/api/advertising-consent", {
    method: "POST",
    headers: {
      origin: "https://mepmail.dev",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...extra,
    },
    body: JSON.stringify(body),
  });
describe("advertising consent API contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockResolvedValue({ state: "unknown", policyVersion: "meta-ads-v1" });
    mocks.save.mockResolvedValue({
      state: "accepted",
      policyVersion: "meta-ads-v1",
      proof: newConsentProof(),
    });
    mocks.session.mockResolvedValue(null);
  });
  it("GET absent proof exposes only unknown and does not set cookie/write", async () => {
    const response = await GET(new Request("https://mepmail.dev/api/advertising-consent"));
    expect(await response.json()).toEqual({ state: "unknown", policyVersion: "meta-ads-v1" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledWith(mocks.db, null);
  });
  it("accept persists server actor and returns no receipt/proof/matching cookie", async () => {
    mocks.session.mockResolvedValue({ user: { id: "user_server" } });
    const response = await POST(
      request(
        { granted: true, policyVersion: "meta-ads-v1" },
        { referer: "https://mepmail.dev/pricing" },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "accepted", policyVersion: "meta-ads-v1" });
    expect(mocks.save).toHaveBeenCalledWith(mocks.db, {
      granted: true,
      proof: null,
      userId: "user_server",
      sourceUrl: "https://mepmail.dev/pricing",
    });
    expect(response.headers.get("set-cookie")).toMatch(
      /mm_ads_consent=.*; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/,
    );
  });
  it("anonymous withdrawal uses signed proof without needing an auth session", async () => {
    const proof = newConsentProof();
    mocks.save.mockResolvedValue({ state: "denied", policyVersion: "meta-ads-v1", proof });
    mocks.session.mockRejectedValue(new Error("auth-unavailable"));
    const response = await POST(
      request(
        { granted: false, policyVersion: "meta-ads-v1" },
        { cookie: `mm_ads_consent=${encodeConsentProof(proof, "offline-auth-secret")}` },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "denied", policyVersion: "meta-ads-v1" });
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0]?.[1]).toMatchObject({ granted: false, proof, userId: null });
  });
  it.each([
    [{ granted: true, policyVersion: "old" }, {}, 400],
    [{ granted: "true", policyVersion: "meta-ads-v1" }, {}, 400],
    [{ granted: true, policyVersion: "meta-ads-v1", receiptId: "fake" }, {}, 400],
    [{ granted: true, policyVersion: "meta-ads-v1" }, { origin: "https://attacker.invalid" }, 403],
    [{ granted: true, policyVersion: "meta-ads-v1" }, { "sec-fetch-site": "cross-site" }, 403],
    [{ granted: true, policyVersion: "meta-ads-v1" }, { "content-type": "text/plain" }, 415],
    [{ granted: true, policyVersion: "meta-ads-v1", padding: "x".repeat(300) }, {}, 413],
  ] as const)(
    "rejects invalid choice/origin/oversize without persistence",
    async (body, headers, status) => {
      const response = await POST(request(body, headers));
      expect(response.status).toBe(status);
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.session).not.toHaveBeenCalled();
    },
  );
  it("storage errors fail closed with a public unknown response", async () => {
    mocks.save.mockRejectedValue(new Error("private-dsn-not-for-response"));
    const response = await POST(request({ granted: true, policyVersion: "meta-ads-v1" }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
