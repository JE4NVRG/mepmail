import { env } from "@millionsend/config";
import { apiKeyIssuanceMessage, issueApiKey } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { adminProcedure, router, teamProcedure } from "../trpc";

export const apiKeysRouter = router({
  list: teamProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        tokenPrefix: schema.apiKeys.tokenPrefix,
        last4: schema.apiKeys.last4,
        permission: schema.apiKeys.permission,
        domainId: schema.apiKeys.domainId,
        // Null when the key is not domain-scoped (any verified domain).
        domainName: schema.domains.name,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .leftJoin(schema.domains, eq(schema.apiKeys.domainId, schema.domains.id))
      .where(and(eq(schema.apiKeys.teamId, ctx.teamId), isNull(schema.apiKeys.revokedAt)))
      .orderBy(desc(schema.apiKeys.createdAt));
    return rows;
  }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(80),
        permission: z.enum(schema.apiKeyPermissionEnum.enumValues).default("full_access"),
        // Null/omitted = any verified domain; a uuid scopes the key to one domain.
        domainId: z.uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const issued = await issueApiKey(ctx.db, {
        teamId: ctx.teamId,
        name: input.name,
        permission: input.permission,
        domainId: input.domainId ?? null,
        isCloud: env.IS_CLOUD,
      });
      if (!issued.allowed) {
        throw new TRPCError({
          code:
            issued.reason === "invalid_domain"
              ? "BAD_REQUEST"
              : issued.reason === "active_key_limit" || issued.reason === "signup_sandbox_key_limit"
                ? "PRECONDITION_FAILED"
                : issued.reason === "team_missing"
                  ? "NOT_FOUND"
                  : "FORBIDDEN",
          message: apiKeyIssuanceMessage(issued.reason),
        });
      }
      await recordAudit(ctx, {
        action: "api_key.created",
        target: { type: "api_key", id: issued.id },
        metadata: {
          name: input.name.trim(),
          permission: input.permission,
          domainId: input.domainId ?? null,
        },
      });
      // The full secret exists only in this response — the row stores
      // tokenPrefix + hash + last4, and no other code path returns or logs it.
      return { id: issued.id, token: issued.token };
    }),

  // Soft revoke: the row is kept so tokenPrefix lookups keep resolving (and
  // failing verification) instead of dangling, and last-used history survives.
  revoke: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.apiKeys.id, input.id),
          eq(schema.apiKeys.teamId, ctx.teamId),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .returning({ id: schema.apiKeys.id });
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    await recordAudit(ctx, { action: "api_key.revoked", target: { type: "api_key", id: row.id } });
    return { id: row.id };
  }),

  rename: adminProcedure
    .input(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(schema.apiKeys)
        .set({ name: input.name })
        .where(
          and(
            eq(schema.apiKeys.id, input.id),
            eq(schema.apiKeys.teamId, ctx.teamId),
            isNull(schema.apiKeys.revokedAt),
          ),
        )
        .returning({ id: schema.apiKeys.id });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await recordAudit(ctx, {
        action: "api_key.renamed",
        target: { type: "api_key", id: row.id },
        metadata: { name: input.name },
      });
      return { id: row.id, name: input.name };
    }),
});
