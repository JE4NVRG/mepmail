import { apiBaseUrl } from "@/lib/api-base-url";
import { MailboxesView } from "./mailboxes-view";

export default function MailboxesPage() {
  return <MailboxesView correioMcpUrl={`${apiBaseUrl()}/mcp/correio`} />;
}
