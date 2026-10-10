import { MailboxContentError, MailboxServiceError } from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  decideMailboxSender,
  listMailboxSenderDecisions,
} from "../../../../../packages/core/src/mailbox-senders";
import { getKeyring } from "../keyring";
import { mailboxSenderHmacKey } from "../mailbox-sender-key";
import { mailboxActorAccessEnabled } from "../mailboxes";
import { router, teamProcedure } from "../trpc";

/**
 * Aprovação de remetentes (mounted as mailboxes.senders): the owner allows or
 * blocks a sender of one of their mailboxes, and reviews those answers. List
 * rows carry the answer as `senderDecision`; receipt sends a blocked sender's
 * new mail to Spam.
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
function senderKey(): Buffer {
  const key = mailboxSenderHmacKey();
  if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "screening_unavailable" });
  return key;
}

export const mailboxSendersRouter = router({
  decide: enabled
    .input(
      z.object({
        mailboxId: z.uuid(),
        address: z.string().min(3).max(320),
        decision: z.enum(["allow", "block"]).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      call(() => decideMailboxSender(ctx.db, getKeyring(), senderKey(), actor(ctx), input)),
    ),
  list: enabled
    .input(z.object({ mailboxId: z.uuid() }))
    .query(({ ctx, input }) =>
      call(() => listMailboxSenderDecisions(ctx.db, getKeyring(), actor(ctx), input)),
    ),
});
