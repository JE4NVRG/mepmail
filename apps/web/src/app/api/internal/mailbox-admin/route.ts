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
  verifyInternalActor,
  withMailboxRegistryAdmin,
} from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { z } from "zod";
import { apiBaseUrl } from "@/lib/api-base-url";
import { activateMailboxReceiving } from "@/server/mailbox-activation";
import { mailboxActorAccessEnabled, mailboxCreateAccessEnabled } from "@/server/mailboxes";

/**
 * Mailbox administration for the MCP server: the API verifies the OAuth user,
 * then calls here on loopback with a signed internal actor (see
 * core/internal-actor). Every ordinary check still runs for that user and
 * team: Correio access, admin role, the seats the license already has (a
 * mailbox is never bought here), and ownership for agent keys. Agent keys
 * minted here never carry the send permission: an agent cannot grant itself
 * the right to send without a person's approval.
 */
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("create"),
      domainId: z.uuid(),
      localPart: z.string().min(1).max(64),
      label: z.string().min(1).max(80),
      kind: z.enum(["person", "agent"]).default("agent"),
      ownerUserId: z.string().min(1).max(128).optional(),
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
      return json({
        can_manage: registry.canManage,
        mailboxes: registry.mailboxes.map((box) => ({
          id: box.id,
          address: box.address,
          label: box.label,
          kind: box.kind,
          status: box.status,
          domain_id: box.domainId,
          owned_by_you: box.ownerUserId === who.userId,
          can_draft: box.canDraft,
          can_send: box.canSend,
        })),
      });
    }
    if (input.action === "create") {
      const row = await withMailboxRegistryAdmin(db, who, async (tx) => {
        if (!(await mailboxCreateAccessEnabled(tx, who)))
          throw Object.assign(new Error("correio access"), { code: "sending_plan_required" });
        return createMailboxRegistry(tx, who, {
          domainId: input.domainId,
          localPart: input.localPart,
          label: input.label,
          kind: input.kind,
          ownerUserId: input.ownerUserId ?? who.userId,
        });
      });
      await recordAudit(db, {
        teamId: who.teamId,
        actor: { userId: who.userId },
        action: "mailbox.created",
        target: { type: "mailbox", id: row.id },
        metadata: { kind: row.kind, domainId: row.domainId, via: "mcp" },
      });
      // Receiving starts once the domain's MX points at SES; the same step as the dashboard.
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
      return json({ id: row.id, address: row.address, kind: row.kind, receiving });
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
