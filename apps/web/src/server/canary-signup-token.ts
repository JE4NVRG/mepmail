import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { canarySignupDigestShape, canarySignupTokenShape } from "@millionsend/config/canary-signup";

/**
 * The one place the canary bearer is compared, and the only module that ever
 * touches `node:crypto`.
 *
 * The operator keeps 256 bits of `openssl rand` as a base64url token in their
 * own browser cookie; the environment carries only `sha256(token)` as hex
 * (MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256). So no bearer sits in an env var that
 * every role (web, api, worker, smtp) reads, and nothing can be replayed from
 * configuration: a leaked env gives the digest, which cannot be presented as
 * the cookie — the cookie is the preimage.
 *
 * Both sides are 32 bytes by construction: the digest is validated as
 * canonical 64-character hex and hashed with `createHash("sha256")`, and
 * `timingSafeEqual` compares the two fixed-length buffers. No length, prefix
 * or content of the presented value steers the comparison, and no bespoke
 * constant-time loop is hand-rolled.
 *
 * Nothing here logs, and no error message carries the token or the digest.
 */

/** Bytes in a SHA-256 digest. */
const SHA256_BYTES = 32;

/**
 * SHA-256 of a well-formed token, lowercase hex; null when the value is not a
 * 256-bit base64url token. Padded base64, other lengths and any other alphabet
 * are rejected outright rather than normalized into an accepted spelling.
 */
export function canaryTokenDigestHex(token: unknown): string | null {
  if (!canarySignupTokenShape(token)) return null;
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether `presented` is the token whose digest is `expectedDigest`.
 *
 * Fails closed on every malformed input (missing cookie, padded or truncated
 * token, a raw token where the digest belongs) and compares in constant time
 * otherwise.
 */
export function canaryTokenMatches(
  presented: string | null | undefined,
  expectedDigest: string | null | undefined,
): boolean {
  if (!canarySignupTokenShape(presented)) return false;
  if (!canarySignupDigestShape(expectedDigest)) return false;
  const actual = createHash("sha256").update(presented, "utf8").digest();
  const expected = Buffer.from(expectedDigest, "hex");
  // Unreachable after the shape checks (64 hex = 32 bytes); kept so a future
  // edit to those checks cannot turn into a length-throwing comparison.
  if (actual.length !== SHA256_BYTES || expected.length !== SHA256_BYTES) return false;
  return timingSafeEqual(actual, expected);
}
