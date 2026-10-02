import { z } from "zod";
import { mailboxAgentRequest, MAILBOX_AGENT_HEADERS } from "@/server/mailbox-agent";
import { saveMailboxContentDraft } from "@/server/mailbox-content";

const input = z
  .object({
    id: z.uuid().optional(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    sourceItemId: z.uuid().optional(),
    to: z.array(z.email().max(254)).min(1).max(20),
    subject: z
      .string()
      .max(998)
      .regex(/^[^\r\n]*$/),
    text: z.string().max(262144),
    retainedAttachments: z.array(z.number().int().min(0).max(9)).max(10),
    uploads: z
      .array(
        z
          .object({ filename: z.string().min(1).max(160), base64: z.string().min(1).max(349528) })
          .strict(),
      )
      .max(10),
  })
  .strict();
export async function POST(request: Request) {
  // Streaming cap avoids allocating an unbounded body before validating JSON.
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
  return mailboxAgentRequest(request, "draft", ({ db, actor, mailboxId }) =>
    saveMailboxContentDraft(db, actor, { ...parsed.data, mailboxId }),
  );
}
