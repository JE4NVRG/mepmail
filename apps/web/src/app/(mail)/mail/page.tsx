import { MailboxesView } from "@/app/(dashboard)/mailboxes/mailboxes-view";
import { apiBaseUrl } from "@/lib/api-base-url";

export const metadata = { title: "Correio" };

export default function MailPage() {
  return <MailboxesView layout="app" correioMcpUrl={`${apiBaseUrl()}/mcp/correio`} />;
}
