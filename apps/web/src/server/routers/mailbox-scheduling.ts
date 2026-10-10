import {
  MailboxContentError,
  MailboxServiceError,
  pinMailboxItem,
  scheduleMailboxSend,
  setMailboxFollowUp,
  snoozeMailboxItem,
} from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getMailboxScheduleCounts } from "../mailbox-content";
import { mailboxActorAccessEnabled } from "../mailboxes";
import { router, teamProcedure } from "../trpc";

/**
 * Snooze, pin, send later and follow-up reminders (mounted as
 * mailboxes.scheduling). The owner's own timing on retained messages: no
 * content is read here; a scheduled send is admitted later by the worker.
 */
const enabled = teamProcedure.use(async ({ ctx, next }) => {
  if (
    !(await mailboxActorAccessEnabled(ctx.db, { teamId: ctx.teamId, userId: ctx.session.user.id }))
  )
    throw new TRPCError({ code: "NOT_FOUND" });
  // Support grants cover outbound operations, never a person's private mailbox.
  if (ctx.supportView) throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MailboxServiceError)
      throw new TRPCError({
        code: error.code === "invalid" ? "BAD_REQUEST" : "PRECONDITION_FAILED",
        message: error.code,
      });
    if (error instanceof MailboxContentError)
      throw new TRPCError({
        code: {
          forbidden: "FORBIDDEN",
          not_found: "NOT_FOUND",
          invalid: "BAD_REQUEST",
          conflict: "CONFLICT",
        }[error.code] as "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
      });
    throw error;
  }
}
const actor = (ctx: { teamId: string; session: { user: { id: string } } }) => ({
  teamId: ctx.teamId,
  userId: ctx.session.user.id,
});
const item = {
  mailboxId: z.uuid(),
  id: z.uuid(),
  expectedRevision: z.number().int().min(1).max(2147483646),
};

export const mailboxSchedulingRouter = router({
  /** Snooze a received message until a time; null brings it back now. */
  snooze: enabled
    .input(z.object({ ...item, until: z.date().nullable() }).strict())
    .mutation(({ ctx, input }) => call(() => snoozeMailboxItem(ctx.db, actor(ctx), input))),
  /** Pin a received message to the top of the inbox, or unpin it. */
  pin: enabled
    .input(z.object({ ...item, pinned: z.boolean() }).strict())
    .mutation(({ ctx, input }) => call(() => pinMailboxItem(ctx.db, actor(ctx), input))),
  /** Send a draft later; null cancels the schedule. */
  sendLater: enabled
    .input(z.object({ ...item, sendAt: z.date().nullable() }).strict())
    .mutation(({ ctx, input }) => {
      // Without transport nothing would ever go out: refuse the schedule, allow the cancel.
      if (input.sendAt !== null && process.env.MAILBOX_TRANSPORT_ENABLED !== "1")
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "mailbox_transport_unavailable",
        });
      return call(() => scheduleMailboxSend(ctx.db, actor(ctx), input));
    }),
  /** Remind about a sent message if nobody replies by a time; null clears it. */
  followUp: enabled
    .input(z.object({ ...item, remindAt: z.date().nullable() }).strict())
    .mutation(({ ctx, input }) => call(() => setMailboxFollowUp(ctx.db, actor(ctx), input))),
  /** Snoozed, scheduled and due follow-up counts for the rail. */
  counts: enabled
    .input(z.object({ mailboxId: z.uuid().nullable() }).strict())
    .query(({ ctx, input }) => call(() => getMailboxScheduleCounts(ctx.db, actor(ctx), input))),
});
