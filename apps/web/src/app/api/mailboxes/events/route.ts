import {
  arrivalEvent,
  readableMailboxIds,
  subscribeMailboxArrivals,
} from "@/server/mailbox-events";
import { mailboxActorAccessEnabled, mailboxRegistryEnabled } from "@/server/mailboxes";
import { createContext } from "@/server/trpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PING_MS = 25_000;
const REFRESH_MS = 60_000;
/** A stream lasts this long; the browser reconnects and the session is checked again. */
const LIFETIME_MS = 10 * 60_000;

/**
 * Live updates for the Correio (server-sent events): "arrival" with the
 * mailbox id whenever one this person reads receives mail. The page then
 * refreshes its counts and list at once. No content travels here.
 */
export async function GET(request: Request) {
  const empty = (status: number) =>
    new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  if (!mailboxRegistryEnabled()) return empty(404);
  const ctx = await createContext({ headers: request.headers });
  if (!ctx.session) return empty(401);
  if (!ctx.teamId || !ctx.role || ctx.supportView) return empty(403);
  const actor = { teamId: ctx.teamId, userId: ctx.session.user.id };
  if (!(await mailboxActorAccessEnabled(ctx.db, actor))) return empty(404);
  let readable = await readableMailboxIds(ctx.db, actor);

  const encoder = new TextEncoder();
  let close: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          finish();
        }
      };
      let unsubscribe: (() => void) | null = null;
      const ping = setInterval(() => send(": ping\n\n"), PING_MS);
      const refresh = setInterval(() => {
        readableMailboxIds(ctx.db, actor)
          .then((ids) => {
            readable = ids;
          })
          .catch(() => {});
      }, REFRESH_MS);
      const lifetime = setTimeout(() => finish(), LIFETIME_MS);
      function finish() {
        if (!open) return;
        open = false;
        clearInterval(ping);
        clearInterval(refresh);
        clearTimeout(lifetime);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
      close = finish;
      request.signal.addEventListener("abort", finish);
      // Reconnect after 5 s when the stream ends; say hello so proxies flush the headers.
      send("retry: 5000\n: connected\n\n");
      try {
        unsubscribe = await subscribeMailboxArrivals((arrival) => {
          if (arrival.teamId === actor.teamId && readable.has(arrival.mailboxId))
            send(arrivalEvent(arrival.mailboxId));
        });
        if (!open) unsubscribe();
      } catch {
        // No live channel (database unreachable): the page keeps polling.
        finish();
      }
    },
    cancel() {
      close?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
