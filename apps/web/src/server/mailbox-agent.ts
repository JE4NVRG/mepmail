import { createHash } from "node:crypto";
import { accountEmailFrom, env } from "@millionsend/config";
import {
  accountLocale,
  appendMailboxActivity,
  claimNotification,
  deriveInternalActorKey,
  INTERNAL_ACTOR_HEADER,
  MailboxAgentAccessError,
  type MailboxAgentCredential,
  type MailboxAgentScope,
  MailboxContentError,
  type MailboxSelector,
  MailboxServiceError,
  parseMailboxSelector,
  queueMailboxAgentDraft,
  verifyInternalActor,
  withMailboxAgentAccess,
} from "@millionsend/core";
import { getDb, schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { getKeyring } from "./keyring";
import { mailboxTransportMime } from "./mailbox-transport";
import { mailboxActorAccessEnabled, mailboxRegistryEnabled } from "./mailboxes";
import { getQueue } from "./queue";
import { buildAccountEmail, sendAccountMail } from "./system-mail";

export const MAILBOX_AGENT_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  Vary: "Authorization, MepMail-Mailbox",
};

/**
 * The mailbox a call is for, from the MepMail-Mailbox header (id or address). A team
 * credential (mmt_) needs it unless it has a default; a mailbox key needs none.
 */
export const MAILBOX_SELECTOR_HEADER = "mepmail-mailbox";
function mailboxSelector(request: Request): MailboxSelector | null {
  return parseMailboxSelector(request.headers.get(MAILBOX_SELECTOR_HEADER));
}
export async function mailboxAgentRequest(
  request: Request,
  scope: MailboxAgentScope,
  run: Parameters<typeof withMailboxAgentAccess>[3],
) {
  return mailboxAgentBearerRequest(
    request,
    (token) =>
      withMailboxAgentAccess(
        getDb(),
        token,
        scope,
        async (context) => {
          if (!(await mailboxActorAccessEnabled(context.db, context.actor)))
            throw new MailboxAgentAccessError("forbidden");
          return run(context);
        },
        mailboxSelector(request),
      ),
    (result) => Response.json(result, { headers: MAILBOX_AGENT_HEADERS }),
  );
}

/** Any bearer-authenticated agent call that needs the raw credential (account listing). */
export function mailboxAgentTokenRequest<T>(
  request: Request,
  run: (credential: MailboxAgentCredential) => Promise<T>,
) {
  return mailboxAgentBearerRequest(request, run, (result) =>
    Response.json(result, { headers: MAILBOX_AGENT_HEADERS }),
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
      let result: Awaited<ReturnType<typeof queueMailboxAgentDraft>>;
      try {
        // Verify the credential's current owner/team before capturing any outbox data.
        // Finish this transaction first; admission below revalidates all provenance.
        if (
          process.env.MAILBOX_PILOT_TEAM_IDS !== undefined ||
          process.env.MAILBOX_PILOT_USER_IDS !== undefined ||
          process.env.MAILBOX_EARLY_ACCESS_COHORT !== undefined
        )
          await withMailboxAgentAccess(
            getDb(),
            token,
            "send",
            async (context) => {
              if (!(await mailboxActorAccessEnabled(context.db, context.actor)))
                throw new MailboxAgentAccessError("forbidden");
            },
            mailboxSelector(request),
          );
        result = await queueMailboxAgentDraft(
          getDb(),
          getKeyring(),
          token,
          input,
          mailboxTransportMime,
          undefined,
          mailboxSelector(request),
        );
      } catch (error) {
        // A key without the send permission asks the mailbox owner instead.
        if (error instanceof MailboxAgentAccessError && error.code === "forbidden") {
          const requested = await requestMailboxSendApproval(
            token,
            input,
            mailboxSelector(request),
          );
          if (requested) return requested;
        }
        throw error;
      }
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

/** Owner notices about approval requests: at most one per mailbox in this window. */
const APPROVAL_NOTICE_WINDOW_MS = 10 * 60_000;

/**
 * The human-approval path: a key that may draft but not send records that the
 * agent asks the owner to send this exact revision (the mailbox activity, once
 * per revision) and the owner is mailed. The draft then waits in the dashboard,
 * where the owner sends it, edits it or deletes it. Null when the key does
 * carry the send permission, so the original refusal stands.
 */
async function requestMailboxSendApproval(
  token: MailboxAgentCredential,
  input: { id: string; expectedRevision: number },
  mailbox: MailboxSelector | null,
) {
  const facts = await withMailboxAgentAccess(
    getDb(),
    token,
    "draft",
    async (context) => {
      if (!(await mailboxActorAccessEnabled(context.db, context.actor)))
        throw new MailboxAgentAccessError("forbidden");
      const [key] = await context.db
        .select({ label: schema.mailboxAgentKeys.label, scopes: schema.mailboxAgentKeys.scopes })
        .from(schema.mailboxAgentKeys)
        .where(eq(schema.mailboxAgentKeys.id, context.keyId));
      if (!key || key.scopes.includes("send")) return null;
      const [item] = await context.db
        .select({
          kind: schema.mailboxItems.kind,
          revision: schema.mailboxItems.revision,
          trashedAt: schema.mailboxItems.trashedAt,
        })
        .from(schema.mailboxItems)
        .where(
          and(
            eq(schema.mailboxItems.id, input.id),
            eq(schema.mailboxItems.mailboxId, context.mailboxId),
            eq(schema.mailboxItems.teamId, context.actor.teamId),
          ),
        );
      if (!item || item.kind !== "draft" || item.trashedAt)
        throw new MailboxContentError("not_found");
      if (item.revision !== input.expectedRevision) throw new MailboxContentError("conflict");
      const [prior] = await context.db
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.teamId, context.actor.teamId),
            eq(schema.auditLog.target, `mailbox:${context.mailboxId}`),
            eq(schema.auditLog.action, "mailbox.send_requested"),
            sql`${schema.auditLog.data}->>'itemId' = ${input.id}`,
            sql`${schema.auditLog.data}->>'revision' = ${String(input.expectedRevision)}`,
          ),
        )
        .limit(1);
      if (!prior)
        await appendMailboxActivity(
          context.db,
          {
            teamId: context.actor.teamId,
            mailboxId: context.mailboxId,
            actor: { kind: "mailbox_agent", keyId: context.keyId },
          },
          { action: "mailbox.send_requested", itemId: input.id, revision: input.expectedRevision },
        );
      const [box] = await context.db
        .select({ address: schema.mailboxes.address, ownerEmail: schema.user.email })
        .from(schema.mailboxes)
        .innerJoin(schema.user, eq(schema.user.id, schema.mailboxes.ownerUserId))
        .where(eq(schema.mailboxes.id, context.mailboxId));
      return {
        teamId: context.actor.teamId,
        mailboxId: context.mailboxId,
        agent: key.label,
        duplicate: !!prior,
        address: box?.address ?? null,
        ownerEmail: box?.ownerEmail ?? null,
      };
    },
    mailbox,
  );
  if (!facts) return null;
  if (!facts.duplicate && facts.ownerEmail && facts.address) {
    // Best-effort notice, outside the authorization transaction.
    try {
      const db = getDb();
      const window = Math.floor(Date.now() / APPROVAL_NOTICE_WINDOW_MS);
      if (
        await claimNotification(db, {
          teamId: facts.teamId,
          kind: `mailbox.send_requested:${facts.mailboxId}`,
          periodKey: String(window),
        })
      ) {
        sendAccountMail(
          buildAccountEmail({
            to: facts.ownerEmail,
            kind: "mailbox.send_requested",
            locale: await accountLocale(db, accountEmailFrom(), facts.ownerEmail),
            path: "/mail",
            values: { agent: facts.agent, mailbox: facts.address },
          }),
        );
      }
    } catch (error) {
      console.error("mailbox approval notice skipped", error);
    }
  }
  return {
    status: "awaiting_approval" as const,
    id: input.id,
    revision: input.expectedRevision,
    duplicate: facts.duplicate,
  };
}

