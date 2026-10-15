import { z } from "zod";
import { defaultSystemMailDeps, type SystemMailDeps } from "../../system-mail";
import {
  createInvitation,
  inviteEmailSchema,
  inviteRoleSchema,
  listPendingInvitations,
  resendInvitation,
  revokeInvitation,
} from "../../team-invitations";
import { operatorProcedure, router } from "../../trpc";
import { auditOperator, loadTeam } from "./shared";

let mailDeps: SystemMailDeps | null = null;

/** Tests capture the invitation mail here; null puts the real sender back. */
export function setConsoleInvitationMailDeps(deps: SystemMailDeps | null): void {
  mailDeps = deps;
}

const mail = () => mailDeps ?? defaultSystemMailDeps;

/**
 * The operator invites people into any team from the console, without being
 * a member of it and without a session in it: operatorProcedure re-checks
 * the operator on every call, the team comes from the input (loadTeam:
 * NOT_FOUND when it does not exist), and every invitation read or changed
 * here is matched on that team too. Nothing here adds the operator to the
 * team, switches their active team or opens a support view. The team's own
 * settings.invitations keep their rule (the session's team, its owners and
 * admins); both issue the same invitation through server/team-invitations,
 * and the invitee accepts it the usual way. The owner role is never offered:
 * ownership is not something to hand out from outside the team.
 *
 * Audit: one row in the target team's log per action, with the operator as
 * the actor, the address, the role and the outcome. Never the accept link.
 */
export const consoleTeamInvitationsRouter = router({
  list: operatorProcedure.input(z.object({ teamId: z.uuid() })).query(async ({ ctx, input }) => {
    const team = await loadTeam(ctx.db, input.teamId);
    return listPendingInvitations(ctx.db, team.id);
  }),

  create: operatorProcedure
    .input(
      z
        .object({
          teamId: z.uuid(),
          email: inviteEmailSchema,
          role: inviteRoleSchema,
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      const created = await createInvitation(ctx.db, mail(), {
        teamId: team.id,
        email: input.email,
        role: input.role,
        inviter: { id: ctx.operator.id, name: ctx.operator.name },
      });
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.member_invited",
        target: { type: "invitation", id: created.id },
        metadata: {
          team: team.name,
          email: created.email,
          role: created.role,
          emailed: created.emailed,
        },
      });
      return { ...created, teamName: team.name };
    }),

  resend: operatorProcedure
    .input(z.object({ teamId: z.uuid(), id: z.uuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      const sent = await resendInvitation(ctx.db, mail(), {
        teamId: team.id,
        id: input.id,
        inviter: { id: ctx.operator.id, name: ctx.operator.name },
      });
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.invitation_resent",
        target: { type: "invitation", id: sent.id },
        metadata: { team: team.name, email: sent.email, role: sent.role, emailed: true },
      });
      return { id: sent.id, expiresAt: sent.expiresAt };
    }),

  revoke: operatorProcedure
    .input(z.object({ teamId: z.uuid(), id: z.uuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      const row = await revokeInvitation(ctx.db, { teamId: team.id, id: input.id });
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.invitation_revoked",
        target: { type: "invitation", id: row.id },
        metadata: { team: team.name, email: row.email, role: row.role },
      });
      return { id: row.id };
    }),
});
