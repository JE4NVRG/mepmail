import { appendMailboxActivity } from "@millionsend/core";
import { z } from "zod";
import { MAILBOX_AGENT_HEADERS, mailboxAgentRequest } from "@/server/mailbox-agent";
import { openMailboxAgentCursor, signMailboxAgentCursor } from "@/server/mailbox-agent-cursor";
import { getMailboxContent, getMailboxContentList } from "@/server/mailbox-content";
import { searchMailboxContent } from "@/server/mailbox-search";

/** A day (UTC midnight) or an exact ISO time. */
const moment = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((value) => new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value));
/** A filter value as one quoted operator term: quotes would end it early. */
const term = (value: string) => value.replace(/["\s]+/g, " ").trim();

/** The search text the operators in `from` and `subject` add to `q`. */
function searchText(q?: string, from?: string, subject?: string) {
  return [
    q?.trim() ?? "",
    from && term(from) ? `de:"${term(from)}"` : "",
    subject && term(subject) ? `assunto:"${term(subject)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * One message (`id`) or one page of a folder, newest first. Pages chain through the
 * signed `nextCursor` until `hasMore` is false; filters run on the server before the
 * page is cut. `q`, `from` and `subject` search the mailbox's index (words, quoted
 * phrases, operators); `unread`, `after` and `before` narrow either mode. A short or
 * empty page never proves a message is absent from the mailbox: see the docs.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = z
    .object({
      id: z.uuid().optional(),
      folder: z.enum(["inbox", "drafts", "sent"]).default("inbox"),
      // The previous page's nextCursor, valid only with the same mailbox and filters.
      cursor: z.string().min(1).max(256).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      q: z.string().min(1).max(200).optional(),
      from: z.string().min(1).max(254).optional(),
      subject: z.string().min(1).max(200).optional(),
      after: moment.optional(),
      before: moment.optional(),
      unread: z.enum(["true", "false"]).optional(),
    })
    .strict()
    .safeParse(Object.fromEntries(url.searchParams));
  if (!query.success)
    return Response.json({ error: "invalid" }, { status: 400, headers: MAILBOX_AGENT_HEADERS });
  const input = query.data;
  const unread = input.unread === "true";
  const text = searchText(input.q, input.from, input.subject);
  const search = text.length > 0;
  return mailboxAgentRequest(request, "read", async ({ db, actor, mailboxId, keyId }) => {
    const context = {
      teamId: actor.teamId,
      mailboxId,
      actor: { kind: "mailbox_agent" as const, keyId },
    };
    if (input.id) {
      const result = await getMailboxContent(db, actor, { mailboxId, id: input.id });
      await appendMailboxActivity(db, context, {
        action: "mailbox.item_read",
        itemId: result.id,
        revision: result.revision,
      });
      return result;
    }
    const scope = {
      teamId: actor.teamId,
      mailboxId,
      filters: JSON.stringify([
        search ? "search" : "list",
        input.folder,
        text,
        input.after?.toISOString() ?? null,
        input.before?.toISOString() ?? null,
        unread,
      ]),
    };
    const position = input.cursor ? openMailboxAgentCursor(scope, input.cursor) : undefined;
    const filters = {
      ...(unread ? { unread: true } : {}),
      ...(input.after ? { after: input.after } : {}),
      ...(input.before ? { before: input.before } : {}),
    };
    if (search) {
      const found = await searchMailboxContent(db, actor, {
        query: text,
        mailboxId,
        folder: input.folder,
        ...(position ? { cursor: position } : {}),
        // Search pages hold at most 50 rows.
        ...(input.limit ? { limit: Math.min(input.limit, 50) } : {}),
        ...filters,
      });
      await appendMailboxActivity(db, context, {
        action: "mailbox.items_listed",
        folder: input.folder,
        count: found.items.length,
      });
      const nextCursor = signMailboxAgentCursor(scope, found.nextCursor);
      return {
        items: found.items,
        nextCursor,
        hasMore: nextCursor !== null,
        mode: "search" as const,
        // No usable word in the query: nothing was searched.
        tooShort: found.tooShort,
      };
    }
    const result = await getMailboxContentList(db, actor, {
      mailboxId,
      folder: input.folder,
      ...(position ? { cursor: position } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
      ...filters,
    });
    await appendMailboxActivity(db, context, {
      action: "mailbox.items_listed",
      folder: input.folder,
      count: result.items.length,
    });
    const nextCursor = signMailboxAgentCursor(scope, result.nextCursor);
    return { ...result, nextCursor, hasMore: nextCursor !== null, mode: "list" as const };
  });
}
