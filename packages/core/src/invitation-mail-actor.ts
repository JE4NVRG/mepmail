import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { isInstanceOperator } from "./instance-operator.js";
import { getSignupSendingRestriction } from "./signup-risk-enforcement.js";
import { findSuppressed } from "./suppressions.js";
import { INVITE_MAX_SENDS } from "./team-invitations.js";
import { fetchTeamStanding } from "./team-standing.js";

/** Internal argument only: never populated from a message, public tag or API DTO. */
export interface InvitationMailActor {
  teamId: string;
  userId: string;
  invitationId: string;
}
export const INVITATION_MAIL_ACTOR = Symbol("invitation-mail-actor");

/** The sender owner remains the transport/billing owner, not the requesting authority.
 * Fixed invitation copy needs no customer domain or campaign grant. Existing invite
 * hourly/cooldown limits stay at the producer; the durable per-invite cap is checked
 * here too. No customer quota reservation or financial entitlement is created here. */
export async function invitationMailRefusal(
  db: Db,
  actor: InvitationMailActor | undefined,
  recipients: readonly string[],
  isCloud: boolean,
): Promise<string | null> {
  if (
    !actor ||
    typeof actor.teamId !== "string" ||
    !actor.teamId ||
    typeof actor.userId !== "string" ||
    !actor.userId ||
    typeof actor.invitationId !== "string" ||
    !actor.invitationId ||
    recipients.length !== 1
  )
    return "invitation_actor_requires_reissue";
  const [invite] = await db
    .select()
    .from(schema.teamInvitations)
    .where(
      and(
        eq(schema.teamInvitations.id, actor.invitationId),
        eq(schema.teamInvitations.teamId, actor.teamId),
        isNull(schema.teamInvitations.acceptedAt),
      ),
    );
  if (
    !invite ||
    invite.expiresAt.getTime() <= Date.now() ||
    invite.email.toLowerCase() !== recipients[0]?.toLowerCase() ||
    invite.sendCount > INVITE_MAX_SENDS
  )
    return "invitation_actor_requires_reissue";
  const [membership] = await db
    .select({ role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    );
  if (
    membership?.role !== "owner" &&
    membership?.role !== "admin" &&
    !(await isInstanceOperator(db, actor.userId))
  )
    return "invitation_actor_revoked";
  const standing = await fetchTeamStanding(db, actor.teamId);
  if (
    !standing ||
    standing.suspended ||
    standing.sendReview ||
    (standing.dailySendCeiling !== null && standing.dailySendCeiling <= 0)
  )
    return "invitation_actor_restricted";
  // A real hold is not cleared by fixed platform copy. Sandbox is not a DNS
  // prerequisite for inviting a teammate: it still has the existing invite budget.
  if ((await getSignupSendingRestriction(db, actor.teamId, isCloud)).kind === "review")
    return "invitation_actor_restricted";
  // Unlike marketing topic unsubscribe, final recipient opt-out is authoritative.
  if ((await findSuppressed(db, actor.teamId, [...recipients])).size > 0) return "all_suppressed";
  return null;
}
