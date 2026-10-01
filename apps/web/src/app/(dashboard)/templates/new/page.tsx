import { getDb } from "@millionsend/db";
import { cookies, headers } from "next/headers";
import { getLocale } from "next-intl/server";
import { getAuth } from "@/server/auth";
import { ACTIVE_TEAM_COOKIE, getActiveMembership } from "@/server/membership";
import { isStarterKey, renderStarter } from "@/server/starter-templates";
import { resolveSupportView, SUPPORT_VIEW_COOKIE } from "@/server/support-view";
import { TemplateEditor } from "../editor";
import { StarterGallery } from "./starter-gallery";

export default async function NewTemplatePage({
  searchParams,
}: {
  searchParams: Promise<{ starter?: string | string[] }>;
}) {
  const { starter: key } = await searchParams;
  if (typeof key === "string" && isStarterKey(key)) {
    const locale = await getLocale();
    const template = renderStarter(key, locale);
    const session = await getAuth().api.getSession({ headers: await headers() });
    const cookieStore = await cookies();
    const view = session
      ? await resolveSupportView(
          getDb(),
          session.user.id,
          cookieStore.get(SUPPORT_VIEW_COOKIE)?.value,
        )
      : null;
    const membership =
      session && !view
        ? await getActiveMembership(
            getDb(),
            session.user.id,
            cookieStore.get(ACTIVE_TEAM_COOKIE)?.value,
          )
        : null;
    const team = view?.teamId ?? membership?.teamId ?? "no-team";
    if (session && template)
      return (
        <TemplateEditor
          key={`${session.user.id}:${team}:${key}:${locale}`}
          starter={{
            name: template.name,
            subject: template.subject,
            html: template.html,
            text: template.text,
            document: null,
          }}
          draftKey={`${session.user.id}:${team}:${key}:${locale}`}
        />
      );
  }
  return <StarterGallery />;
}
