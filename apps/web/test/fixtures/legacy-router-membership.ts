import type { ResolvedRequestMembership } from "@/server/request-membership";
import type { Context } from "@/server/trpc";

/** Explicit authentication stub for legacy router UNIT tests whose callers
 * already supply a synthetic session/team/role. It never seeds or repairs DB
 * rows, and does not replace the router's own membership/business queries.
 *
 * No global setup imports this fixture. The real operations-procedure-isolation,
 * operations-access, operations-invitations and OAuth integration tests do NOT
 * use it: they exercise the production resolver and current database rows.
 */
export async function resolveRequestMembership(
  ctx: Context,
): Promise<ResolvedRequestMembership | null> {
  if (!ctx.session || !ctx.teamId || ctx.supportView) return null;
  if (ctx.role !== "owner" && ctx.role !== "admin" && ctx.role !== "member") return null;
  return { role: ctx.role, operationsAccess: null, verified: true, suspendedAt: null };
}
