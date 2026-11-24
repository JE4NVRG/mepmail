import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  apiRequestActor,
  createMailboxAgentKey,
  createMailboxRegistry,
  MailboxAgentAccessError,
  MailboxRegistryError,
  MailboxServiceError,
  recordAudit,
  requestMailboxDeletion,
  updateMailboxRegistry,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { type Env, errorBody, keysetPage } from "../app.js";
import {
  createInboxKeyRequestSchema,
  createInboxRequestSchema,
  createInboxResponseSchema,
  errorSchema,
  getInboxResponseSchema,
  inboxIdResponseSchema,
  inboxKeyResponseSchema,
  listInboxesResponseSchema,
  listQuerySchema,
  removeInboxResponseSchema,
  updateInboxRequestSchema,
} from "../schemas.js";

async function resolveTeamOwnerActor(db: Db, teamId: string): Promise<string | null> {
  const members = await db
    .select({
      userId: schema.teamMembers.userId,
      role: schema.teamMembers.role,
      verified: schema.user.emailVerified,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
    .where(eq(schema.teamMembers.teamId, teamId))
    .orderBy(asc(schema.teamMembers.createdAt));
  const preferred =
    members.find((m) => m.role === "owner" && m.verified) ??
    members.find((m) => m.role === "owner") ??
    members.find((m) => m.role === "admin" && m.verified) ??
    members.find((m) => m.role === "admin");
  return preferred?.userId ?? null;
}

function mapMailboxError(err: unknown) {
  if (err instanceof MailboxRegistryError) {
    if (err.code === "not_found") return errorBody(404, "not_found", "Inbox or domain not found");
    if (err.code === "conflict") return errorBody(409, "conflict", "Inbox address already exists");
    if (err.code === "forbidden")
      return errorBody(403, "forbidden", "Mailbox creation or access is not allowed for this team");
    return errorBody(422, "validation_error", "Invalid inbox parameters");
  }
  if (err instanceof MailboxServiceError) {
    return errorBody(403, err.code, "Active Mail plan or seat limit reached");
  }
  if (err instanceof MailboxAgentAccessError) {
    if (err.code === "not_found") return errorBody(404, "not_found", "Inbox not found");
    if (err.code === "quota")
      return errorBody(422, "validation_error", "Maximum active agent keys reached for this inbox");
    if (err.code === "forbidden")
      return errorBody(403, "forbidden", "Cannot mint keys for an inactive inbox");
    return errorBody(422, "validation_error", "Invalid inbox key parameters");
  }
  return null;
}

/** Public programmatic Mail inbox provisioning API (`/inboxes`, alias `/v1/inboxes`). */
export function registerInboxRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.uuid() });
  const m = schema.mailboxes;
  const wire = (row: typeof m.$inferSelect) => ({
    id: row.id,
    address: row.address,
    label: row.label,
    kind: row.kind,
    domain_id: row.domainId,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes",
      request: {
        body: { content: { "application/json": { schema: createInboxRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: createInboxResponseSchema } },
          description: "Inbox provisioned (optionally with an mmb_ agent token)",
        },
        403: jsonErr("Mail plan required, seat limit reached, or restricted key"),
        404: jsonErr("Domain not found"),
        409: jsonErr("Inbox address already exists"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      let localPart = body.local_part?.trim().toLowerCase() ?? "";
      let domainName = body.domain?.trim().toLowerCase();
      if (body.address) {
        const at = body.address.lastIndexOf("@");
        localPart = body.address.slice(0, at).trim().toLowerCase();
        domainName = body.address
          .slice(at + 1)
          .trim()
          .toLowerCase();
      }
      if (!localPart) {
        return c.json(errorBody(422, "validation_error", "Provide address or local_part"), 422);
      }

      let domainRow: { id: string; name: string } | undefined;
      if (body.domain_id) {
        [domainRow] = await db
          .select({ id: schema.domains.id, name: schema.domains.name })
          .from(schema.domains)
          .where(
            and(eq(schema.domains.id, body.domain_id), eq(schema.domains.teamId, auth.teamId)),
          );
      } else if (domainName) {
        [domainRow] = await db
          .select({ id: schema.domains.id, name: schema.domains.name })
          .from(schema.domains)
          .where(and(eq(schema.domains.name, domainName), eq(schema.domains.teamId, auth.teamId)));
      } else {
        const domains = await db
          .select({
            id: schema.domains.id,
            name: schema.domains.name,
            status: schema.domains.status,
          })
          .from(schema.domains)
          .where(eq(schema.domains.teamId, auth.teamId))
          .orderBy(asc(schema.domains.createdAt));
        domainRow = domains.find((d) => d.status === "verified") ?? domains[0];
      }
      if (!domainRow) {
        return c.json(errorBody(404, "not_found", "Sending domain not found on this team"), 404);
      }
      if (auth.domainId && auth.domainId !== domainRow.id) {
        return c.json(
          errorBody(403, "restricted_api_key", "API key is scoped to another domain"),
          403,
        );
      }

      const ownerUserId = await resolveTeamOwnerActor(db, auth.teamId);
      if (!ownerUserId) {
        return c.json(errorBody(403, "forbidden", "Team has no eligible admin/owner member"), 403);
      }
      const actor = { teamId: auth.teamId, userId: ownerUserId };
      try {
        const row = await createMailboxRegistry(db, actor, {
          domainId: domainRow.id,
          localPart,
          label: body.label?.trim() || localPart,
          kind: body.kind,
          ownerUserId,
          signatureText: body.signature_text,
        });
        await recordAudit(db, {
          teamId: auth.teamId,
          actor: apiRequestActor(auth),
          action: "mailbox.created",
          target: { type: "mailbox", id: row.id },
          metadata: { kind: row.kind, domainId: row.domainId, via: "api" },
        });

        let key: { id: string; token: string; scopes: ("read" | "draft" | "send")[] } | null = null;
        if (body.create_key) {
          const issued = await createMailboxAgentKey(db, actor, {
            mailboxId: row.id,
            label: body.key_label?.trim() || `${row.label} API key`,
            scopes: body.key_scopes ?? ["read", "draft", "send"],
          });
          key = { id: issued.id, token: issued.token, scopes: issued.scopes };
        }
        return c.json(
          {
            object: "inbox" as const,
            ...wire(row),
            signature_text: row.signatureText,
            key,
          },
          200,
        );
      } catch (err) {
        const mapped = mapMailboxError(err);
        if (mapped) return c.json(mapped, mapped.statusCode as 403 | 404 | 409 | 422);
        throw err;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes",
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listInboxesResponseSchema } },
          description: "Team domain inboxes",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: m.createdAt,
        id: m.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: m.createdAt, id: m.id })
              .from(m)
              .where(and(eq(m.id, id), eq(m.teamId, auth.teamId), eq(m.origin, "domain")))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(m)
            .where(and(eq(m.teamId, auth.teamId), eq(m.origin, "domain"), cond))
            .orderBy(
              ...(descending ? [desc(m.createdAt), desc(m.id)] : [asc(m.createdAt), asc(m.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(
          errorBody(
            422,
            "validation_error",
            "invalid pagination cursor: after and before take the id of an item this list returned",
          ),
          422,
        );
      }
      return c.json(
        { object: "list" as const, data: page.rows.map(wire), has_more: page.hasMore },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: getInboxResponseSchema } },
          description: "Inbox details",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const [row] = await db
        .select()
        .from(m)
        .where(and(eq(m.id, id), eq(m.teamId, auth.teamId), eq(m.origin, "domain")));
      if (!row) return c.json(errorBody(404, "not_found", "Inbox not found"), 404);
      return c.json(
        {
          object: "inbox" as const,
          ...wire(row),
          signature_text: row.signatureText,
          delete_after: row.deleteAfter?.toISOString() ?? null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/inboxes/{id}",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: updateInboxRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: inboxIdResponseSchema } },
          description: "Inbox updated",
        },
        403: jsonErr("Forbidden"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const [existing] = await db
        .select()
        .from(m)
        .where(and(eq(m.id, id), eq(m.teamId, auth.teamId), eq(m.origin, "domain")));
      if (!existing) return c.json(errorBody(404, "not_found", "Inbox not found"), 404);
      const ownerUserId = await resolveTeamOwnerActor(db, auth.teamId);
      if (!ownerUserId) return c.json(errorBody(403, "forbidden", "No eligible team owner"), 403);
      try {
        await updateMailboxRegistry(
          db,
          { teamId: auth.teamId, userId: ownerUserId },
          {
            id,
            label: body.label ?? existing.label,
            ownerUserId: existing.ownerUserId ?? ownerUserId,
            status: body.status ?? existing.status,
            ...(body.signature_text !== undefined ? { signatureText: body.signature_text } : {}),
          },
        );
        await recordAudit(db, {
          teamId: auth.teamId,
          actor: apiRequestActor(auth),
          action: "mailbox.updated",
          target: { type: "mailbox", id },
        });
        return c.json({ object: "inbox" as const, id }, 200);
      } catch (err) {
        const mapped = mapMailboxError(err);
        if (mapped) return c.json(mapped, mapped.statusCode as 403 | 404 | 422);
        throw err;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/inboxes/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeInboxResponseSchema } },
          description: "Inbox scheduled for deletion and suspended immediately",
        },
        403: jsonErr("Forbidden"),
        404: jsonErr("Not found"),
        409: jsonErr("Already scheduled for deletion"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const [existing] = await db
        .select({ address: m.address })
        .from(m)
        .where(and(eq(m.id, id), eq(m.teamId, auth.teamId), eq(m.origin, "domain")));
      if (!existing) return c.json(errorBody(404, "not_found", "Inbox not found"), 404);
      const ownerUserId = await resolveTeamOwnerActor(db, auth.teamId);
      if (!ownerUserId) return c.json(errorBody(403, "forbidden", "No eligible team owner"), 403);
      try {
        const res = await requestMailboxDeletion(
          db,
          { teamId: auth.teamId, userId: ownerUserId },
          { id, address: existing.address },
        );
        await recordAudit(db, {
          teamId: auth.teamId,
          actor: apiRequestActor(auth),
          action: "mailbox.deletion_requested",
          target: { type: "mailbox", id },
        });
        return c.json(
          {
            object: "inbox" as const,
            id: res.id,
            deleted: true as const,
            delete_after: res.deleteAfter.toISOString(),
          },
          200,
        );
      } catch (err) {
        const mapped = mapMailboxError(err);
        if (mapped) return c.json(mapped, mapped.statusCode as 403 | 404 | 409);
        throw err;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes/{id}/keys",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: createInboxKeyRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: inboxKeyResponseSchema } },
          description: "Agent key minted for this inbox; token is returned only here",
        },
        403: jsonErr("Forbidden"),
        404: jsonErr("Inbox not found"),
        422: jsonErr("Validation error or active key cap reached"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const ownerUserId = await resolveTeamOwnerActor(db, auth.teamId);
      if (!ownerUserId) return c.json(errorBody(403, "forbidden", "No eligible team owner"), 403);
      try {
        const issued = await createMailboxAgentKey(
          db,
          { teamId: auth.teamId, userId: ownerUserId },
          {
            mailboxId: id,
            label: body.label,
            scopes: body.scopes,
            expiresAt: body.expires_at ? new Date(body.expires_at) : null,
          },
        );
        await recordAudit(db, {
          teamId: auth.teamId,
          actor: apiRequestActor(auth),
          action: "mailbox.agent_key_created",
          target: { type: "mailbox_agent_key", id: issued.id },
          metadata: { mailboxId: id, via: "api" },
        });
        return c.json(
          {
            object: "inbox_key" as const,
            id: issued.id,
            inbox_id: issued.mailboxId,
            label: issued.label,
            scopes: issued.scopes,
            token: issued.token,
            expires_at: issued.expiresAt?.toISOString() ?? null,
          },
          200,
        );
      } catch (err) {
        const mapped = mapMailboxError(err);
        if (mapped) return c.json(mapped, mapped.statusCode as 403 | 404 | 422);
        throw err;
      }
    },
  );
}
