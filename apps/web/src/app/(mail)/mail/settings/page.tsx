import { MailboxesView } from "@/app/(dashboard)/mailboxes/mailboxes-view";
import { apiBaseUrl } from "@/lib/api-base-url";
import { CORREIO_APP_METADATA } from "@/lib/correio-app-metadata";

export const metadata = CORREIO_APP_METADATA;

export default function MailSettingsPage() {
  return <MailboxesView layout="settings" correioMcpUrl={`${apiBaseUrl()}/mcp/correio`} />;
}
