import { z } from "zod";
import { mailboxAgentRequest, MAILBOX_AGENT_HEADERS } from "@/server/mailbox-agent";
import { getMailboxContent, getMailboxContentList } from "@/server/mailbox-content";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = z
    .object({
      id: z.uuid().optional(),
      folder: z.enum(["inbox", "drafts", "sent"]).default("inbox"),
    })
    .strict()
    .safeParse(Object.fromEntries(url.searchParams));
  if (!query.success)
    return Response.json({ error: "invalid" }, { status: 400, headers: MAILBOX_AGENT_HEADERS });
  return mailboxAgentRequest(request, "read", ({ db, actor, mailboxId }) =>
    query.data.id
      ? getMailboxContent(db, actor, { mailboxId, id: query.data.id })
      : getMailboxContentList(db, actor, { mailboxId, folder: query.data.folder }),
  );
}
