import { env } from "@millionsend/config";
import {
  createMailboxAgentKey,
  createMailboxRegistry,
  deriveInternalActorKey,
  INTERNAL_ACTOR_HEADER,
  listMailboxRegistry,
  MailboxAgentAccessError,
  MailboxRegistryError,
  MailboxServiceError,
  recordAudit,
  setMailboxOAuthClientAccess,
  verifyInternalActor,
  withMailboxRegistryAdmin,
} from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiBaseUrl } from "@/lib/api-base-url";
import { activateMailboxReceiving } from "@/server/mailbox-activation";
import { checkMailboxReadiness, mailboxState } from "@/server/mailbox-readiness";
import { mailboxActorAccessEnabled, mailboxCreateAccessEnabled } from "@/server/mailboxes";

/**
 * Mailbox administration for the MCP server: the API verifies the OAuth user,
 * then calls here on loopback with a signed internal actor (see
 * core/internal-actor). Every ordinary check still runs for that user and
 * team: Correio access, admin role, the seats the license already has (a
 * mailbox is never bought here), and ownership for agent keys. Agent keys
 * minted here never carry the send permission: an agent cannot grant itself
 * the right to send without a person's approval.
 *
 * check reports what a mailbox needs before it is usable (mailbox-readiness.ts).
 * create is safe to repeat: the same address, owner and kind again reconciles the
 * existing mailbox (listing it for receiving) instead of failing or duplicating it,
 * and answers with the same readiness. grant_app / revoke_app add or remove one of
 * the person's mailboxes in the calling OAuth app's own mail grant (read/draft only).
 */
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const APP_SCOPES = z
  .array(z.enum(["read", "draft"]))
  .min(1)
  .max(2);

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("check"),
      domainId: z.uuid(),
      localPart: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      domainId: z.uuid(),
      localPart: z.string().min(1).max(64),
      label: z.string().min(1).max(80),
      kind: z.enum(["person", "agent"]).default("agent"),
      ownerUserId: z.string().min(1).max(128).optional(),
      grantToThisApp: APP_SCOPES.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("create_agent_key"),
      mailboxId: z.uuid(),
      label: z.string().min(1).max(80),
      scopes: z
        .array(z.enum(["read", "draft"]))
        .min(1)
        .max(2)
        .default(["read", "draft"]),
      expiresAt: z.iso.datetime().optional(),
    })
    .strict(),
  z.object({ action: z.literal("grant_app"), mailboxId: z.uuid(), scopes: APP_SCOPES }).strict(),
  z.object({ action: z.literal("revoke_app"), mailboxId: z.uuid() }).strict(),
]);

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: HEADERS });
}

function refusal(error: unknown) {
  if (error instanceof MailboxRegistryError || error instanceof MailboxAgentAccessError) {
    const code = error.code;
    const status =
      code === "not_found"
        ? 404
        : code === "invalid"
          ? 400
          : code === "quota" || code === "conflict"
            ? 409
            : 403;
    return json({ error: code }, status);
  }
  if (error instanceof MailboxServiceError)
    return json({ error: "service", code: error.code }, 409);
  const code = (error as { code?: string } | null)?.code;
  if (code === "sending_plan_required" || code === "early_access_required")
    return json({ error: code }, 403);
  console.error("internal mailbox admin failed", error);
  return json({ error: "unavailable" }, 503);
}

/** The mailbox already at this address in the team, for reconciliation. */
async function existingAt(db: Db, teamId: string, domainId: string, localPart: string) {
  const [domain] = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(and(eq(schema.domains.id, domainId), eq(schema.domains.teamId, teamId)));
  if (!domain) return null;
  const address = `${localPart.trim().toLowerCase()}@${domain.name.toLowerCase()}`;
  const [box] = await db
    .select()
    .from(schema.mailboxes)
    .where(and(eq(schema.mailboxes.address, address), eq(schema.mailboxes.teamId, teamId)));
  const [alias] = box
    ? []
    : await db
        .select({ mailboxId: schema.mailboxAliases.mailboxId })
        .from(schema.mailboxAliases)
        .where(
          and(eq(schema.mailboxAliases.address, address), eq(schema.mailboxAliases.teamId, teamId)),
        );
  return { address, box: box ?? null, alias: alias ?? null };
}

