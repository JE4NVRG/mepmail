import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@millionsend/config";
import { MailboxAgentAccessError } from "@millionsend/core";

/**
 * The page cursor an agent gets back from /api/mailbox-agent/items: the listing's own
 * position, signed for one team, one mailbox and one set of filters. A cursor from
 * another mailbox, tenant or query, or altered in any byte, is refused ("invalid"), so
 * a client can never splice pages of different listings. Opaque to clients.
 */
export interface MailboxAgentCursorScope {
  teamId: string;
  mailboxId: string;
  /** Canonical form of the mode and filters the page was produced with. */
  filters: string;
}

const MAX_CURSOR = 256;

function key(): Buffer {
  if (!env.MASTER_ENCRYPTION_KEY) throw new MailboxAgentAccessError("forbidden");
  return createHmac("sha256", Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64"))
    .update("mepmail/agent-list-cursor/v1")
    .digest();
}

function tag(scope: MailboxAgentCursorScope, inner: string): Buffer {
  return createHmac("sha256", key())
    .update(`${scope.teamId}\n${scope.mailboxId}\n${scope.filters}\n${inner}`)
    .digest()
    .subarray(0, 16);
}

/** The signed cursor for the next page, or null at the end of the listing. */
export function signMailboxAgentCursor(
  scope: MailboxAgentCursorScope,
  inner: string | null | undefined,
): string | null {
  if (inner === null || inner === undefined) return null;
  return `${Buffer.from(inner, "utf8").toString("base64url")}.${tag(scope, inner).toString("base64url")}`;
}

/** The listing position inside a cursor this scope signed; anything else is "invalid". */
export function openMailboxAgentCursor(scope: MailboxAgentCursorScope, cursor: string): string {
  const parts = cursor.length <= MAX_CURSOR ? cursor.split(".") : [];
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)))
    throw new MailboxAgentAccessError("invalid");
  const inner = Buffer.from(parts[0]!, "base64url").toString("utf8");
  const given = Buffer.from(parts[1]!, "base64url");
  const expected = tag(scope, inner);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new MailboxAgentAccessError("invalid");
  return inner;
}
