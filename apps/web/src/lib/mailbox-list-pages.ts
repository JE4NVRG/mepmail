/**
 * The Correio list keeps several cursor pages but polls only the first one:
 * new mail always lands there, and every page costs the server a decryption
 * per message. This merges a freshly fetched first page into the pages
 * already shown without opening a gap or repeating a row.
 */

type Row = { mailboxId: string; id: string };
type Page<R extends Row> = { items: R[]; nextCursor: string | null };
type Pages<P, C> = { pages: P[]; pageParams: C[] };

const rowKey = (row: Row) => `${row.mailboxId}:${row.id}`;

/**
 * `data` is what the list shows; `fresh` is the first page fetched now with
 * the same input. Returns the pages to show, or null when the two cannot be
 * reconciled safely and every loaded page should be fetched again.
 *
 * The last row of the old first page is the boundary the second page was
 * fetched after. When the fresh page still contains it, everything up to it is
 * current and the later pages stay valid. When it does not (new mail pushed it
 * down, or it was deleted), the old rows that follow the last row the two
 * pages share are kept after the fresh ones, so nothing between the first and
 * second page goes missing.
 */
export function mergeMailboxHead<R extends Row, P extends Page<R>, C>(
  data: Pages<P, C>,
  fresh: P,
): Pages<P, C> | null {
  const [head, ...later] = data.pages;
  if (!head) return null;
  // The fresh page holds everything there is: it replaces every page.
  if (fresh.nextCursor === null) return { pages: [fresh], pageParams: data.pageParams.slice(0, 1) };
  const boundary = head.items.at(-1);
  if (!boundary) return null;
  const freshKeys = fresh.items.map(rowKey);
  const at = freshKeys.indexOf(rowKey(boundary));
  let items: R[];
  if (at !== -1) {
    items = fresh.items.slice(0, at + 1);
  } else {
    const laterKeys = new Set(later.flatMap((page) => page.items.map(rowKey)));
    // The boundary vanished but the fresh page already reaches the next one.
    if (freshKeys.some((key) => laterKeys.has(key))) return null;
    const present = new Set(freshKeys);
    let shared = -1;
    for (let index = head.items.length - 1; index >= 0; index -= 1) {
      if (present.has(rowKey(head.items[index]!))) {
        shared = index;
        break;
      }
    }
    // Nothing in common: more mail arrived than one page holds.
    if (shared === -1) return null;
    items = [
      ...fresh.items,
      ...head.items.slice(shared + 1).filter((row) => !present.has(rowKey(row))),
    ];
  }
  const shown = new Set(items.map(rowKey));
  return {
    pages: [
      { ...fresh, items, nextCursor: head.nextCursor },
      // A draft edited on a later page moves to the top; show it once.
      ...later.map((page) =>
        page.items.some((row) => shown.has(rowKey(row)))
          ? { ...page, items: page.items.filter((row) => !shown.has(rowKey(row))) }
          : page,
      ),
    ],
    pageParams: data.pageParams,
  };
}
