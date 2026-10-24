import { randomBytes } from "node:crypto";
import { betaDefaultDailyCeiling, env, supportViewEnabled } from "@millionsend/config";
import {
  ALL_TEAMS_GRANT,
  endSupportView,
  enrollTeamSignupRisk,
  fetchBestOwnedPlan,
  fetchTeamStanding,
  getSignupSendingRestriction,
  liveSupportViewForTeam,
  PLAN_TEAM_LIMIT,
  recordSignupRisk,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { slugify } from "@/lib/slug";
import { recordAudit } from "../audit";
import { trackTeamSignup } from "../funnel";
import { listMemberships } from "../membership";
import {
  type AuthSession,
  adminProcedure,
  type Context,
  protectedProcedure,
  router,
  teamProcedure,
} from "../trpc";

/**
 * Records the active-team selection in both places that read it: the cookie
 * (dashboard requests) and the session row (the OAuth consent flow, which
 * binds a grant to session.activeTeamId). Callers validate membership first.
 */
async function selectTeam(
  ctx: Pick<Context, "db"> & {
    session: AuthSession;
    setActiveTeamCookie: Context["setActiveTeamCookie"] | undefined;
  },
  teamId: string,
): Promise<void> {
  ctx.setActiveTeamCookie?.(teamId);
  if (ctx.session.session) {
    await ctx.db
      .update(schema.session)
      .set({ activeTeamId: teamId })
      .where(eq(schema.session.id, ctx.session.session.id));
  }
}

export const teamBootstrapRouter = router({
  /** The response deliberately excludes private use context. Team scope comes from membership. */
  signupReview: adminProcedure.query(async ({ ctx }) => {
    const [request] = await ctx.db
      .select({
        requestedAt: schema.signupRiskReviewRequests.requestedAt,
        resolvedAt: schema.signupRiskReviewRequests.resolvedAt,
      })
      .from(schema.signupRiskReviewRequests)
      .where(eq(schema.signupRiskReviewRequests.teamId, ctx.teamId));
    return {
      pending: Boolean(request && !request.resolvedAt),
      requestedAt: request?.requestedAt ?? null,
    };
  }),

  requestSignupReview: adminProcedure
    .input(
      z.object({
        context: z
          .string()
          .max(2000)
          .transform((value) =>
            value
              .normalize("NFKC")
              .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
              .trim(),
          )
          .pipe(
            z
              .string()
              .min(20)
              .max(500)
              .refine((value) => Array.from(value).length >= 20),
          ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      return ctx.db
        .transaction(async (tx) => {
          // Serialize same-team retries and reopens; also prevents duplicate audit events.
          const [team] = await tx
            .select()
            .from(schema.teams)
            .where(eq(schema.teams.id, ctx.teamId))
            .for("update");
          if (!team) throw new TRPCError({ code: "NOT_FOUND" });
          const [existing] = await tx
            .select({
              requestedAt: schema.signupRiskReviewRequests.requestedAt,
              resolvedAt: schema.signupRiskReviewRequests.resolvedAt,
            })
            .from(schema.signupRiskReviewRequests)
            .where(eq(schema.signupRiskReviewRequests.teamId, ctx.teamId));
          if (existing && !existing.resolvedAt)
            return { pending: true, requestedAt: existing.requestedAt };
          if (existing && now.getTime() - existing.requestedAt.getTime() < 86_400_000)
            throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "review_request_wait" });
          const [risk] = await tx
            .select({ teamId: schema.teamSignupRisk.teamId })
            .from(schema.teamSignupRisk)
            .where(
              and(
                eq(schema.teamSignupRisk.teamId, ctx.teamId),
                isNull(schema.teamSignupRisk.clearedAt),
                or(
                  eq(schema.teamSignupRisk.level, "sandbox"),
                  eq(schema.teamSignupRisk.level, "hold"),
                ),
              ),
            );
          if (!risk && !team.sendReviewAt && !team.suspendedAt)
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "no_review_restriction" });
          await tx
            .insert(schema.signupRiskReviewRequests)
            .values({
              teamId: ctx.teamId,
              requestedBy: ctx.session.user.id,
              context: input.context,
              requestedAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.signupRiskReviewRequests.teamId,
              set: {
                requestedBy: ctx.session.user.id,
                context: input.context,
                requestedAt: now,
                updatedAt: now,
                resolvedAt: null,
              },
            });
          // Required, atomic audit. Context is private and never copied to logs or the receipt.
          await tx.insert(schema.auditLog).values({
            teamId: ctx.teamId,
            actorId: `user:${ctx.session.user.id}`,
            action: "team.signup_risk_review_requested",
            target: `team:${ctx.teamId}`,
            data: { requestedAt: now.toISOString() },
          });
          return { pending: true, requestedAt: now };
        })
        .catch((error: unknown) => {
          if (error instanceof TRPCError) throw error;
          // Database driver errors may carry SQL parameters, including private context.
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "review_request_failed" });
        });
    }),

  /** All of the caller's memberships plus which one the session resolved as active. */
  list: protectedProcedure.query(async ({ ctx }) => ({
    teams: await listMemberships(ctx.db, ctx.session.user.id),
    activeTeamId: ctx.teamId,
  })),

  /** The operator overrides on the active team, for the dashboard's notices. */
  standing: teamProcedure.query(async ({ ctx }) => {
    const standing = await fetchTeamStanding(ctx.db, ctx.teamId);
    if (!standing) return null;
    // A pause the content monitor applied reads as "pending review" to the
    // team; the reason behind it stays on the operator's side.
    const [monitor] = await ctx.db
      .select({ pausedAt: schema.teamMonitor.broadcastsPausedAt })
      .from(schema.teamMonitor)
      .where(eq(schema.teamMonitor.teamId, ctx.teamId));
    const pendingReview = Boolean(standing.broadcastsPausedByOperatorAt && monitor?.pausedAt);
    // A send-review hold reads as "under review" too; what tripped it stays
    // on the operator's side.
    const sendReview = standing.sendReview ? { at: standing.sendReview.at } : null;
    const signupRisk = (await getSignupSendingRestriction(ctx.db, ctx.teamId, env.IS_CLOUD)).kind;
    // The note is written for the owner only on a manual suspension; on the
    // other reasons it is the operator's own record.
    return standing.suspended && standing.suspended.reason !== "manual"
      ? {
          ...standing,
          sendReview,
          signupRisk,
          canRequestSignupReview: ctx.role === "owner" || ctx.role === "admin",
          pendingReview,
          suspended: { ...standing.suspended, note: null },
        }
      : {
          ...standing,
          sendReview,
          pendingReview,
          signupRisk,
          canRequestSignupReview: ctx.role === "owner" || ctx.role === "admin",
        };
  }),

  /** The operator's read-only look at the active team, for the owner's Support access card. */
  supportView: router({
    current: adminProcedure.query(async ({ ctx }) => {
      const enabled = supportViewEnabled();
      const live = enabled ? await liveSupportViewForTeam(ctx.db, ctx.teamId) : null;
      return {
        enabled,
        live: live
          ? {
              id: live.id,
              operator: live.operator,
              reason: live.reason,
              reference: live.reference,
              startedAt: live.createdAt,
              expiresAt: live.expiresAt,
            }
          : null,
      };
    }),

    /** The owner (or an admin) ends the session; the grant records who did. */
    end: adminProcedure.mutation(async ({ ctx }) => {
      const live = await liveSupportViewForTeam(ctx.db, ctx.teamId);
      if (!live) return { ended: false };
      await endSupportView(ctx.db, live, { by: "owner", userId: ctx.session.user.id });
      return { ended: true };
    }),
  }),

  /**
   * Selects an active team. The cookie is a selection, not authorization:
   * the target must be one of the caller's own memberships, and every later
   * request re-validates it in getActiveMembership.
   */
  switch: protectedProcedure
    .input(z.object({ teamId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const memberships = await listMemberships(ctx.db, ctx.session.user.id);
      if (!memberships.some((m) => m.teamId === input.teamId)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      await selectTeam(ctx, input.teamId);
      return { teamId: input.teamId };
    }),

  /**
   * Binds the pending OAuth consent to a team — or to ALL_TEAMS_GRANT for an
   * all-teams grant. Writes only the session row (what consentReferenceId
   * reads), never the dashboard cookie: authorizing an app must not switch
   * the team the user is working in.
   */
  grantTeam: protectedProcedure
    .input(z.object({ teamId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const memberships = await listMemberships(ctx.db, ctx.session.user.id);
      const allowed =
        input.teamId === ALL_TEAMS_GRANT
          ? memberships.length > 0
          : memberships.some((m) => m.teamId === input.teamId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN" });
      if (ctx.session.session) {
        await ctx.db
          .update(schema.session)
          .set({ activeTeamId: input.teamId })
          .where(eq(schema.session.id, ctx.session.session.id));
      }
      return { teamId: input.teamId };
    }),

  createTeam: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      if (env.IS_CLOUD) {
        const userId = ctx.session.user.id;
        const [memberships, bestPlan] = await Promise.all([
          listMemberships(ctx.db, userId),
          fetchBestOwnedPlan(ctx.db, userId),
        ]);
        const owned = memberships.filter((m) => m.role === "owner").length;
        if (owned >= PLAN_TEAM_LIMIT[bestPlan]) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Team limit reached." });
        }
        // Legacy users get a capture only when creating a new team. It carries
        // no invented original IP or historical verification timestamp.
        await recordSignupRisk(ctx.db, {
          userId,
          email: ctx.session.user.email,
          secret: env.BETTER_AUTH_SECRET ?? "",
          source: "team_fallback",
        });
      }
      const base = slugify(input.name) || "team";
      for (let attempt = 0; attempt < 3; attempt++) {
        const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
        try {
          const created = await ctx.db.transaction(async (tx) => {
            const [team] = await tx
              .insert(schema.teams)
              .values({
                name: input.name.trim(),
                slug,
                // Beta default: an operator-set ceiling so a self-serve team
                // starts capped; unset on classic self-host and adjustable
                // per team later in the operator console.
                dailySendCeiling: betaDefaultDailyCeiling() ?? null,
              })
              .returning({ id: schema.teams.id });
            if (!team) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
            await tx.insert(schema.teamMembers).values({
              teamId: team.id,
              userId: ctx.session.user.id,
              role: "owner",
            });
            if (env.IS_CLOUD)
              await enrollTeamSignupRisk(tx as unknown as Db, {
                teamId: team.id,
                userId: ctx.session.user.id,
              });
            return { teamId: team.id };
          });
          await trackTeamSignup(ctx.db, ctx.session.user.id, created.teamId);
          // A freshly created team becomes the active one.
          await selectTeam(ctx, created.teamId);
          await recordAudit(
            { ...ctx, teamId: created.teamId },
            {
              action: "team.created",
              target: { type: "team", id: created.teamId },
              metadata: { name: input.name.trim() },
            },
          );
          return created;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "could not allocate a unique team slug" });
    }),
});