// Per-credential fixed window, before any database work. One Web process serves the
// API, so process memory is the shared counter; restarts only reset the window.
const RATE_WINDOW_MS = 60_000;
const agentWindows = new Map<string, { start: number; count: number }>();
function agentRateLimit(credential: MailboxAgentCredential, now = Date.now()): number | null {
  const token =
    typeof credential === "string"
      ? credential
      : `oauth:${credential.oauth.teamId}:${credential.oauth.userId}:${credential.oauth.clientId}`;
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

/**
 * The credential a call carries: a bearer agent key (mmb_ one mailbox, mmt_ several), or,
 * from the MCP server in the API on loopback, a signed internal actor naming the OAuth
 * user, team and client whose consent granted mail. Nothing else authenticates here.
 */
function agentCredential(request: Request): MailboxAgentCredential | null {
  const match = /^Bearer (mm[bt]_[A-Za-z0-9_.-]+)$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (match) return match[1]!;
  const header = request.headers.get(INTERNAL_ACTOR_HEADER);
  if (!header || !env.MASTER_ENCRYPTION_KEY) return null;
  const actor = verifyInternalActor(
    deriveInternalActorKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64")),
    header,
  );
  if (!actor?.clientId) return null;
  return { oauth: { teamId: actor.teamId, userId: actor.userId, clientId: actor.clientId } };
}

async function mailboxAgentBearerRequest<T>(
  request: Request,
  run: (credential: MailboxAgentCredential) => Promise<T>,
  respond: (result: T) => Response,
) {
  if (!mailboxRegistryEnabled())
    return new Response(null, { status: 404, headers: MAILBOX_AGENT_HEADERS });
  const credential = agentCredential(request);
  if (!credential)
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: MAILBOX_AGENT_HEADERS },
    );
  const retryAfter = agentRateLimit(credential);
  if (retryAfter !== null)
    return Response.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { ...MAILBOX_AGENT_HEADERS, "Retry-After": String(retryAfter) },
      },
    );
  try {
    return respond(await run(credential));
  } catch (error) {
    // A team credential with several mailboxes and no default must name one.
    if (error instanceof MailboxAgentAccessError && error.code === "mailbox_required")
      return Response.json(
        { error: "mailbox_required" },
        { status: 400, headers: MAILBOX_AGENT_HEADERS },
      );
    if (error instanceof MailboxAgentAccessError && error.code === "invalid")
      return Response.json({ error: "invalid" }, { status: 400, headers: MAILBOX_AGENT_HEADERS });
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
