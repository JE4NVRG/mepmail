import { env } from "@millionsend/config";
import { deriveMailboxSenderKey } from "../../../../packages/core/src/mailbox-senders";

let cached: { source: string; key: Buffer } | null = null;

/**
 * The HMAC key behind sender lookups (Aprovação de remetentes), derived from
 * MASTER_ENCRYPTION_KEY. Null on a deployment without one: screening is off
 * there and nothing is annotated or decided.
 */
export function mailboxSenderHmacKey(): Buffer | null {
  const master = env.MASTER_ENCRYPTION_KEY;
  if (!master) return null;
  if (cached?.source !== master)
    cached = { source: master, key: deriveMailboxSenderKey(Buffer.from(master, "base64")) };
  return cached.key;
}
