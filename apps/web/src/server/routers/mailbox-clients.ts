import { MailboxContentError, MailboxServiceError } from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createMailboxAppPassword,
  listMailboxAppPasswords,
  MAILBOX_APP_PASSWORD_LIMIT,
  MailboxAppPasswordError,
  revokeMailboxAppPassword,
} from "../../../../../packages/core/src/mailbox-app-passwords";
import { recordAudit } from "../audit";
import { mailboxAppPasswordKey } from "../mailbox-app-password-key";
import { mailboxActorAccessEnabled } from "../mailboxes";
import { router, teamProcedure } from "../trpc";

/**
 * The Correio in other mail apps (specs/correio-imap-smtp.md): the mailbox owner's app
 * passwords and the server settings to type into Outlook, Apple Mail, Thunderbird or the
 * Gmail app. Offered once the IMAP/SMTP servers are live: to every team with
 * MAILBOX_CLIENT_ACCESS_OPEN=1, before that only to the pilot teams listed in
 * MAILBOX_CLIENT_ACCESS_TEAM_IDS; never without a master key.
 */
export function mailboxClientAccessOpen(teamId: string) {
  if (mailboxAppPasswordKey() === null) return false;
  if (process.env.MAILBOX_CLIENT_ACCESS_OPEN === "1") return true;
  // Pilot: only these teams see it until it opens to everyone (comma-separated ids).
  return (process.env.MAILBOX_CLIENT_ACCESS_TEAM_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(teamId);
}

const settings = () => ({
  imap: {
    host: process.env.MAILBOX_IMAP_PUBLIC_HOST ?? "imap.mepmail.dev",
    port: 993,
    security: "ssl",
  },
  smtp: {
    host: process.env.MAILBOX_SMTP_PUBLIC_HOST ?? "smtp.mepmail.dev",
    port: 465,
    security: "ssl",
    alternatePort: 587,
    alternateSecurity: "starttls",
  },
  limit: MAILBOX_APP_PASSWORD_LIMIT,
});

const open = teamProcedure.use(async ({ ctx, next }) => {
  if (!mailboxClientAccessOpen(ctx.teamId)) throw new TRPCError({ code: "NOT_FOUND" });
  if (
    !(await mailboxActorAccessEnabled(ctx.db, { teamId: ctx.teamId, userId: ctx.session.user.id }))
  )
    throw new TRPCError({ code: "NOT_FOUND" });
  // Support views act for operators, never as a mailbox's owner.
  if (ctx.supportView) throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});

/** What the screen shows of an app password (never its hash). */
const row = (r: {
  id: string;
  label: string;
  hint: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}) => ({
  id: r.id,
  label: r.label,
  hint: r.hint,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
});

const actor = (ctx: { teamId: string; session: { user: { id: string } } }) => ({
  teamId: ctx.teamId,
  userId: ctx.session.user.id,
});

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MailboxAppPasswordError)
      throw new TRPCError({
        code:
          error.code === "not_found"
            ? "NOT_FOUND"
            : error.code === "quota"
              ? "PRECONDITION_FAILED"
              : "BAD_REQUEST",
        message: error.code,
      });
    if (error instanceof MailboxServiceError)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.code });
    if (error instanceof MailboxContentError)
      throw new TRPCError({
        code:
          error.code === "forbidden"
            ? "FORBIDDEN"
            : error.code === "not_found"
              ? "NOT_FOUND"
              : "BAD_REQUEST",
        message: error.code,
      });
    throw error;
  }
}

export const mailboxClientsRouter = router({
  /** Whether to show "Usar em outro app de e-mail" at all, and what to type there. */
  settings: teamProcedure.query(({ ctx }) => ({
    open: mailboxClientAccessOpen(ctx.teamId),
    ...settings(),
  })),
  appPasswords: open
    .input(z.object({ mailboxId: z.uuid() }).strict())
    .query(async ({ ctx, input }) =>
      (await call(() => listMailboxAppPasswords(ctx.db, actor(ctx), input.mailboxId))).map(row),
    ),
  createAppPassword: open
    .input(z.object({ mailboxId: z.uuid(), label: z.string().min(1).max(80) }).strict())
    .mutation(async ({ ctx, input }) => {
      const made = await call(() =>
        createMailboxAppPassword(ctx.db, mailboxAppPasswordKey()!, actor(ctx), input),
      );
      await recordAudit(ctx, {
        action: "mailbox.app_password_created",
        target: { type: "mailbox", id: input.mailboxId },
        metadata: { appPasswordId: made.id },
      });
      // The clear password travels this once.
      return { ...row(made), password: made.password };
    }),
  revokeAppPassword: open
    .input(z.object({ mailboxId: z.uuid(), id: z.uuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      const revoked = await call(() => revokeMailboxAppPassword(ctx.db, actor(ctx), input));
      await recordAudit(ctx, {
        action: "mailbox.app_password_revoked",
        target: { type: "mailbox", id: input.mailboxId },
        metadata: { appPasswordId: revoked.id },
      });
      return revoked;
    }),
});
