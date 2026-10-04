import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADVERTISING_CONSENT_COOKIE,
  ADVERTISING_CONSENT_MAX_AGE,
  ADVERTISING_POLICY_VERSION,
  advertisingCookie,
  consentSameOrigin,
  decodeConsentProof,
  encodeConsentProof,
  newConsentProof,
  publicAdvertisingSource,
} from "../src/advertising-consent.js";

const now = new Date("2026-10-03T03:00:00.000Z");
const secret = "offline-session-secret-for-consent";
const proof = {
  id: "8f3059a8-7c30-48ba-bafe-9bd2b233cbb5",
  nonce: "9dc7b8e4-f0a3-4138-9af9-ef9f09248923",
  expires: Math.floor(now.getTime() / 1_000) + ADVERTISING_CONSENT_MAX_AGE,
};
const origin = "https://mepmail.dev";
function request(headers: Record<string, string> = {}, url = `${origin}/api/trpc/consent.accept`) {
  return new Request(url, { method: "POST", headers });
}

describe("advertising consent proof and public context", () => {
  it("uses a policy/domain-separated derived HMAC key and round-trips its opaque proof", () => {
    const value = `${proof.id}.${proof.nonce}.${proof.expires}`;
    const derived = createHmac("sha256", secret)
      .update(`mepmail:advertising-consent:${ADVERTISING_POLICY_VERSION}`)
      .digest();
    const expected = createHmac("sha256", derived).update(value).digest("base64url");
    expect(encodeConsentProof(proof, secret)).toBe(`${value}.${expected}`);
    expect(decodeConsentProof(`${value}.${expected}`, secret, now)).toEqual(proof);
    const undifferentiated = createHmac("sha256", secret).update(value).digest("base64url");
    expect(decodeConsentProof(`${value}.${undifferentiated}`, secret, now)).toBeNull();
  });

  it("creates independent random UUIDs and a bounded 90-day expiry", () => {
    const first = newConsentProof(now);
    const second = newConsentProof(now);
    expect(first.id).not.toBe(first.nonce);
    expect(first.id).not.toBe(second.id);
    expect(first.expires).toBe(proof.expires);
    expect(decodeConsentProof(encodeConsentProof(first, secret), secret, now)).toEqual(first);
  });

  it("rejects tampered proof identity, nonce, expiry and signature", () => {
    const encoded = encodeConsentProof(proof, secret);
    const parts = encoded.split(".");
    for (const [index, replacement] of [
      [0, proof.nonce],
      [1, proof.id],
      [2, String(proof.expires - 1)],
      [3, "A".repeat(43)],
    ] as const) {
      const tampered = [...parts];
      tampered[index] = replacement;
      expect(decodeConsentProof(tampered.join("."), secret, now)).toBeNull();
    }
  });

  it("rejects a wrong/empty secret and malformed or absent proofs", () => {
    const encoded = encodeConsentProof(proof, secret);
    expect(decodeConsentProof(encoded, "different-key", now)).toBeNull();
    expect(decodeConsentProof(encoded, "", now)).toBeNull();
    for (const value of [null, undefined, "", "not-a-proof", `${encoded}.extra`, "a".repeat(201)]) {
      expect(decodeConsentProof(value, secret, now)).toBeNull();
    }
    expect(() => encodeConsentProof(proof, "")).toThrow("invalid_consent_proof");
  });

  it("rejects expiry at the boundary and proofs beyond the allowed future window", () => {
    const boundary = new Date(proof.expires * 1_000);
    expect(decodeConsentProof(encodeConsentProof(proof, secret), secret, boundary)).toBeNull();
    const tooFar = { ...proof, expires: proof.expires + 61 };
    expect(decodeConsentProof(encodeConsentProof(tooFar, secret), secret, now)).toBeNull();
    expect(
      decodeConsentProof(
        encodeConsentProof(proof, secret),
        secret,
        new Date(boundary.getTime() - 1_000),
      ),
    ).toEqual(proof);
  });

  it("requires exactly one cookie occurrence for proof and matching names", () => {
    const encoded = encodeConsentProof(proof, secret);
    const once = `session=opaque; ${ADVERTISING_CONSENT_COOKIE}=${encoded}; _fbp=fb.1.1791000000123.123`;
    expect(advertisingCookie(once, ADVERTISING_CONSENT_COOKIE)).toBe(encoded);
    expect(
      advertisingCookie(
        `${once}; ${ADVERTISING_CONSENT_COOKIE}=${encoded}`,
        ADVERTISING_CONSENT_COOKIE,
      ),
    ).toBeNull();
    expect(advertisingCookie("_fbp=valid; _fbp=other", "_fbp")).toBeNull();
    expect(advertisingCookie(null, ADVERTISING_CONSENT_COOKIE)).toBeNull();
  });

  it("decodes cookie escaping once and rejects malformed encoding", () => {
    const encoded = encodeConsentProof(proof, secret);
    expect(
      advertisingCookie(
        `${ADVERTISING_CONSENT_COOKIE}=${encodeURIComponent(encoded)}`,
        ADVERTISING_CONSENT_COOKIE,
      ),
    ).toBe(encoded);
    expect(
      advertisingCookie(`${ADVERTISING_CONSENT_COOKIE}=%ZZ`, ADVERTISING_CONSENT_COOKIE),
    ).toBeNull();
    const doubleEncoded = encodeURIComponent("%2E");
    expect(
      advertisingCookie(
        `${ADVERTISING_CONSENT_COOKIE}=${doubleEncoded}`,
        ADVERTISING_CONSENT_COOKIE,
      ),
    ).toBe("%2E");
    expect(decodeConsentProof("%2E", secret, now)).toBeNull();
  });

  it("accepts only a same-origin request with matching Origin and no cross-site fetch indication", () => {
    expect(consentSameOrigin(request({ origin, "sec-fetch-site": "same-origin" }), origin)).toBe(
      true,
    );
    expect(consentSameOrigin(request({ origin }), origin)).toBe(true);
    expect(consentSameOrigin(request({ origin, "sec-fetch-site": "same-site" }), origin)).toBe(
      true,
    );
  });

  it("blocks missing/foreign/null Origin, foreign request URL, and explicit CSRF indications", () => {
    for (const candidate of [
      request(),
      request({ origin: "https://attacker.invalid" }),
      request({ origin: "null" }),
      request({ origin }, "https://attacker.invalid/api/trpc/consent.accept"),
      request({ origin, "sec-fetch-site": "cross-site" }),
      request({ origin, "sec-fetch-site": "none" }),
    ]) {
      expect(consentSameOrigin(candidate, origin)).toBe(false);
    }
    expect(consentSameOrigin(request({ origin }), "malformed trusted origin")).toBe(false);
  });

  it("accepts the public Host behind an internal proxy URL without trusting forwarded headers", () => {
    const internal = "http://localhost:3000/api/advertising-consent";
    expect(
      consentSameOrigin(
        request({ origin, host: "mepmail.dev", "sec-fetch-site": "same-origin" }, internal),
        origin,
      ),
    ).toBe(true);
    expect(
      consentSameOrigin(
        request({ origin, host: "mepmail.dev", "x-forwarded-host": "attacker.invalid" }, internal),
        origin,
      ),
    ).toBe(true);
    expect(consentSameOrigin(request({ origin }, internal), origin)).toBe(false);
  });

  it("rejects a wrong, empty, multiple or port-mismatched Host even with a trusted forwarded Host", () => {
    for (const host of [
      "attacker.invalid",
      "",
      "mepmail.dev, attacker.invalid",
      "mepmail.dev:443",
    ]) {
      expect(
        consentSameOrigin(request({ origin, host, "x-forwarded-host": "mepmail.dev" }), origin),
      ).toBe(false);
    }
    expect(
      consentSameOrigin(
        request(
          { origin, "x-forwarded-host": "mepmail.dev" },
          "http://localhost:3000/api/advertising-consent",
        ),
        origin,
      ),
    ).toBe(false);
  });

  it("rejects foreign or multiple Origins and explicit CSRF indications behind the proxy", () => {
    const internal = "http://localhost:3000/api/advertising-consent";
    for (const headers of [
      { host: "mepmail.dev" },
      { host: "mepmail.dev", origin: "https://attacker.invalid" },
      { host: "mepmail.dev", origin: `${origin}, https://attacker.invalid` },
      { host: "mepmail.dev", origin, "sec-fetch-site": "cross-site" },
      { host: "mepmail.dev", origin, "sec-fetch-site": "none" },
    ]) {
      expect(consentSameOrigin(request(headers, internal), origin)).toBe(false);
    }
  });

  it("keeps only allowlisted public sources and strips query/fragment attribution or private values", () => {
    expect(
      publicAdvertisingSource("https://mepmail.dev/?utm_source=ads&email=private#fragment"),
    ).toBe("https://mepmail.dev/");
    expect(publicAdvertisingSource("https://mepmail.dev/pricing?fbclid=private#section")).toBe(
      "https://mepmail.dev/pricing",
    );
    expect(publicAdvertisingSource("https://mepmail.dev")).toBe("https://mepmail.dev/");
  });

  it("rejects private routes, credentials, alternate origins and malformed sources", () => {
    for (const value of [
      null,
      "",
      "invalid",
      "http://mepmail.dev/pricing",
      "https://mepmail.dev/app/team_private",
      "https://mepmail.dev/pricing/",
      "https://user:secret@mepmail.dev/pricing",
      "https://mepmail.dev:444/pricing",
      "https://mepmail.dev.attacker.invalid/pricing",
    ]) {
      expect(publicAdvertisingSource(value)).toBeNull();
    }
  });
});
