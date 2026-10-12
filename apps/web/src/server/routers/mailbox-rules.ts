import { MailboxContentError, MailboxServiceError } from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  deleteMailboxRule,
  listMailboxRules,
  saveMailboxRule,
} from "../../../../../packages/core/src/mailbox-rules";
import { getKeyring } from "../keyring";
import { mailboxSenderHmacKey } from "../mailbox-sender-key";
import { mailboxActorAccessEnabled } from "../mailboxes";
import { router, teamProcedure } from "../trpc";

/**
 * Regras automáticas (mounted as mailboxRules): the owner's filters for one of their
 * mailboxes. New mail from a sender or a domain is filed at receipt in a named folder,
 * the Archive or another mailbox the same person owns, and may be marked read or
 * starred. Only the human owner manages them; grants and agents never do.
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
  if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "rules_unavailable" });
  return key;
}

export const mailboxRulesRouter = router({
  list: enabled
    .input(z.object({ mailboxId: z.uuid() }))
    .query(({ ctx, input }) =>
      call(() => listMailboxRules(ctx.db, getKeyring(), actor(ctx), input)),
    ),
  save: enabled
    .input(
      z
        .object({
          mailboxId: z.uuid(),
          id: z.uuid().optional(),
          match: z.object({
            kind: z.enum(["sender", "domain"]),
            value: z.string().min(1).max(320),
          }),
          folderId: z.uuid().nullable().optional(),
          archive: z.boolean().optional(),
          targetMailboxId: z.uuid().nullable().optional(),
          markRead: z.boolean().optional(),
          star: z.boolean().optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      call(() => saveMailboxRule(ctx.db, getKeyring(), senderKey(), actor(ctx), input)),
    ),
  delete: enabled
    .input(z.object({ mailboxId: z.uuid(), id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => deleteMailboxRule(ctx.db, actor(ctx), input))),
});
