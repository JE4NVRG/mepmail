import {
  findMailboxSearchMatches,
  listMailboxFolders,
  listMailboxRegistry,
  type MailboxContentActor,
  MailboxContentError,
  type MailboxSearchFolder,
  type MailboxSearchPosition,
  mailboxSearchPhraseText,
  mailboxSearchQueryEmpty,
  mailboxSearchQueryTokens,
  parseMailboxSearchQuery,
  withMailboxItems,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { simpleParser } from "mailparser";
import { getKeyring } from "./keyring";
import {
  buildMailboxListRows,
  decodeMailboxListCursor,
  encodeMailboxListCursor,
  type MailboxListMetadata,
} from "./mailbox-content";
import { mailboxSearchKey } from "./mailbox-search-key";

const SEARCH_DEFAULT = 25;
const SEARCH_MAX = 50;
/** Candidates read per round when a phrase must be checked, and rounds per page. */
const PHRASE_BATCH = 100;
const PHRASE_ROUNDS = 4;

/** Where a found message lives, for the result row's label. */
export type MailboxSearchRowFolder =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "trash"
  | "spam"
  | `custom:${string}`;

function folderOf(row: {
  kind: "inbox" | "draft" | "sent";
  deliveryFolder: string;
  trashedAt: Date | null;
  archivedAt: Date | null;
  folderId: string | null;
}): MailboxSearchRowFolder {
  if (row.trashedAt) return "trash";
  if (row.deliveryFolder === "spam") return "spam";
  if (row.kind === "draft") return "drafts";
  if (row.kind === "sent") return "sent";
  if (row.archivedAt) return "archive";
  if (row.folderId) return `custom:${row.folderId}`;
  return "inbox";
}

/** The candidates whose subject or body contains every phrase, read with live access. */
async function withPhrases<T extends { id: string; mailboxId: string }>(
  db: Db,
  actor: MailboxContentActor,
  rows: T[],
  phrases: string[],
): Promise<T[]> {
  const keep = new Set<string>();
  const byMailbox = new Map<string, string[]>();
  for (const row of rows)
    byMailbox.set(row.mailboxId, [...(byMailbox.get(row.mailboxId) ?? []), row.id]);
  for (const [mailboxId, ids] of byMailbox)
    await withMailboxItems(db, getKeyring(), actor, { mailboxId, ids }, async (items) => {
      for (const item of items) {
        const mime = await simpleParser(item.raw, { skipImageLinks: true, skipTextToHtml: true });
        const text = mailboxSearchPhraseText(`${mime.subject ?? ""}\n${mime.text ?? ""}`);
        if (phrases.every((phrase) => text.includes(phrase))) keep.add(`${mailboxId}:${item.id}`);
      }
    });
  return rows.filter((row) => keep.has(`${row.mailboxId}:${row.id}`));
}

/**
 * Correio search over the blind index: the same rows items returns, plus each one's
 * folder, newest first, a page at a time. Words match in any field (header words also
 * by their start), operators narrow the field, and quoted phrases are checked on the
 * decrypted candidates. Only mailboxes the caller can read are searched, and every row
 * is read with live access, as in a listing.
 */
export async function searchMailboxContent(
  db: Db,
  actor: MailboxContentActor,
  input: {
    query: string;
    mailboxId: string | null;
    folder?: MailboxSearchFolder | undefined;
    customFolderId?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  },
) {
  actor = { ...actor };
  input = { ...input };
  if (actor.agentAccess) throw new MailboxContentError("forbidden");
  const key = mailboxSearchKey();
  if (!key) throw new MailboxContentError("forbidden");
  const pageSize = input.limit ?? SEARCH_DEFAULT;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SEARCH_MAX)
    throw new MailboxContentError("invalid");
  const folder = input.folder ?? "all";
  if (
    (folder === "custom" && (!input.mailboxId || !input.customFolderId)) ||
    (folder !== "custom" && input.customFolderId !== undefined)
  )
    throw new MailboxContentError("invalid");
  let position: MailboxSearchPosition | undefined =
    input.cursor === undefined ? undefined : decodeMailboxListCursor(input.cursor);
  const query = parseMailboxSearchQuery(input.query);
  if (mailboxSearchQueryEmpty(query)) return { items: [], nextCursor: null, tooShort: true };
  if (folder === "custom" && input.mailboxId) {
    const folders = await listMailboxFolders(db, actor, { mailboxId: input.mailboxId });
    if (!folders.some((entry) => entry.id === input.customFolderId))
      throw new MailboxContentError("not_found");
  }
  const registry = await listMailboxRegistry(db, actor);
  const readable = registry.mailboxes.filter(
    (box) =>
      box.canRead && box.status === "planned" && (!input.mailboxId || box.id === input.mailboxId),
  );
  if (input.mailboxId && !readable.length) throw new MailboxContentError("forbidden");
  const boxes = new Map(readable.map((box) => [box.id, box]));
  const groups = mailboxSearchQueryTokens(key, actor.teamId, query);
  const phrased = query.phrases.length > 0;
  const batch = phrased ? PHRASE_BATCH : pageSize + 1;
  const found: MailboxListMetadata[] = [];
  let examinedTo: MailboxSearchPosition | undefined;
  let exhausted = false;
  for (let round = 0; round < (phrased ? PHRASE_ROUNDS : 1) && found.length <= pageSize; round++) {
    const rows = await findMailboxSearchMatches(db, {
      teamId: actor.teamId,
      mailboxIds: [...boxes.keys()],
      groups,
      folder,
      customFolderId: input.customFolderId,
      after: query.after,
      before: query.before,
      position,
      limit: batch,
    });
    const accepted = phrased ? await withPhrases(db, actor, rows, query.phrases) : rows;
    for (const row of accepted) {
      const box = boxes.get(row.mailboxId);
      if (box)
        found.push({
          ...row,
          address: box.address,
          mailboxLabel: box.label,
          mailboxKind: box.kind,
        });
    }
    const last = rows.at(-1);
    if (rows.length < batch || !last) {
      exhausted = true;
      break;
    }
    position = examinedTo = { at: last.orderAt, id: last.id };
  }
  const shown = found.slice(0, pageSize);
  const tail = shown.at(-1);
  // More rows found than shown: continue after the last shown. A phrase search that ran
  // out of rounds continues after the last candidate it checked, even with nothing shown.
  const nextCursor =
    found.length > pageSize && tail
      ? encodeMailboxListCursor({ at: tail.orderAt, id: tail.id })
      : phrased && !exhausted && examinedTo
        ? encodeMailboxListCursor(examinedTo)
        : null;
  const items = await buildMailboxListRows(db, actor, shown);
  return {
    items: items.map((item) => ({ ...item, folder: folderOf(item) })),
    nextCursor,
    tooShort: false,
  };
}
