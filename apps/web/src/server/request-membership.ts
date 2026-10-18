import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";

export interface RequestMembershipContext {
  db: Db;
  session: { user: { id: string } } | null;
  teamId: string | null;
  supportView?: unknown;
}

export interface ResolvedRequestMembership {
  role: (typeof schema.teamMemberRoleEnum.enumValues)[number];
  operationsAccess: typeof schema.teamMembers.$inferSelect.operationsAccess;
  verified: boolean;
  suspendedAt: Date | null;
}

/** Resolve the live row for every protected call. A context role is never an
 * authorization fallback; an operator support view is not a membership. */
export async function resolveRequestMembership(
  ctx: RequestMembershipContext,
): Promise<ResolvedRequestMembership | null> {
  if (!ctx.session || !ctx.teamId || ctx.supportView) return null;
  const [member] = await ctx.db
    .select({
      role: schema.teamMembers.role,
      operationsAccess: schema.teamMembers.operationsAccess,
      verified: schema.user.emailVerified,
      suspendedAt: schema.teams.suspendedAt,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(
      and(
        eq(schema.teamMembers.teamId, ctx.teamId),
        eq(schema.teamMembers.userId, ctx.session.user.id),
      ),
    );
  return member ?? null;
}
