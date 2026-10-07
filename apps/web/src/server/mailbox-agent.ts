import { createHash } from "node:crypto";
import {
  MailboxAgentAccessError,
  type MailboxAgentScope,
  MailboxContentError,
  MailboxServiceError,
  queueMailboxAgentDraft,
  withMailboxAgentAccess,
} from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { getKeyring } from "./keyring";
import { mailboxTransportMime } from "./mailbox-transport";
import { mailboxActorAccessEnabled, mailboxRegistryEnabled } from "./mailboxes";
import { getQueue } from "./queue";

export const MAILBOX_AGENT_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  Vary: "Authorization",
};
export async function mailboxAgentRequest(
  request: Request,
  scope: MailboxAgentScope,
  run: Parameters<typeof withMailboxAgentAccess>[3],
) {
  return mailboxAgentBearerRequest(
    request,
    (token) =>
      withMailboxAgentAccess(getDb(), token, scope, async (context) => {
        if (!(await mailboxActorAccessEnabled(context.db, context.actor)))
          throw new MailboxAgentAccessError("forbidden");
        return run(context);
      }),
    (result) => Response.json(result, { headers: MAILBOX_AGENT_HEADERS }),
  );
}

/** Separate send admission preserves the credential as durable outbox provenance. */
export async function mailboxAgentSendRequest(
  request: Request,
  input: { id: string; expectedRevision: number },
) {
  if (process.env.MAILBOX_TRANSPORT_ENABLED !== "1")
    return new Response(null, { status: 404, headers: MAILBOX_AGENT_HEADERS });
  return mailboxAgentBearerRequest(
    request,
    async (token) => {
      // Verify the credential's current owner/team before capturing any outbox data.
      // Finish this transaction first; admission below revalidates all provenance.
      if (
        process.env.MAILBOX_PILOT_TEAM_IDS !== undefined ||
        process.env.MAILBOX_PILOT_USER_IDS !== undefined ||
        process.env.MAILBOX_EARLY_ACCESS_COHORT !== undefined
      )
        await withMailboxAgentAccess(getDb(), token, "send", async (context) => {
          if (!(await mailboxActorAccessEnabled(context.db, context.actor)))
            throw new MailboxAgentAccessError("forbidden");
        });
      const result = await queueMailboxAgentDraft(
        getDb(),
        getKeyring(),
        token,
        input,
        mailboxTransportMime,
      );
      // Capture commits before enqueue. Reconcile repairs enqueue failures using only this ID.
      if (result.status === "queued")
        await (await getQueue()).send(
          "mailbox.send",
          { outboxId: result.id },
          { dedupeKey: result.id },
        );
      return result;
    },
    (result) =>
      Response.json(result, {
        status: result.duplicate ? 200 : 202,
        headers: MAILBOX_AGENT_HEADERS,
      }),
  );
}

// Per-credential fixed window, before any database work. One Web process serves the
// API, so process memory is the shared counter; restarts only reset the window.
const RATE_WINDOW_MS = 60_000;
const agentWindows = new Map<string, { start: number; count: number }>();
function agentRateLimit(token: string, now = Date.now()): number | null {
  const parsed = Number(process.env.MAILBOX_AGENT_RATE_LIMIT_PER_MINUTE);
  const limit = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 120;
  const start = now - (now % RATE_WINDOW_MS);
  if (agentWindows.size > 10_000)
    for (const [key, value] of agentWindows) if (value.start !== start) agentWindows.delete(key);
  // Only a digest of the credential is kept in memory.
  const key = createHash("sha256").update(token).digest("base64url");
  const current = agentWindows.get(key);
  const count = current?.start === start ? current.count + 1 : 1;
  agentWindows.set(key, { start, count });
  return count > limit ? Math.max(1, Math.ceil((start + RATE_WINDOW_MS - now) / 1000)) : null;
}

async function mailboxAgentBearerRequest<T>(
  request: Request,
  run: (token: string) => Promise<T>,
  respond: (result: T) => Response,
) {
  if (!mailboxRegistryEnabled())
    return new Response(null, { status: 404, headers: MAILBOX_AGENT_HEADERS });
  const match = /^Bearer (mmb_[A-Za-z0-9_.-]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match)
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: MAILBOX_AGENT_HEADERS },
    );
  const retryAfter = agentRateLimit(match[1]!);
  if (retryAfter !== null)
    return Response.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { ...MAILBOX_AGENT_HEADERS, "Retry-After": String(retryAfter) },
      },
    );
  try {
    return respond(await run(match[1]!));
  } catch (error) {
    const status =
      error instanceof MailboxAgentAccessError
        ? 403
        : error instanceof MailboxServiceError
          ? 409
          : error instanceof MailboxContentError
            ? error.code === "not_found"
              ? 404
              : error.code === "conflict"
                ? 409
                : error.code === "invalid"
                  ? 400
                  : 403
            : 503;
    return Response.json(
      { error: status === 503 ? "unavailable" : status === 409 ? "conflict" : "access_denied" },
      { status, headers: MAILBOX_AGENT_HEADERS },
    );
  }
}
