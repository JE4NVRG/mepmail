import { withMailboxRegistryAdmin } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, asc, eq, isNull } from "drizzle-orm";
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
  operationsOptions: operatorProcedure
    .input(z.object({ teamId: z.uuid() }).strict())
    .query(async ({ ctx, input }) =>
      withMailboxRegistryAdmin(
        ctx.db,
        { teamId: input.teamId, userId: ctx.operator.id },
        async (db) => {
          const [domains, mailboxes] = await Promise.all([
            db
              .select({ id: schema.domains.id, name: schema.domains.name })
              .from(schema.domains)
              .where(eq(schema.domains.teamId, input.teamId))
              .orderBy(asc(schema.domains.name)),
            db
              .select({
                id: schema.mailboxes.id,
                address: schema.mailboxes.address,
                label: schema.mailboxes.label,
                domainId: schema.mailboxes.domainId,
              })
              .from(schema.mailboxes)
              .where(
                and(
                  eq(schema.mailboxes.teamId, input.teamId),
                  eq(schema.mailboxes.origin, "domain"),
                  eq(schema.mailboxes.status, "planned"),
                  isNull(schema.mailboxes.deleteAfter),
                ),
              )
              .orderBy(asc(schema.mailboxes.address)),
          ]);
          return { domains, mailboxes };
        },
      ),
    ),

  createOperations: operatorProcedure
    .input(
      z
        .object({
          teamId: z.uuid(),
          email: inviteEmailSchema,
          domainIds: z
            .array(z.uuid())
            .min(1)
            .max(20)
            .refine((v) => new Set(v).size === v.length),
          mailboxIds: z
            .array(z.uuid())
            .min(1)
            .max(20)
            .refine((v) => new Set(v).size === v.length),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      const created = await createInvitation(ctx.db, mail(), {
        teamId: team.id,
        email: input.email,
        role: "member",
        inviter: ctx.operator,
        operationsAccess: {
          version: 1,
          userDirectoryRead: true,
          mailboxCreateDomainIds: input.domainIds,
          sendMailboxIds: input.mailboxIds,
        },
      });
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.member_invited",
        target: { type: "invitation", id: created.id },
        metadata: {
          team: team.name,
          email: created.email,
          role: "member",
          operationalProfile: true,
          domainIds: input.domainIds,
          sendMailboxIds: input.mailboxIds,
          emailed: created.emailed,
        },
      });
      return { ...created, teamName: team.name };
    }),

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
