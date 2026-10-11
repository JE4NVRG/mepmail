import { env } from "@millionsend/config";
import { deriveMailboxSearchKey } from "@millionsend/core";

let cached: { source: string; key: Buffer } | null = null;

/**
 * The key behind Correio search tokens, derived from MASTER_ENCRYPTION_KEY the same way
 * the worker derives it to fill the index. Null on a deployment without one.
 */
export function mailboxSearchKey(): Buffer | null {
  const master = env.MASTER_ENCRYPTION_KEY;
  if (!master) return null;
  if (cached?.source !== master)
    cached = { source: master, key: deriveMailboxSearchKey(Buffer.from(master, "base64")) };
  return cached.key;
}
