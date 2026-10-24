import { parseOperationsAccess } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { postAuthNext, withNext } from "@/lib/nav";
import { getAuth } from "@/server/auth";
import { ACTIVE_TEAM_COOKIE, getActiveMembership } from "@/server/membership";
import { resolveRequestMembership } from "@/server/request-membership";

/** Navigation only: destination pages and APIs retain their own authorization gates. */
export default async function PostLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = postAuthNext((await searchParams).next, "", true);
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect(withNext("/login", next));
  // Invites may establish the very first membership. Explicit destinations own
  // their guards (dashboard/mail layouts preserve deep links through onboarding).
  if (next) redirect(next);

  const db = getDb();
  const membership = await getActiveMembership(
    db,
    session.user.id,
    (await cookies()).get(ACTIVE_TEAM_COOKIE)?.value,
  );
  if (!membership) redirect(withNext("/onboarding", next));
  // Read the selected membership again, including restrictions and revocation.
  // Neither the selection cookie nor a cached session role grants capabilities.
  const live = await resolveRequestMembership({ db, session, teamId: membership.teamId });
  if (!live) redirect(withNext("/onboarding", next));

  if (live.operationsAccess !== null) {
    const access = parseOperationsAccess(live.operationsAccess);
    // A mailbox-only/revoked/malformed profile must not acquire directory access
    // (or be mistaken for an unrestricted member). The destination still gates it.
    redirect(
      live.role === "member" && live.verified && !live.suspendedAt && access?.userDirectoryRead
        ? "/operations/users"
        : "/mail",
    );
  }
  redirect("/emails");
}
