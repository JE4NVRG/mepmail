import { listMailboxAgentAccounts } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { mailboxAgentTokenRequest } from "@/server/mailbox-agent";

/** The mailboxes this agent credential reaches (no message content): one for an mmb_ key. */
export async function GET(request: Request) {
  return mailboxAgentTokenRequest(request, (token) => listMailboxAgentAccounts(getDb(), token));
}
