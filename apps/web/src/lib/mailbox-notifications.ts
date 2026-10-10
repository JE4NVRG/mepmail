/** New-mail notices: opt-in per browser, on by default in the desktop app. */
export const MAILBOX_NOTICE_PREFERENCE = "mepmail.correio.notices";

export interface NoticeRow {
  id: string;
  mailboxId: string;
  kind: string;
  seenAt: Date | null;
  blocked: boolean;
}

/**
 * Unread received messages that were not in any earlier listing. The first
 * listing only records what is there: opening the inbox never notifies.
 */
export function newUnreadArrivals<T extends NoticeRow>(
  known: Set<string> | null,
  rows: T[],
): { known: Set<string>; arrivals: T[] } {
  const keys = new Set(rows.map((row) => `${row.mailboxId}:${row.id}`));
  if (!known) return { known: keys, arrivals: [] };
  const arrivals = rows.filter(
    (row) =>
      row.kind === "inbox" &&
      !row.blocked &&
      row.seenAt === null &&
      !known.has(`${row.mailboxId}:${row.id}`),
  );
  for (const key of known) keys.add(key);
  return { known: keys, arrivals };
}

export function readNoticePreference(): boolean {
  try {
    return window.localStorage.getItem(MAILBOX_NOTICE_PREFERENCE) === "on";
  } catch {
    return false;
  }
}

export function writeNoticePreference(on: boolean) {
  try {
    window.localStorage.setItem(MAILBOX_NOTICE_PREFERENCE, on ? "on" : "off");
  } catch {
    // Private windows may refuse storage; the toggle then lasts this visit.
  }
}

/**
 * Whether new-mail notices are wanted on this device. A browser asks first
 * (opt-in, plus its own permission); the desktop app shows them unless the
 * person turned them off in Preferências.
 */
export function noticesWanted(
  desktop: boolean,
  stored: string | null = readStoredNotice(),
): boolean {
  return desktop ? stored !== "off" : stored === "on";
}

function readStoredNotice(): string | null {
  try {
    return window.localStorage.getItem(MAILBOX_NOTICE_PREFERENCE);
  } catch {
    return null;
  }
}
