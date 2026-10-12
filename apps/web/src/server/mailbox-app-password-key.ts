import { env } from "@millionsend/config";
import { deriveMailboxAppPasswordKey } from "../../../../packages/core/src/mailbox-app-passwords";

let cached: { source: string; key: Buffer } | null = null;

/**
 * The key behind app password hashes (mail clients over IMAP/SMTP), derived from
 * MASTER_ENCRYPTION_KEY like the IMAP/SMTP service derives it. Null without one: app
 * passwords are then not offered.
 */
export function mailboxAppPasswordKey(): Buffer | null {
  const master = env.MASTER_ENCRYPTION_KEY;
  if (!master) return null;
  if (cached?.source !== master)
    cached = { source: master, key: deriveMailboxAppPasswordKey(Buffer.from(master, "base64")) };
  return cached.key;
}
