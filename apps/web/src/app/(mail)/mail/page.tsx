import { HydrationBoundary } from "@tanstack/react-query";
import { headers } from "next/headers";
import { MailboxesView } from "@/app/(dashboard)/mailboxes/mailboxes-view";
import { apiBaseUrl } from "@/lib/api-base-url";
import { CORREIO_APP_METADATA } from "@/lib/correio-app-metadata";
import { prefetchMailPage } from "@/server/mail-page-prefetch";

export const metadata = CORREIO_APP_METADATA;

// The page carries mailbox content: it is rendered per request and never cached.
export const dynamic = "force-dynamic";

/** The Correio arrives with what it shows first (server/mail-page-prefetch). */
export default async function MailPage() {
  const state = await prefetchMailPage(await headers());
  const view = <MailboxesView layout="app" correioMcpUrl={`${apiBaseUrl()}/mcp/correio`} />;
  return state ? <HydrationBoundary state={state}>{view}</HydrationBoundary> : view;
}
