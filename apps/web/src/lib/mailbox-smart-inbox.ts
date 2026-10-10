import type { MailboxCategory } from "./mailbox-category";

/**
 * Caixa inteligente: the Inbox split into Pessoas, Notificações and
 * Newsletters (plus Tudo). The pile comes from the row's category (decided
 * from its headers on the server); anyone this person has written to counts
 * as a person whatever their messages look like, so a client writing from
 * billing@ still lands in Pessoas.
 */
export type SmartPile = "people" | "notifications" | "newsletters" | "all";
export type MessagePile = Exclude<SmartPile, "all">;

export const SMART_PILES: readonly SmartPile[] = ["people", "notifications", "newsletters", "all"];

type PileRow = { from: string; category: MailboxCategory | null };

const PILE: Record<MailboxCategory, MessagePile> = {
  person: "people",
  notification: "notifications",
  newsletter: "newsletters",
};

/** Lower-cased addresses this person sent to (from the Sent list). */
export function knownPeopleFrom(sent: readonly { to: readonly string[] }[]): Set<string> {
  const known = new Set<string>();
  for (const item of sent) for (const address of item.to) known.add(address.trim().toLowerCase());
  return known;
}

/** A row whose content is withheld (no category) stays with the people, never hidden away. */
export function rowPile(row: PileRow, knownPeople: ReadonlySet<string>): MessagePile {
  if (!row.category || knownPeople.has(row.from.trim().toLowerCase())) return "people";
  return PILE[row.category];
}

export type PileCounts = Record<SmartPile, { total: number; unread: number }>;

export function pileCounts<T extends PileRow>(
  rows: readonly T[],
  knownPeople: ReadonlySet<string>,
  isUnread: (row: T) => boolean,
): PileCounts {
  const counts: PileCounts = {
    people: { total: 0, unread: 0 },
    notifications: { total: 0, unread: 0 },
    newsletters: { total: 0, unread: 0 },
    all: { total: 0, unread: 0 },
  };
  for (const row of rows) {
    const unread = isUnread(row) ? 1 : 0;
    for (const pile of [rowPile(row, knownPeople), "all"] as const) {
      counts[pile].total += 1;
      counts[pile].unread += unread;
    }
  }
  return counts;
}

/**
 * The list pages through the whole Inbox, so a pile can be thin on the pages
 * loaded so far: keep loading while it shows fewer than `want` rows, up to a
 * few pages, then leave it to "Carregar mais".
 */
export function shouldLoadMore(state: {
  shown: number;
  pagesLoaded: number;
  hasNextPage: boolean;
  fetching: boolean;
  want?: number;
  maxPages?: number;
}): boolean {
  const { want = 12, maxPages = 5 } = state;
  return (
    state.hasNextPage &&
    !state.fetching &&
    state.pagesLoaded > 0 &&
    state.pagesLoaded < maxPages &&
    state.shown < want
  );
}
