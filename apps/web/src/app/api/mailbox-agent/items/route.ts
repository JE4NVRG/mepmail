import { appendMailboxActivity } from "@millionsend/core";
import { z } from "zod";
import { MAILBOX_AGENT_HEADERS, mailboxAgentRequest } from "@/server/mailbox-agent";
import { getMailboxContent, getMailboxContentList } from "@/server/mailbox-content";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = z
    .object({
      id: z.uuid().optional(),
      folder: z.enum(["inbox", "drafts", "sent"]).default("inbox"),
      // The previous page's nextCursor; pages are newest first.
      cursor: z.string().min(1).max(80).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .strict()
    .safeParse(Object.fromEntries(url.searchParams));
  if (!query.success)
    return Response.json({ error: "invalid" }, { status: 400, headers: MAILBOX_AGENT_HEADERS });
  return mailboxAgentRequest(request, "read", async ({ db, actor, mailboxId, keyId }) => {
    const context = {
      teamId: actor.teamId,
      mailboxId,
      actor: { kind: "mailbox_agent" as const, keyId },
    };
    if (query.data.id) {
      const result = await getMailboxContent(db, actor, { mailboxId, id: query.data.id });
      await appendMailboxActivity(db, context, {
        action: "mailbox.item_read",
        itemId: result.id,
        revision: result.revision,
      });
      return result;
    }
    const result = await getMailboxContentList(db, actor, {
      mailboxId,
      folder: query.data.folder,
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      ...(query.data.limit ? { limit: query.data.limit } : {}),
    });
    await appendMailboxActivity(db, context, {
      action: "mailbox.items_listed",
      folder: query.data.folder,
      count: result.items.length,
    });
    return result;
  });
}
