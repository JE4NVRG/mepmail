import { env, isCloudDeployment, notificationsEmailFrom } from "@millionsend/config";
import {
  createFixedWindowLimiter,
  DAY_MS,
  INVITE_EMAILS_PER_HOUR,
  INVITE_MAX_SENDS,
  INVITE_RESEND_COOLDOWN_MS,
  INVITE_TTL_MS,
  isInstanceOperator,
  type OperationsInvitationAccess,
  operationsInvitationTargets,
  SystemMailRefused,
  signInviteToken,
  withMailboxRegistryAdmin,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { resolveBaseUrl } from "./auth";
import { activeLocale } from "./locale";
import {
  awsCredentialsConfigured,
  buildInvitationEmail,
  buildOperationsInvitationEmail,
  type SystemMailDeps,
} from "./system-mail";

/**
 * Team invitations, shared by the two places that issue them: a team's own
 * owners and admins (settings.invitations, always the session's team) and
 * the instance operator from the console (console.teams.invitations, the
 * team the console names). Each caller authorizes and audits on its own
 * terms; this module only holds what an invitation is — the row, its
 * signed accept link, its email, its expiry and its send limits — so both
 * issue the same thing. The accept side (settings.invitations.accept) is
 * the same for both: the invite row alone names the team and the role.
 */

export type InviteRole = "member" | "admin";

/** The invited address as both issuers take it: a valid address, trimmed and lower-cased. */
export const inviteEmailSchema = z.email().trim().toLowerCase();

/** The roles an invitation can carry; ownership is never handed out by invitation. */
export const inviteRoleSchema = z.enum(["member", "admin"]).default("member");

/** Who the invitation names as having sent it: a team admin, or the operator. */
export interface Inviter {
  id: string;
  name: string;
}

export function inviteSecret(): string {
  if (!env.BETTER_AUTH_SECRET) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "BETTER_AUTH_SECRET is required",
    });
  }
  return env.BETTER_AUTH_SECRET;
}

export function inviteAcceptUrl(inviteId: string): string {
  return `${resolveBaseUrl(env.APP_BASE_URL)}/invite/${signInviteToken(inviteId, inviteSecret())}`;
}

/** Invite emails need SES reach and a system sender; without both the link is the only credential. */
export function inviteEmailsEnabled(): boolean {
  return awsCredentialsConfigured() && Boolean(notificationsEmailFrom());
}

// Invite spam guard shared by create and resend, keyed by team: an
// operator's invitations count against the same hourly budget as the team's.
const inviteEmailsLimited = createFixedWindowLimiter(INVITE_EMAILS_PER_HOUR, 3_600_000);

const INVITE_HOURLY_LIMIT_ERROR = new TRPCError({
  code: "TOO_MANY_REQUESTS",
  message: "Too many invitations this hour. Try again later.",
});

/**
 * Awaited, unlike the password reset: `emailed` and the per-invite send
 * counters are shown to whoever invited, so they must reflect a send SES
 * accepted. A failure is logged and reported as false — the dialog still
 * shows the link, and nothing is charged against the invite.
 */
async function emailInvite(
  db: Db,
  mail: SystemMailDeps,
  teamId: string,
  inviter: Inviter,
  invite: {
    id: string;
    email: string;
    role: InviteRole;
    operationsAccess?: OperationsInvitationAccess | null | undefined;
  },
): Promise<boolean> {
  const [team] = await db
    .select({ name: schema.teams.name })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  const common = {
    to: invite.email,
    inviterName: inviter.name,
    teamName: team?.name ?? "",
    role: invite.role,
    url: inviteAcceptUrl(invite.id),
    expiresInDays: Math.round(INVITE_TTL_MS / DAY_MS),
    locale: await activeLocale(),
  };
  const targets = invite.operationsAccess
    ? await operationsInvitationTargets(db, teamId, invite.operationsAccess)
    : null;
  const message = targets
    ? buildOperationsInvitationEmail({
        ...common,
        domains: targets.domains.map((d) => d.name),
        mailboxes: targets.mailboxes.map((m) => m.address),
      })
    : buildInvitationEmail(common);
  try {
    await mail.send(message);
    return true;
  } catch (error) {
    // A suppressed invitee (bounced or complained on the instance's own
    // mail) reads as sent: `emailed: false` would tell any team admin that
    // an arbitrary address is suppressed in the instance's system team.
    if (error instanceof SystemMailRefused && error.reason === "all_suppressed") {
      console.warn(`Invitation email withheld: recipient suppressed (invite ${invite.id})`);
      return true;
    }
    console.error("Invitation email failed to send", error);
    return false;
  }
}