/** What the app's own grant now reaches for this mailbox, audited when it changed. */
async function changeAppAccess(
  db: Db,
  who: { teamId: string; userId: string },
  clientId: string,
  mailboxId: string,
  scopes: ("read" | "draft")[] | null,
) {
  const result = await setMailboxOAuthClientAccess(db, who, { clientId, mailboxId, scopes });
  if (result.changed)
    await recordAudit(db, {
      teamId: who.teamId,
      actor: { userId: who.userId },
      action: "mailbox.team_agent_key_updated",
      target: { type: "mailbox_team_agent_key", id: result.groupId },
      metadata: {
        via: "mcp",
        clientId,
        ...(scopes === null ? { removed: [mailboxId] } : { added: [mailboxId], scopes }),
      },
    });
  return { mailbox_id: mailboxId, scopes: result.scopes, changed: result.changed };
}

const NO_GRANT = {
  error: "no_mail_grant",
  hint: "This app has no mail access yet: the person reconnects it once and ticks at least one mailbox; after that, mailboxes can be added here without reconnecting.",
};

export async function POST(request: Request) {
  if (!env.MASTER_ENCRYPTION_KEY) return new Response(null, { status: 404, headers: HEADERS });
  const actor = verifyInternalActor(
    deriveInternalActorKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64")),
    request.headers.get(INTERNAL_ACTOR_HEADER),
  );
  if (!actor) return json({ error: "unauthorized" }, 401);
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid" }, 400);
  const db = getDb();
  const who = { teamId: actor.teamId, userId: actor.userId };
  try {
    if (!(await mailboxActorAccessEnabled(db, who)))
      return json({ error: "correio_unavailable" }, 403);
    const input = parsed.data;
    if (input.action === "list") {
      const registry = await listMailboxRegistry(db, who);
      const deleting = new Map(
        (
          await db
            .select({ id: schema.mailboxes.id, deleteAfter: schema.mailboxes.deleteAfter })
            .from(schema.mailboxes)
            .where(eq(schema.mailboxes.teamId, who.teamId))
        ).map((row) => [row.id, row.deleteAfter]),
      );
      return json({
        can_manage: registry.canManage,
        status_note:
          "state is what to read: active, suspended or being_deleted. status is the registry's legacy field (planned = active). Receiving and agent access are separate layers: check_mailbox reports them.",
        mailboxes: registry.mailboxes.map((box) => ({
          id: box.id,
          address: box.address,
          label: box.label,
          kind: box.kind,
          state: mailboxState({ status: box.status, deleteAfter: deleting.get(box.id) ?? null }),
          status: box.status,
          domain_id: box.domainId,
          owned_by_you: box.ownerUserId === who.userId,
          can_draft: box.canDraft,
          can_send: box.canSend,
        })),
      });
    }
    if (input.action === "check") {
      const readiness = await checkMailboxReadiness(db, who, {
        domainId: input.domainId,
        localPart: input.localPart,
      });
      return readiness ? json(readiness) : json({ error: "not_found" }, 404);
    }
    if (input.action === "create") {
      const ownerUserId = input.ownerUserId ?? who.userId;
      const reconcile = async () => {
        const found = await existingAt(db, who.teamId, input.domainId, input.localPart);
        if (!found) return { refusal: json({ error: "not_found" }, 404) };
        if (found.alias)
          return { refusal: json({ error: "conflict", reason: "address_is_alias" }, 409) };
        if (!found.box) return null;
        const state = mailboxState(found.box);
        if (
          found.box.ownerUserId !== ownerUserId ||
          found.box.kind !== input.kind ||
          state !== "active"
        )
          return {
            refusal: json(
              {
                error: "conflict",
                reason: state !== "active" ? `mailbox_${state}` : "exists_with_other_settings",
                existing: {
                  mailbox_id: found.box.id,
                  kind: found.box.kind,
                  state,
                  owned_by_you: found.box.ownerUserId === who.userId,
                },
              },
              409,
            ),
          };
        return { box: found.box };
      };
      let reconciled = await reconcile();
      if (reconciled && "refusal" in reconciled) return reconciled.refusal;
      let row: { id: string; address: string; kind: string; domainId: string };
      let created = false;
      if (reconciled?.box) row = reconciled.box;
      else {
        try {
          row = await withMailboxRegistryAdmin(db, who, async (tx) => {
            if (!(await mailboxCreateAccessEnabled(tx, who)))
              throw Object.assign(new Error("correio access"), { code: "sending_plan_required" });
            return createMailboxRegistry(tx, who, {
              domainId: input.domainId,
              localPart: input.localPart,
              label: input.label,
              kind: input.kind,
              ownerUserId,
            });
          });
          created = true;
        } catch (error) {
          // A concurrent create of the same mailbox: reconcile to it. That one may also have
          // taken the last seat, so a seat refusal is rechecked the same way.
          const addressConflict =
            error instanceof MailboxRegistryError && error.code === "conflict";
          if (!addressConflict && !(error instanceof MailboxServiceError)) throw error;
          reconciled = await reconcile();
          if (reconciled && "refusal" in reconciled) return reconciled.refusal;
          if (!reconciled?.box) {
            if (!addressConflict) throw error;
            return json({ error: "conflict", reason: "address_taken" }, 409);
          }
          row = reconciled.box;
        }
        if (created)
          await recordAudit(db, {
            teamId: who.teamId,
            actor: { userId: who.userId },
            action: "mailbox.created",
            target: { type: "mailbox", id: row.id },
            metadata: {
              kind: row.kind,
              domainId: row.domainId,
              via: "mcp",
              ...(actor.clientId ? { clientId: actor.clientId } : {}),
            },
          });
      }
      // Receiving starts once the domain's primary MX is Correio; the same step as the
      // dashboard, repeated on reconcile so an address left unlisted gets listed.
      let receiving: string = "unknown";
      try {
        receiving = (
          await withMailboxRegistryAdmin(db, who, (tx) =>
            activateMailboxReceiving(tx, who, input.domainId),
          )
        ).state;
      } catch (error) {
        console.warn("mcp mailbox receiving activation deferred", error);
      }
      let agentAccess: unknown = null;
      if (input.grantToThisApp) {
        if (!actor.clientId) agentAccess = { granted: false, reason: "oauth_only" };
        else
          try {
            agentAccess = {
              granted: true,
              ...(await changeAppAccess(db, who, actor.clientId, row.id, input.grantToThisApp)),
            };
          } catch (error) {
            agentAccess = {
              granted: false,
              reason:
                error instanceof MailboxAgentAccessError && error.code === "not_found"
                  ? "no_mail_grant"
                  : error instanceof MailboxAgentAccessError
                    ? error.code
                    : "unavailable",
              ...(error instanceof MailboxAgentAccessError && error.code === "not_found"
                ? { hint: NO_GRANT.hint }
                : {}),
            };
          }
      }
      const readiness = await checkMailboxReadiness(db, who, {
        domainId: input.domainId,
        mailboxId: row.id,
      });
      return json({
        id: row.id,
        address: row.address,
        kind: row.kind,
        created,
        reconciled: !created,
        receiving,
        readiness,
        ...(input.grantToThisApp ? { agent_access: agentAccess } : {}),
      });
    }
    if (input.action === "grant_app" || input.action === "revoke_app") {
      if (!actor.clientId) return json({ error: "oauth_only" }, 403);
      try {
        return json(
          await changeAppAccess(
            db,
            who,
            actor.clientId,
            input.mailboxId,
            input.action === "grant_app" ? input.scopes : null,
          ),
        );
      } catch (error) {
        if (error instanceof MailboxAgentAccessError && error.code === "not_found")
          return json(NO_GRANT, 409);
        if (
          error instanceof MailboxAgentAccessError &&
          error.code === "invalid" &&
          input.action === "revoke_app"
        )
          return json(
            {
              error: "last_mailbox",
              hint: "This is the app's last mailbox: revoke the app itself (Settings → Connected apps) to remove all mail access.",
            },
            409,
          );
        throw error;
      }
    }
    const key = await createMailboxAgentKey(db, who, {
      mailboxId: input.mailboxId,
      label: input.label,
      scopes: input.scopes,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
    await recordAudit(db, {
      teamId: who.teamId,
      actor: { userId: who.userId },
      action: "mailbox.agent_key_created",
      target: { type: "mailbox_agent_key", id: key.id },
      metadata: { via: "mcp" },
    });
    const mcpUrl = `${apiBaseUrl()}/mcp/correio`;
    return json({
      id: key.id,
      mailbox_id: key.mailboxId,
      label: key.label,
      scopes: key.scopes,
      expires_at: key.expiresAt,
      token: key.token,
      mcp_url: mcpUrl,
      claude_code_command: `claude mcp add --transport http mepmail-correio ${mcpUrl} --header "Authorization: Bearer ${key.token}"`,
    });
  } catch (error) {
    return refusal(error);
  }
}
