import {
  MailboxAgentAccessError,
  MailboxContentError,
  MailboxRegistryError,
} from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { countMailboxAgentApprovals, getMailboxAgentsOverview } from "../mailbox-agents-overview";
import { mailboxActorAccessEnabled } from "../mailboxes";
import { router, teamProcedure } from "../trpc";

/**
 * The agents panel's one read (mailbox-agents-overview.ts). Its actions are the
 * mailboxes router's own: queueDraft (send what the agent asked), setTrash (discard),
 * revokeAgentKey / revokeTeamAgentKey (revoke), so nothing new can be done from here.
 */
const enabled = teamProcedure.use(async ({ ctx, next }) => {
  if (
    !(await mailboxActorAccessEnabled(ctx.db, { teamId: ctx.teamId, userId: ctx.session.user.id }))
  )
    throw new TRPCError({ code: "NOT_FOUND" });
  if (ctx.supportView) throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});

export const mailboxAgentsRouter = router({
  /** The rail's counter: requests waiting for this person's approval. */
  pending: enabled.query(async ({ ctx }) => ({
    count: await countMailboxAgentApprovals(ctx.db, {
      teamId: ctx.teamId,
      userId: ctx.session.user.id,
    }).catch(() => 0),
  })),
  overview: enabled.query(async ({ ctx }) => {
    try {
      return await getMailboxAgentsOverview(ctx.db, {
        teamId: ctx.teamId,
        userId: ctx.session.user.id,
      });
    } catch (error) {
      if (
        error instanceof MailboxContentError ||
        error instanceof MailboxRegistryError ||
        error instanceof MailboxAgentAccessError
      )
        throw new TRPCError({ code: error.code === "not_found" ? "NOT_FOUND" : "FORBIDDEN" });
      throw error;
    }
  }),
});
