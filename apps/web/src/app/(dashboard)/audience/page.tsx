import { isCloudDeployment } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { cookies, headers } from "next/headers";
import { CampaignConsentClient } from "@/components/campaign-consent";
import { apiBaseUrl } from "@/lib/api-base-url";
import { getAuth } from "@/server/auth";
import { ACTIVE_TEAM_COOKIE, getActiveMembership } from "@/server/membership";
import { resolveSupportView, SUPPORT_VIEW_COOKIE } from "@/server/support-view";
import { AudienceContactsView } from "./contacts-view";

export default async function AudiencePage() {
  const cloud = isCloudDeployment();
  let canSubmit = false;
  if (cloud) {
    const session = await getAuth().api.getSession({ headers: await headers() });
    if (session) {
      const db = getDb();
      const cookieStore = await cookies();
      const view = await resolveSupportView(
        db,
        session.user.id,
        cookieStore.get(SUPPORT_VIEW_COOKIE)?.value,
      );
      const membership = view
        ? null
        : await getActiveMembership(
            db,
            session.user.id,
            cookieStore.get(ACTIVE_TEAM_COOKIE)?.value,
          );
      canSubmit = membership?.role === "owner" || membership?.role === "admin";
    }
  }
  return (
    <>
      {cloud && <CampaignConsentClient canSubmit={canSubmit} />}
      <AudienceContactsView migrateToUrl={cloud ? null : apiBaseUrl()} />
    </>
  );
}
