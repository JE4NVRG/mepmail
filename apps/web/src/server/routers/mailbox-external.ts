import {
  createMailboxExternalAccount,
  disconnectMailboxExternalAccount,
  getMailboxExternalAccount,
  MailboxExternalError,
  MailboxServiceError,
  mailboxExternalOAuthAvailable,
  replaceMailboxExternalSecret,
  requestMailboxExternalSync,
} from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { recordAudit } from "../audit";
import { getKeyring } from "../keyring";
import {
  checkMailboxExternalAccount,
  MailboxExternalCheckError,
  mailboxExternalServers,
} from "../mailbox-external-connect";
import { mailboxActorAccessEnabled } from "../mailboxes";
import { router, teamProcedure } from "../trpc";

/**
 * Contas externas (specs/correio-external-accounts.md): connect a Gmail/iCloud/Yahoo/IMAP
 * account with an app password, see how its sync stands, replace the password, sync now,
 * disconnect. Offered to every team with MAILBOX_EXTERNAL_OPEN=1, before that only to the
 * pilot teams in MAILBOX_EXTERNAL_TEAM_IDS.
 */
export function mailboxExternalOpen(teamId: string) {
  return process.env.MAILBOX_EXTERNAL_OPEN === "1" || mailboxExternalPilot(teamId);
}

function mailboxExternalPilot(teamId: string) {
  return (process.env.MAILBOX_EXTERNAL_TEAM_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(teamId);
}

/**
 * "Entrar com a Microsoft / o Google" for this team: only where accounts may be connected at
 * all. Microsoft stays with the pilot teams until its front resumes (an Outlook.com account
 * ships with IMAP off, and its sync then fails); MAILBOX_EXTERNAL_MICROSOFT_OPEN=1 offers it
 * to every team.
 */
export function mailboxExternalOAuthFor(teamId: string) {
  const open = mailboxExternalOpen(teamId);
  const oauth = mailboxExternalOAuthAvailable();
  const microsoftOpen =
    process.env.MAILBOX_EXTERNAL_MICROSOFT_OPEN === "1" || mailboxExternalPilot(teamId);
  return {
    microsoft: open && oauth.microsoft && microsoftOpen,
    google: open && oauth.google,
  };
}

const open = teamProcedure.use(async ({ ctx, next }) => {
  if (!mailboxExternalOpen(ctx.teamId)) throw new TRPCError({ code: "NOT_FOUND" });
  if (
    !(await mailboxActorAccessEnabled(ctx.db, { teamId: ctx.teamId, userId: ctx.session.user.id }))
  )
    throw new TRPCError({ code: "NOT_FOUND" });
  if (ctx.supportView) throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});

/** Errors as the dialog reads them: the code, and the reason in the message. */
async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MailboxExternalCheckError)
      throw new TRPCError({ code: "BAD_REQUEST", message: error.reason });
    if (error instanceof MailboxExternalError)
      throw new TRPCError({
        code: {
          forbidden: "FORBIDDEN",
          not_found: "NOT_FOUND",
          conflict: "CONFLICT",
          invalid: "BAD_REQUEST",
          limit: "PRECONDITION_FAILED",
        }[error.code] as
          | "FORBIDDEN"
          | "NOT_FOUND"
          | "CONFLICT"
          | "BAD_REQUEST"
          | "PRECONDITION_FAILED",
        message: error.code,
      });
    if (error instanceof MailboxServiceError)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.code });
    throw error;
  }
}

const servers = {
  provider: z.enum(["gmail", "icloud", "yahoo", "zoho", "outlook", "imap"]),
  address: z.email().max(254),
  username: z.string().min(1).max(254).optional(),
  imapHost: z.string().min(3).max(253).optional(),
  smtpHost: z.string().min(3).max(253).optional(),
  smtpPort: z.union([z.literal(465), z.literal(587)]).optional(),
};

export const mailboxExternalRouter = router({
  available: teamProcedure.query(({ ctx }) => ({
    open: mailboxExternalOpen(ctx.teamId),
    oauth: mailboxExternalOAuthFor(ctx.teamId),
  })),
  connect: open
    .input(
      z
        .object({
          ...servers,
          password: z.string().min(1).max(512),
          label: z.string().min(1).max(80),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      call(async () => {
        const proven = mailboxExternalServers(input);
        await checkMailboxExternalAccount(proven, input.password);
        const created = await createMailboxExternalAccount(
          ctx.db,
          getKeyring(),
          { teamId: ctx.teamId, userId: ctx.session.user.id },
          { address: input.address, label: input.label, servers: proven, secret: input.password },
        );
        await recordAudit(ctx, {
          action: "mailbox.external_connected",
          target: { type: "mailbox", id: created.mailboxId },
          metadata: { provider: input.provider },
        });
        return created;
      }),
    ),
  status: open
    .input(z.object({ mailboxId: z.uuid() }).strict())
    .query(({ ctx, input }) =>
      call(() =>
        getMailboxExternalAccount(
          ctx.db,
          { teamId: ctx.teamId, userId: ctx.session.user.id },
          input.mailboxId,
        ),
      ),
    ),
  replacePassword: open
    .input(z.object({ mailboxId: z.uuid(), password: z.string().min(1).max(512) }).strict())
    .mutation(({ ctx, input }) =>
      call(async () => {
        const actor = { teamId: ctx.teamId, userId: ctx.session.user.id };
        const account = await getMailboxExternalAccount(ctx.db, actor, input.mailboxId);
        await checkMailboxExternalAccount(
          {
            provider: account.provider,
            imapHost: account.imapHost,
            smtpHost: account.smtpHost,
            smtpPort: account.smtpPort as 465 | 587,
            smtpSecurity: account.smtpPort === 465 ? "tls" : "starttls",
            username: account.username,
          },
          input.password,
        );
        await replaceMailboxExternalSecret(ctx.db, getKeyring(), actor, {
          mailboxId: input.mailboxId,
          secret: input.password,
        });
        await recordAudit(ctx, {
          action: "mailbox.external_password_replaced",
          target: { type: "mailbox", id: input.mailboxId },
        });
        return { ok: true as const };
      }),
    ),
  syncNow: open.input(z.object({ mailboxId: z.uuid() }).strict()).mutation(({ ctx, input }) =>
    call(async () => {
      await requestMailboxExternalSync(
        ctx.db,
        { teamId: ctx.teamId, userId: ctx.session.user.id },
        input.mailboxId,
      );
      return { ok: true as const };
    }),
  ),
  disconnect: open.input(z.object({ mailboxId: z.uuid() }).strict()).mutation(({ ctx, input }) =>
    call(async () => {
      await disconnectMailboxExternalAccount(
        ctx.db,
        { teamId: ctx.teamId, userId: ctx.session.user.id },
        input.mailboxId,
      );
      await recordAudit(ctx, {
        action: "mailbox.external_disconnected",
        target: { type: "mailbox", id: input.mailboxId },
      });
      return { ok: true as const };
    }),
  ),
});
