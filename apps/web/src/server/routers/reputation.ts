import { getGraduatedSendingContext, getTenantReputation } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router, teamProcedure } from "../trpc";
/** Session membership owns the team. A domain is explicit, never inferred from maturity. */
export const reputationRouter = router({
  get: publicProcedure
    .use(({ ctx, next }) => {
      if (!ctx.session) throw new TRPCError({ code: "FORBIDDEN" });
      return next();
    })
    .concat(teamProcedure)
    .input(z.object({ domainId: z.uuid().nullable().optional() }).strict().optional())
    .query(async ({ ctx, input }) => {
      if (ctx.supportView || !ctx.requestMembership) throw new TRPCError({ code: "FORBIDDEN" });
      const domainId = input?.domainId ?? undefined;
      if (domainId) {
        const [owned] = await ctx.db
          .select({ id: schema.domains.id })
          .from(schema.domains)
          .where(and(eq(schema.domains.teamId, ctx.teamId), eq(schema.domains.id, domainId)))
          .limit(1);
        if (!owned) throw new TRPCError({ code: "FORBIDDEN" });
      }
      const context = await getGraduatedSendingContext();
      return getTenantReputation(ctx.db, ctx.teamId, { ...context, domainId });
    }),
});
