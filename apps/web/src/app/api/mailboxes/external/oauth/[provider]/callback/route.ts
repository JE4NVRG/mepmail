import type { NextRequest } from "next/server";
import {
  finishMailboxExternalOAuth,
  MAILBOX_EXTERNAL_OAUTH_COOKIE,
} from "@/server/mailbox-external-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The provider sends the browser back here (redirect URI registered with each provider). */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  return finishMailboxExternalOAuth(
    request,
    provider,
    request.cookies.get(MAILBOX_EXTERNAL_OAUTH_COOKIE)?.value,
  );
}
