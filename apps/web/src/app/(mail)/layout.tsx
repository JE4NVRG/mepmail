import { getDb } from "@millionsend/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ConfirmDialogHost } from "@/components/confirm-dialog";
import { SupportViewBanner } from "@/components/support-view-banner";
import { TeamStandingBanner } from "@/components/team-standing-banner";
import { ToastHost } from "@/components/toast";
import { CORREIO_PREFS_PREPAINT_SCRIPT } from "@/lib/mailbox-preferences-prepaint";
import { postAuthNext, withNext } from "@/lib/nav";
import { getAuth } from "@/server/auth";
import { ACTIVE_TEAM_COOKIE, getActiveMembership } from "@/server/membership";
import { resolveSupportView, SUPPORT_VIEW_COOKIE } from "@/server/support-view";

/**
 * Correio as its own app: the same session and team as the dashboard, but the
 * whole window for the inbox (no dashboard sidebar or page width cap). The
 * menu opens it in a separate tab.
 */
export default async function MailLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const next = postAuthNext(requestHeaders.get("x-mepmail-next"));
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect(withNext("/login", next));
  const db = getDb();
  const cookieStore = await cookies();
  const view = await resolveSupportView(
    db,
    session.user.id,
    cookieStore.get(SUPPORT_VIEW_COOKIE)?.value,
  );
  const membership = view
    ? null
    : await getActiveMembership(db, session.user.id, cookieStore.get(ACTIVE_TEAM_COOKIE)?.value);
  if (!(view ?? membership)) redirect(withNext("/onboarding", next));
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      {/* Before the inbox paints: density, preview lines, reading pane, avatars and a
          "system" theme from the last saved preferences, so the defaults never flash. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static preferences bootstrap, no user input */}
      <script dangerouslySetInnerHTML={{ __html: CORREIO_PREFS_PREPAINT_SCRIPT }} />
      {view ? (
        <SupportViewBanner
          grantId={view.grantId}
          teamId={view.teamId}
          teamName={view.teamName}
          expiresAt={view.expiresAt}
        />
      ) : null}
      <TeamStandingBanner />
      <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
      <ConfirmDialogHost />
      <ToastHost />
    </div>
  );
}
