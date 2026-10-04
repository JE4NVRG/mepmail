import { MailboxContentError } from "@millionsend/core";
import { z } from "zod";
import { getMailboxAttachmentResponse, MAILBOX_PRIVATE_HEADERS } from "@/server/mailbox-content";
import { mailboxAccessEnabled, mailboxRegistryEnabled } from "@/server/mailboxes";
import { createContext } from "@/server/trpc";

export const runtime = "nodejs";
const paramsSchema = z.object({
  mailboxId: z.uuid(),
  id: z.uuid(),
  index: z.string().regex(/^[0-9]$/),
});
export async function GET(
  request: Request,
  context: { params: Promise<{ mailboxId: string; id: string; index: string }> },
) {
  const empty = (status: number) =>
    new Response(null, { status, headers: MAILBOX_PRIVATE_HEADERS });
  if (!mailboxRegistryEnabled()) return empty(404);
  try {
    const ctx = await createContext({ headers: request.headers });
    if (!ctx.session) return empty(401);
    if (!ctx.teamId || !ctx.role || ctx.supportView) return empty(403);
    if (!mailboxAccessEnabled({ teamId: ctx.teamId, userId: ctx.session.user.id }))
      return empty(404);
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return empty(404);
    const url = new URL(request.url);
    const revision = z.coerce
      .number()
      .int()
      .min(1)
      .max(2147483647)
      .safeParse(url.searchParams.get("revision"));
    if (!revision.success) return empty(404);
    return await getMailboxAttachmentResponse(
      ctx.db,
      { teamId: ctx.teamId, userId: ctx.session.user.id },
      {
        mailboxId: params.data.mailboxId,
        id: params.data.id,
        index: Number(params.data.index),
        preview: url.searchParams.get("preview") === "1",
        revision: revision.data,
      },
    );
  } catch (error) {
    if (error instanceof MailboxContentError)
      return empty({ forbidden: 403, not_found: 404, invalid: 422, conflict: 409 }[error.code]);
    return empty(500);
  }
}
