import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@millionsend/config";
import { senderLogoFor } from "../lib/mailbox-sender-logo";

/**
 * Sender pictures are asked for with a token the server signs while listing a message it
 * holds, never with a domain the browser names: the logo route fetches only for a domain
 * that sent mail which passed DMARC (persisted at receipt), and BIMI only when that same
 * message carried an enforced policy. The token says which pictures may be looked up
 * (the domain, BIMI or not, the sender's Gravatar hash) and for how long.
 */

export interface SenderPictureGrant {
  /** Brand domain (null for personal mail services: Gravatar only). */
  domain: string | null;
  bimi: boolean;
  /** sha256 of the sender's address, Gravatar's id. */
  gravatar: string;
}

const WEEK_MS = 7 * 24 * 3_600_000;
let cached: { source: string; key: Buffer } | null = null;

function signingKey(): Buffer | null {
  const master = env.MASTER_ENCRYPTION_KEY;
  if (!master) return null;
  if (cached?.source !== master)
    cached = {
      source: master,
      key: createHmac("sha256", Buffer.from(master, "base64"))
        .update("mepmail/sender-picture/v1")
        .digest(),
    };
  return cached.key;
}

function mac(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * The token for one listed message, or null (not received, did not pass DMARC, or no
 * signing key). It changes once a week, so a sender's picture keeps one URL (and one
 * browser cache entry) across all of their messages that week.
 */
export function senderPictureToken(
  row: { kind: string; from: string; inboundAssessment?: unknown },
  now = Date.now(),
): string | null {
  const key = signingKey();
  const picture = senderLogoFor(row);
  if (!key || !picture) return null;
  const expires = (Math.floor(now / WEEK_MS) + 2) * WEEK_MS;
  const gravatar = createHash("sha256").update(picture.address).digest("hex");
  const payload = Buffer.from(
    JSON.stringify({ d: picture.domain, b: picture.bimi, g: gravatar, e: expires }),
  ).toString("base64url");
  return `${payload}.${mac(key, payload)}`;
}

/** What a token allows, or null when it is forged, malformed or expired. */
export function readSenderPictureToken(token: string, now = Date.now()): SenderPictureGrant | null {
  const key = signingKey();
  if (!key || token.length > 600) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(key, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      d?: unknown;
      b?: unknown;
      g?: unknown;
      e?: unknown;
    };
    if (typeof value.e !== "number" || value.e <= now) return null;
    if (typeof value.g !== "string" || !/^[0-9a-f]{64}$/.test(value.g)) return null;
    if (value.d !== null && typeof value.d !== "string") return null;
    return {
      domain: value.d ?? null,
      bimi: value.b === true && value.d !== null,
      gravatar: value.g,
    };
  } catch {
    return null;
  }
}
