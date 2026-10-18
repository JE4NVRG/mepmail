import {
  grantMailboxRegistry,
  isInstanceOperator,
  operationsInvitationTargets,
  parseOperationsInvitationAccess,
  withMailboxRegistryAdmin,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";

/** Called inside the invitation-claim transaction; no password, email or provider action. */
export async function activateOperationsInvitation(
  db: Db,
  userId: string,
  invite: Pick<
    typeof schema.teamInvitations.$inferSelect,
    "teamId" | "email" | "role" | "invitedByUserId" | "operationsAccess"
  >,
) {
  if (!invite.operationsAccess) return null;
  const access = parseOperationsInvitationAccess(invite.operationsAccess);
  const issuer = invite.invitedByUserId;
  if (!access || invite.role !== "member" || !issuer || !(await isInstanceOperator(db, issuer)))
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This operational invitation is no longer authorized.",
    });
  const [person] = await db
    .select({ email: schema.user.email, verified: schema.user.emailVerified })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .for("share");
  if (!person?.verified || person.email.toLowerCase() !== invite.email.toLowerCase())
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Verify the invited email address before accepting this profile.",
    });
  const actor = { teamId: invite.teamId, userId: issuer };
  return withMailboxRegistryAdmin(db, actor, async (transaction) => {
    const targets = await operationsInvitationTargets(transaction, invite.teamId, access);
    const [membership] = await transaction
      .select({
        id: schema.teamMembers.id,
        role: schema.teamMembers.role,
        operationsAccess: schema.teamMembers.operationsAccess,
      })
      .from(schema.teamMembers)
      .where(
        and(eq(schema.teamMembers.teamId, invite.teamId), eq(schema.teamMembers.userId, userId)),
      )
      .for("update");
    if (membership?.role !== "member") throw new TRPCError({ code: "FORBIDDEN" });
    // A new profile must not silently pretend that older, broader rights disappeared.
    const previousGrants = await transaction
      .select({ mailboxId: schema.mailboxGrants.mailboxId })
      .from(schema.mailboxGrants)
      .where(
        and(
          eq(schema.mailboxGrants.teamId, invite.teamId),
          eq(schema.mailboxGrants.userId, userId),
          eq(schema.mailboxGrants.membershipId, membership.id),
          isNull(schema.mailboxGrants.revokedAt),
        ),
      )
      .for("share");
    const owned = await transaction
      .select({ mailboxId: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(
        and(
          eq(schema.mailboxes.teamId, invite.teamId),
          eq(schema.mailboxes.ownerUserId, userId),
          eq(schema.mailboxes.ownerMembershipId, membership.id),
        ),
      )
      .for("share");
    if (
      membership.operationsAccess ||
      [...previousGrants, ...owned].some((m) => !access.sendMailboxIds.includes(m.mailboxId))
    )
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Review this member's existing mailbox access before activating a restricted profile.",
      });
    const { sendMailboxIds, ...operationsAccess } = access;
    await transaction
      .update(schema.teamMembers)
      .set({ operationsAccess })
      .where(eq(schema.teamMembers.id, membership.id));
    for (const mailboxId of [...sendMailboxIds].sort()) {
      await grantMailboxRegistry(transaction, actor, { mailboxId, userId, permission: "send" });
    }
    return {
      issuer,
      membershipId: membership.id,
      domainIds: targets.domains.map((d) => d.id),
      sendMailboxIds: targets.mailboxes.map((m) => m.id),
    };
  });
}
