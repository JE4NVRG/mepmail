import { createHash } from "node:crypto";
import { appendMailboxActivity } from "@millionsend/core";
import { z } from "zod";
import { MAILBOX_AGENT_HEADERS, mailboxAgentResponseRequest } from "@/server/mailbox-agent";
import { getMailboxAttachmentResponse } from "@/server/mailbox-content";

/**
 * One attachment's bytes for an agent with read access: the message id and revision
 * from mailbox_read_message (a changed message is a conflict, never another file) and
 * the attachment's index there. Same authorization as reading the message: the mailbox
 * the credential reached, never quarantine or Spam. Served as a private download
 * (octet-stream, no-store, sandboxed) with the SHA-256 of the bytes in a header so the
 * client can check what it received. No URL to fetch is ever minted.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = z
    .object({
      id: z.uuid(),
      revision: z.coerce.number().int().min(1).max(2147483647),
      index: z.coerce.number().int().min(0).max(99),
    })
    .strict()
    .safeParse(Object.fromEntries(url.searchParams));
  if (!query.success)
    return Response.json({ error: "invalid" }, { status: 400, headers: MAILBOX_AGENT_HEADERS });
  return mailboxAgentResponseRequest(request, "read", async ({ db, actor, mailboxId, keyId }) => {
    const response = await getMailboxAttachmentResponse(db, actor, {
      mailboxId,
      id: query.data.id,
      index: query.data.index,
      revision: query.data.revision,
      preview: false,
    });
    await appendMailboxActivity(
      db,
      { teamId: actor.teamId, mailboxId, actor: { kind: "mailbox_agent", keyId } },
      { action: "mailbox.item_read", itemId: query.data.id, revision: query.data.revision },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("X-MepMail-Attachment-SHA256", createHash("sha256").update(bytes).digest("hex"));
    headers.set("Vary", MAILBOX_AGENT_HEADERS.Vary);
    return new Response(bytes, { status: 200, headers });
  });
}
