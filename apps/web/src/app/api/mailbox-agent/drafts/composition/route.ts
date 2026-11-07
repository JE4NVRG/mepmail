import { z } from "zod";
import { MAILBOX_AGENT_HEADERS, mailboxAgentRequest } from "@/server/mailbox-agent";
import { verifyMailboxDraftComposition } from "@/server/mailbox-content";

const input = z
  .object({
    id: z.uuid(),
    expectedRevision: z.number().int().min(1).max(2147483646),
    sourceItemId: z.uuid(),
    mode: z.literal("reply"),
    to: z.array(z.email().max(254)).length(1),
    subject: z
      .string()
      .max(998)
      .regex(/^[^\r\n]*$/),
    text: z.string().max(262144),
    retainedAttachments: z.array(z.never()).length(0),
    uploads: z.array(z.never()).length(0),
  })
  .strict();

/** Verification only: no save, send, activity mutation or draft recreation. */
export async function POST(request: Request) {
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json({ error: "invalid" }, { status: 400, headers: MAILBOX_AGENT_HEADERS });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > 1500000) {
      await reader.cancel();
      return Response.json({ error: "too_large" }, { status: 413, headers: MAILBOX_AGENT_HEADERS });
    }
    chunks.push(result.value);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    body = null;
  }
  const parsed = input.safeParse(body);
  if (!parsed.success)
    return Response.json({ error: "invalid" }, { status: 400, headers: MAILBOX_AGENT_HEADERS });
  return mailboxAgentRequest(request, "draft", async ({ db, actor, mailboxId }) => ({
    composition: await verifyMailboxDraftComposition(db, actor, { ...parsed.data, mailboxId }),
  }));
}
