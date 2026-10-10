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
  /** Smart inbox pile, when the list carries one. */
  category?: "person" | "notification" | "newsletter" | null;
  /** An approved sender always counts as a person. */
  senderDecision?: "allow" | "block" | "none" | null;
};

export type NewMailNotice = {
  title: string;
  body: string;
  /** The message, when the notice names one (to open it from the notice). */
  row?: { mailboxId: string; id: string };
};

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
 * `fallback` is shown so an arrival is never silent. `quiet` rows (with the
 * caixa inteligente on: notifications and newsletters) are marked as
 * announced without a notification; when all the new mail is quiet, nothing
 * is shown.
 */
export function newMailNotices(
  rows: readonly NewMailRow[],
  notified: Set<string>,
  labels: NewMailLabels,
  fallback: NewMailNotice,
  quiet?: (row: NewMailRow) => boolean,
): NewMailNotice[] {
  const arrived = rows.filter((row) => row.seenAt === null && !notified.has(rowKey(row)));
  for (const row of arrived) notified.add(rowKey(row));
  if (!arrived.length) return [fallback];
  const fresh = quiet ? arrived.filter((row) => !quiet(row)) : arrived;
  if (!fresh.length) return [];
  if (fresh.length <= EACH)
    return fresh.map((row) => ({
      title: sender(row) || labels.fallbackTitle,
      body: row.subject.trim() || labels.noSubject,
      row: { mailboxId: row.mailboxId, id: row.id },
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
