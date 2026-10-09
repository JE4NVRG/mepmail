import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// v2 adds Google Analytics: consent given for Meta alone is asked again.
export const ADVERTISING_POLICY_VERSION = "ads-v2";
export const ADVERTISING_CONSENT_COOKIE = "mm_ads_consent";
export const ADVERTISING_CONSENT_MAX_AGE = 90 * 24 * 60 * 60;
export type AdvertisingConsentState = "unknown" | "accepted" | "denied";
export interface ConsentProof {
  id: string;
  nonce: string;
  expires: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function signature(secret: string, value: string): string {
  const key = createHmac("sha256", secret)
    .update(`mepmail:advertising-consent:${ADVERTISING_POLICY_VERSION}`)
    .digest();
  return createHmac("sha256", key).update(value).digest("base64url");
}

export function newConsentProof(now = new Date()): ConsentProof {
  return {
    id: randomUUID(),
    nonce: randomUUID(),
    expires: Math.floor(now.getTime() / 1000) + ADVERTISING_CONSENT_MAX_AGE,
  };
}

export function encodeConsentProof(proof: ConsentProof, secret: string): string {
  if (
    !secret ||
    !UUID.test(proof.id) ||
    !UUID.test(proof.nonce) ||
    !Number.isSafeInteger(proof.expires)
  )
    throw new Error("invalid_consent_proof");
  const value = `${proof.id}.${proof.nonce}.${proof.expires}`;
  return `${value}.${signature(secret, value)}`;
}

export function decodeConsentProof(
  value: string | undefined | null,
  secret: string,
  now = new Date(),
): ConsentProof | null {
  if (!secret || !value || value.length > 200) return null;
  const fields = value.split(".");
  if (
    fields.length !== 4 ||
    !UUID.test(fields[0] ?? "") ||
    !UUID.test(fields[1] ?? "") ||
    !/^\d{10}$/.test(fields[2] ?? "")
  )
    return null;
  const expires = Number(fields[2]);
  if (
    expires <= Math.floor(now.getTime() / 1000) ||
    expires > Math.floor(now.getTime() / 1000) + ADVERTISING_CONSENT_MAX_AGE + 60
  )
    return null;
  const expected = Buffer.from(signature(secret, fields.slice(0, 3).join(".")));
  const actual = Buffer.from(fields[3] ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { id: fields[0]!, nonce: fields[1]!, expires };
}

/** No decoding twice and no duplicate cookie names as a proof/matching bypass. */
export function advertisingCookie(header: string | null, name: string): string | null {
  const matches = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  try {
    return decodeURIComponent(matches[0]!.slice(name.length + 1));
  } catch {
    return null;
  }
}

export function consentSameOrigin(request: Request, trustedOrigin: string): boolean {
  try {
    const trusted = new URL(trustedOrigin);
    const host = request.headers.get("host");
    return (
      request.headers.get("origin") === trusted.origin &&
      !["cross-site", "none"].includes(request.headers.get("sec-fetch-site") ?? "") &&
      (host === null ? new URL(request.url).origin === trusted.origin : host === trusted.host)
    );
  } catch {
    return false;
  }
}

export function publicAdvertisingSource(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://mepmail.dev" &&
      ["/", "/pricing"].includes(url.pathname) &&
      !url.username &&
      !url.password
      ? `${url.origin}${url.pathname}`
      : null;
  } catch {
    return null;
  }
}
