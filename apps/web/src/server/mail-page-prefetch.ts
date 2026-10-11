import { type DehydratedState, dehydrate, QueryClient } from "@tanstack/react-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { settleWithin } from "../lib/settle-within";
import { mailboxActorAccessEnabled } from "./mailboxes";
import { appRouter } from "./routers";
import { createContext } from "./trpc";

/** How long the page may wait for its first data; past it, the browser asks as before. */
export const MAIL_PREFETCH_BUDGET_MS = 1200;

/**
 * What the Correio shows first, read on the server so the page arrives with it:
 * the mailboxes, the Inbox of all of them (first page, the client's own limit),
 * the preferences and the unread counts. Without it the browser asks for them
 * only after the page's code has run, one more round trip before the inbox.
 * Nothing is read without a session and a team, in a support view, or when the
 * Correio is not open to this person; only queries that finished within the
 * budget go to the page, and the browser asks for the rest itself.
 */
export async function prefetchMailPage(headers: Headers): Promise<DehydratedState | null> {
  // The prefetch never takes the page down: any failure (createContext tidying a
  // stale support-view cookie, which a Server Component may not modify, a read
  // that throws) just leaves the page to load its data as it always did.
  try {
    return await prefetch(headers);
  } catch (error) {
    console.warn("mail prefetch skipped", error);
    return null;
  }
}

async function prefetch(headers: Headers): Promise<DehydratedState | null> {
  const ctx = await createContext({ headers });
  if (!ctx.session || !ctx.teamId || ctx.supportView) return null;
  if (
    !(await mailboxActorAccessEnabled(ctx.db, {
      teamId: ctx.teamId,
      userId: ctx.session.user.id,
    }))
  )
    return null;
  const queryClient = new QueryClient();
  const trpc = createTRPCOptionsProxy({ ctx, router: appRouter, queryClient });
  await settleWithin(
    [
      queryClient.prefetchQuery(trpc.mailboxes.capabilities.queryOptions()),
      queryClient.prefetchQuery(trpc.mailboxes.list.queryOptions()),
      queryClient.prefetchQuery(trpc.mailboxes.preferences.get.queryOptions()),
      queryClient.prefetchQuery(trpc.mailboxes.unreadCounts.queryOptions()),
      queryClient.prefetchInfiniteQuery(
        trpc.mailboxes.items.infiniteQueryOptions(
          { mailboxId: null, folder: "inbox", mailboxKind: undefined },
          { getNextPageParam: (page) => page.nextCursor },
        ),
      ),
    ],
    MAIL_PREFETCH_BUDGET_MS,
  );
  // Successful queries only (TanStack's default): a pending or failed one is left out.
  return dehydrate(queryClient);
}