/**
 * The team's pending invitations, newest first. The accept link is handed
 * out once, at create time: a listing that could reproduce every pending
 * bearer link would make one session worth every open invite.
 */
export function listPendingInvitations(db: Db, teamId: string) {
  return db
    .select({
      id: schema.teamInvitations.id,
      email: schema.teamInvitations.email,
      role: schema.teamInvitations.role,
      expiresAt: schema.teamInvitations.expiresAt,
      createdAt: schema.teamInvitations.createdAt,
      lastSentAt: schema.teamInvitations.lastSentAt,
      sendCount: schema.teamInvitations.sendCount,
    })
    .from(schema.teamInvitations)
    .where(
      and(eq(schema.teamInvitations.teamId, teamId), isNull(schema.teamInvitations.acceptedAt)),
    )
    .orderBy(desc(schema.teamInvitations.createdAt));
}

/**
 * A new pending invitation to `teamId`, emailed when a sender is configured.
 * The address arrives normalized by the caller's input schema (trimmed,
 * lower-cased). CONFLICT when the address already has a pending invite.
 */
export async function createInvitation(
  db: Db,
  mail: SystemMailDeps,
  input: {
    teamId: string;
    email: string;
    role: InviteRole;
    inviter: Inviter;
    operationsAccess?: OperationsInvitationAccess;
  },
) {
  if (input.operationsAccess) {
    if (input.role !== "member" || !(await isInstanceOperator(db, input.inviter.id)))
      throw new TRPCError({ code: "FORBIDDEN" });
    await withMailboxRegistryAdmin(db, { teamId: input.teamId, userId: input.inviter.id }, (tx) =>
      operationsInvitationTargets(tx, input.teamId, input.operationsAccess!),
    );
  }
  if (inviteEmailsLimited(input.teamId)) throw INVITE_HOURLY_LIMIT_ERROR;
  try {
    const [row] = await db
      .insert(schema.teamInvitations)
      .values({
        teamId: input.teamId,
        email: input.email,
        role: input.role,
        operationsAccess: input.operationsAccess ?? null,
        invitedByUserId: input.inviter.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning({ id: schema.teamInvitations.id });
    if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const senderConfigured = inviteEmailsEnabled();
    const emailed =
      senderConfigured &&
      (await emailInvite(db, mail, input.teamId, input.inviter, {
        id: row.id,
        email: input.email,
        role: input.role,
        operationsAccess: input.operationsAccess,
      }));
    if (emailed) {
      await db
        .update(schema.teamInvitations)
        .set({ lastSentAt: new Date(), sendCount: 1 })
        .where(eq(schema.teamInvitations.id, row.id));
    }
    return {
      id: row.id,
      email: input.email,
      role: input.role,
      acceptUrl: inviteAcceptUrl(row.id),
      emailed,
      // Only a self-host operator can act on a missing sender; on Cloud
      // (and on a refused send anywhere) the dialog just says it could
      // not be sent.
      noSender: !senderConfigured && !isCloudDeployment(),
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TRPCError({ code: "CONFLICT", message: "Already invited." });
    }
    throw error;
  }
}

/**
 * Hard delete: a revoked invite should stop resolving entirely, and the
 * partial unique index only guards un-accepted rows, so re-inviting works.
 * Only a pending invite of `teamId` goes; anything else is NOT_FOUND.
 */
export async function revokeInvitation(db: Db, input: { teamId: string; id: string }) {
  const [row] = await db
    .delete(schema.teamInvitations)
    .where(
      and(
        eq(schema.teamInvitations.id, input.id),
        eq(schema.teamInvitations.teamId, input.teamId),
        isNull(schema.teamInvitations.acceptedAt),
      ),
    )
    .returning({
      id: schema.teamInvitations.id,
      email: schema.teamInvitations.email,
      role: schema.teamInvitations.role,
    });
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}

/**
 * Emails a pending invite of `teamId` again and renews its expiry.
 * Throttled three ways: a per-invite cooldown, a lifetime send cap per
 * invite (past it, revoke and re-invite), and the team's hourly
 * invite-email budget.
 */
export async function resendInvitation(
  db: Db,
  mail: SystemMailDeps,
  input: { teamId: string; id: string; inviter: Inviter },
) {
  if (!inviteEmailsEnabled()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No email sender is configured; share the invitation link instead.",
    });
  }
  const [invite] = await db
    .select({
      id: schema.teamInvitations.id,
      email: schema.teamInvitations.email,
      role: schema.teamInvitations.role,
      lastSentAt: schema.teamInvitations.lastSentAt,
      sendCount: schema.teamInvitations.sendCount,
      operationsAccess: schema.teamInvitations.operationsAccess,
    })
    .from(schema.teamInvitations)
    .where(
      and(
        eq(schema.teamInvitations.id, input.id),
        eq(schema.teamInvitations.teamId, input.teamId),
        isNull(schema.teamInvitations.acceptedAt),
      ),
    );
  if (!invite) throw new TRPCError({ code: "NOT_FOUND" });
  if (invite.sendCount >= INVITE_MAX_SENDS) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `This invitation was already sent ${INVITE_MAX_SENDS} times. Revoke it and invite again.`,
    });
  }
  if (invite.lastSentAt && Date.now() - invite.lastSentAt.getTime() < INVITE_RESEND_COOLDOWN_MS) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "This invitation was just sent. Wait a couple of minutes before resending.",
    });
  }
  if (inviteEmailsLimited(input.teamId)) throw INVITE_HOURLY_LIMIT_ERROR;
  const now = new Date();
  // The cooldown and the cap live in the same conditional update as the
  // counter bump, so two concurrent resends cannot both pass the pre-read.
  const [renewed] = await db
    .update(schema.teamInvitations)
    .set({
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      lastSentAt: now,
      sendCount: sql`${schema.teamInvitations.sendCount} + 1`,
    })
    .where(
      and(
        eq(schema.teamInvitations.id, invite.id),
        isNull(schema.teamInvitations.acceptedAt),
        lt(schema.teamInvitations.sendCount, INVITE_MAX_SENDS),
        or(
          isNull(schema.teamInvitations.lastSentAt),
          lt(
            schema.teamInvitations.lastSentAt,
            new Date(now.getTime() - INVITE_RESEND_COOLDOWN_MS),
          ),
        ),
      ),
    )
    .returning({ expiresAt: schema.teamInvitations.expiresAt });
  if (!renewed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "This invitation was just sent. Wait a couple of minutes before resending.",
    });
  }
  const role: InviteRole = invite.role === "admin" ? "admin" : "member";
  const emailed = await emailInvite(db, mail, input.teamId, input.inviter, {
    id: invite.id,
    email: invite.email,
    role,
    operationsAccess: invite.operationsAccess,
  });
  if (!emailed) {
    // Give the slot back: a send SES refused must not count against the
    // cap or start a cooldown. The renewed expiry is harmless to keep.
    await db
      .update(schema.teamInvitations)
      .set({ lastSentAt: invite.lastSentAt, sendCount: invite.sendCount })
      .where(eq(schema.teamInvitations.id, invite.id));
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The invitation email could not be sent. Try again in a moment.",
    });
  }
  return { id: invite.id, email: invite.email, role, expiresAt: renewed.expiresAt };
}
