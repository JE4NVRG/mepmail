import { resolveSenderPicture } from "@/server/mailbox-sender-logo";
import { readSenderPictureToken } from "@/server/mailbox-sender-picture";
import { mailboxActorAccessEnabled, mailboxRegistryEnabled } from "@/server/mailboxes";
import { createContext } from "@/server/trpc";

export const runtime = "nodejs";

/** The image never runs anything here, even opened on its own (SVG included). */
const IMAGE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  Vary: "Cookie",
};

/** Uncached lookups one person may start per minute (cache hits are free). */
const LOOKUPS_PER_MINUTE = 30;
const lookups = new Map<string, { window: number; count: number }>();

function takeLookup(userId: string): boolean {
  const window = Math.floor(Date.now() / 60_000);
  const entry = lookups.get(userId);
  if (!entry || entry.window !== window) {
    lookups.set(userId, { window, count: 1 });
    if (lookups.size > 10_000) lookups.clear();
    return true;
  }
  if (entry.count >= LOOKUPS_PER_MINUTE) return false;
  entry.count++;
  return true;
}

/**
 * GET /api/mailboxes/sender-logo?t=<token> — a sender's picture for the Correio list and
 * reader. The token is signed by the server while listing a message that passed DMARC
 * (server/mailbox-sender-picture.ts); a domain the browser names is never fetched. Only
 * for signed-in members with Correio access; the browser keeps the answer for a day (a
 * miss for six hours).
 */
export async function GET(request: Request) {
  const empty = (status: number, maxAge = 0) =>
    new Response(null, {
      status,
      headers: {
        ...IMAGE_HEADERS,
        "Cache-Control": maxAge ? `private, max-age=${maxAge}` : "private, no-store",
      },
    });
  if (!mailboxRegistryEnabled()) return empty(404);
  try {
    const ctx = await createContext({ headers: request.headers });
    if (!ctx.session) return empty(401);
    if (!ctx.teamId || !ctx.role) return empty(403);
    const userId = ctx.session.user.id;
    if (!(await mailboxActorAccessEnabled(ctx.db, { teamId: ctx.teamId, userId })))
      return empty(404);
    const grant = readSenderPictureToken(new URL(request.url).searchParams.get("t") ?? "");
    if (!grant) return empty(404);
    const { logo, limited } = await resolveSenderPicture(grant, {
      budget: () => takeLookup(userId),
    });
    if (limited) return empty(429);
    if (!logo) return empty(404, 6 * 3600);
    return new Response(new Uint8Array(logo.body), {
      status: 200,
      headers: {
        ...IMAGE_HEADERS,
        "Content-Type": logo.contentType,
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return empty(500);
  }
}
