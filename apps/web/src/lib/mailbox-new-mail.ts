/**
 * The desktop app's new-mail notifications. When the unread count grows, the
 * Correio reads the top of the inbox and announces what is new by sender and
 * subject instead of a bare "3 new messages". Up to three messages get a
 * notification each; more than that become one summary.
 */

export type NewMailRow = {
  id: string;
  mailboxId: string;
  seenAt: unknown;
  from: string;
  fromName: string;
  subject: string;
};

export type NewMailNotice = { title: string; body: string };

export type NewMailLabels = {
  /** The title when a message has no sender to show. */
  fallbackTitle: string;
  noSubject: string;
  /** "{count} new messages". */
  count: (count: number) => string;
  /** "and {count} more". */
  more: (count: number) => string;
};

const EACH = 3;

const rowKey = (row: Pick<NewMailRow, "id" | "mailboxId">) => `${row.mailboxId}:${row.id}`;
const sender = (row: NewMailRow) => row.fromName.trim() || row.from.trim();

/** Remembers the unread rows already on screen, so they are never announced. */
export function rememberUnread(rows: readonly NewMailRow[], notified: Set<string>): void {
  for (const row of rows) if (row.seenAt === null) notified.add(rowKey(row));
}

/**
 * The notifications for unread rows not announced before (and marks them as
 * announced). When none of the new mail is in `rows`, the count-only
 * `fallback` is shown so an arrival is never silent.
 */
export function newMailNotices(
  rows: readonly NewMailRow[],
  notified: Set<string>,
  labels: NewMailLabels,
  fallback: NewMailNotice,
): NewMailNotice[] {
  const fresh = rows.filter((row) => row.seenAt === null && !notified.has(rowKey(row)));
  for (const row of fresh) notified.add(rowKey(row));
  if (!fresh.length) return [fallback];
  if (fresh.length <= EACH)
    return fresh.map((row) => ({
      title: sender(row) || labels.fallbackTitle,
      body: row.subject.trim() || labels.noSubject,
    }));
  const listed = fresh
    .slice(0, EACH)
    .map(
      (row) => `${sender(row) || labels.fallbackTitle}: ${row.subject.trim() || labels.noSubject}`,
    );
  return [
    {
      title: labels.count(fresh.length),
      body: `${listed.join("\n")}\n${labels.more(fresh.length - EACH)}`,
    },
  ];
}
