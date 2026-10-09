import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A short-lived, signed statement of who is acting, for one process of this
 * deployment calling another on loopback (the MCP server in the API asking the
 * dashboard to run a mailbox operation for a verified OAuth user). Both
 * processes derive the same key from MASTER_ENCRYPTION_KEY; nothing outside
 * the deployment can mint one. The receiving side still runs every ordinary
 * authorization check for that user and team.
 */
export interface InternalActor {
  teamId: string;
  userId: string;
  /** The OAuth client the token was issued to, when the call acts through that client's grant. */
  clientId?: string;
  /** Unix seconds after which the statement is refused. */
  exp: number;
}

export const INTERNAL_ACTOR_HEADER = "x-mepmail-internal-actor";
const TTL_SECONDS = 60;

/** The HMAC key, kept apart from every other key derived from the master key. */
export function deriveInternalActorKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("mepmail/internal-actor/v1").digest();
}

function signature(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** `<payload>.<signature>`, both base64url. */
export function signInternalActor(
  key: Buffer,
  actor: { teamId: string; userId: string; clientId?: string | undefined },
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      teamId: actor.teamId,
      userId: actor.userId,
      ...(actor.clientId ? { clientId: actor.clientId } : {}),
      exp: Math.floor(now / 1000) + TTL_SECONDS,
    }),
  ).toString("base64url");
  return `${payload}.${signature(key, payload)}`;
}

/** The actor a header vouches for, or null when it is malformed, forged or expired. */
export function verifyInternalActor(
  key: Buffer,
  header: string | null | undefined,
  now = Date.now(),
): InternalActor | null {
  if (!header || header.length > 2048) return null;
  const [payload, sig, extra] = header.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(signature(key, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const actor = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as InternalActor;
    if (
      typeof actor.teamId !== "string" ||
      typeof actor.userId !== "string" ||
      typeof actor.exp !== "number" ||
      actor.exp < Math.floor(now / 1000) ||
      (actor.clientId !== undefined && typeof actor.clientId !== "string")
    )
      return null;
    return {
      teamId: actor.teamId,
      userId: actor.userId,
      ...(actor.clientId ? { clientId: actor.clientId } : {}),
      exp: actor.exp,
    };
  } catch {
    return null;
  }
}
