import { z } from "zod";
import { mailboxAgentSendRequest, MAILBOX_AGENT_HEADERS } from "@/server/mailbox-agent";

const input = z
  .object({
    id: z.uuid(),
    expectedRevision: z.number().int().min(1).max(2147483646),
  })
  .strict();

/** Bearer selects the mailbox. Only an exact saved draft revision can be submitted. */
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
    if (bytes > 4096) {
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
  return mailboxAgentSendRequest(request, parsed.data);
}
