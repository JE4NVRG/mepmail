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
import { mailboxAccessEnabled, mailboxRegistryEnabled } from "./mailboxes";
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
      withMailboxAgentAccess(getDb(), token, scope, (context) => {
        if (!mailboxAccessEnabled(context.actor)) throw new MailboxAgentAccessError("forbidden");
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
        process.env.MAILBOX_PILOT_USER_IDS !== undefined
      )
        await withMailboxAgentAccess(getDb(), token, "send", (context) => {
          if (!mailboxAccessEnabled(context.actor)) throw new MailboxAgentAccessError("forbidden");
          return Promise.resolve();
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
