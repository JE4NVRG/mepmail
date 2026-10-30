import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { hashRecipient } from "./suppressions.js";

const PURPOSE = "mepmail:azure-recipient-optout:v1";
function mac(payload: string, key: Buffer) {
  if (key.length !== 32) throw new Error("azure_optout_key_invalid");
  return createHmac("sha256", key).update(`${PURPOSE}\0${payload}`).digest("base64url");
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** secretKey is the EXISTING HKDF-derived unsubscribe key, never the master key.
 * No contact creation, opt-in mutation or plaintext recipient in bearer URLs.
 * Tokens intentionally do not expire: retained opt-outs must remain actionable.
 */
export function buildAzureRecipientOptoutUrl(input: {
  teamId: string;
  recipient: string;
  secretKey: Buffer;
  baseUrl: string;
}): string {
  if (!uuid.test(input.teamId)) throw new Error("azure_optout_team_invalid");
  const base = new URL(input.baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("azure_optout_base_invalid");
  const payload = Buffer.from(
    JSON.stringify({ v: 1, teamId: input.teamId, recipientHash: hashRecipient(input.recipient) }),
  ).toString("base64url");
  return new URL(`/unsubscribe/recipient/${payload}.${mac(payload, input.secretKey)}`, base).href;
}
export function verifyAzureRecipientOptoutToken(
  token: string,
  secretKey: Buffer,
): { teamId: string; recipientHash: string } | null {
  try {
    if (token.length > 1024) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const payload = parts[0]!;
    const signature = Buffer.from(parts[1]!, "utf8");
    const expected = Buffer.from(mac(payload, secretKey), "utf8");
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return null;
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (
      parsed.v !== 1 ||
      !uuid.test(parsed.teamId) ||
      !/^[0-9a-f]{64}$/.test(parsed.recipientHash) ||
      Object.keys(parsed).sort().join(",") !== "recipientHash,teamId,v"
    )
      return null;
    return { teamId: parsed.teamId, recipientHash: parsed.recipientHash };
  } catch {
    return null;
  }
}
/** onConflictDoNothing preserves sticky bounce/complaint/manual suppressions. */
export async function recordAzureRecipientOptout(
  db: Db,
  target: { teamId: string; recipientHash: string },
): Promise<void> {
  await db
    .insert(schema.suppressions)
    .values({
      teamId: target.teamId,
      email: null,
      emailHash: target.recipientHash,
      reason: "one_click_unsubscribe",
    })
    .onConflictDoNothing();
}
