import { getUntypedClient, type TRPCClient } from "@trpc/client";
import type { AppRouter } from "@/server/routers";

/**
 * Server search in the Correio (mailboxes.search): every folder and mailbox
 * in scope, not only the rows the list has loaded. The local filter answers
 * while the server looks; a search shorter than two characters stays local.
 */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 200;
/** Typing pauses this long before the server is asked. */
export const SEARCH_DEBOUNCE_MS = 350;
/** The react-query key of server search results, for invalidation after changes. */
export const SEARCH_QUERY_KEY = "mailboxes.search";

/**
 * The folders a result can live in, as the server names them; a custom folder
 * comes as `custom:<id>`. "all" covers everything but the trash and spam
 * (quarantined mail is never indexed).
 */
export const SEARCH_RESULT_FOLDERS = [
  "inbox",
  "sent",
  "drafts",
  "archive",
  "trash",
  "spam",
] as const;
export type SearchResultFolder = (typeof SEARCH_RESULT_FOLDERS)[number];

/** The id of a custom folder in a result's `folder`, or null. */
export function customFolderOf(folder: string | undefined): string | null {
  return folder?.startsWith("custom:") ? folder.slice("custom:".length) || null : null;
}

/** What goes to the server: the trimmed query, or null when it stays local. */
export function serverSearchTerm(raw: string): string | null {
  const query = raw.trim().replace(/\s+/g, " ");
  return query.length >= SEARCH_MIN_LENGTH && query.length <= SEARCH_MAX_LENGTH ? query : null;
}

export function isSearchResultFolder(value: unknown): value is SearchResultFolder {
  return (SEARCH_RESULT_FOLDERS as readonly unknown[]).includes(value);
}

export type SearchInput = {
  query: string;
  mailboxId: string | null;
  folder: "all";
  cursor?: string;
  limit: number;
};
export type SearchPage<Row> = {
  items: (Row & { folder?: string })[];
  nextCursor: string | null;
  /** Only one-letter terms (or nothing) once normalized: no search ran. */
  tooShort?: boolean;
};

/**
 * One page of results. The call goes by path through the untyped client, so
 * this compiles before the router has mailboxes.search; once it does, the
 * typed procedure replaces these lines.
 */
export function searchMailboxes<Row>(
  client: TRPCClient<AppRouter>,
  input: SearchInput,
): Promise<SearchPage<Row>> {
  return getUntypedClient(client).query("mailboxes.search", input) as Promise<SearchPage<Row>>;
}
