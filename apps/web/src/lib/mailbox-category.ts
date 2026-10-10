/**
 * The smart inbox's three piles, decided once per message from its sender and
 * headers (the list summary keeps the answer):
 * - "notification": written by a system: Auto-Submitted, or a no-reply,
 *   notifications, billing... sender. Receipts, alerts, sign-in codes, GitHub.
 * - "newsletter": sent to a list: List-Unsubscribe, List-Id, Precedence
 *   bulk/list, or a newsletter/marketing sender.
 * - "person": everything else.
 * A system sender wins over list headers, because services put
 * List-Unsubscribe on their notifications too.
 */
export type MailboxCategory = "person" | "notification" | "newsletter";

export const MAILBOX_CATEGORIES: readonly MailboxCategory[] = [
  "person",
  "notification",
  "newsletter",
];

const SYSTEM_SENDER =
  /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|automated|system|security|billing|receipts?|invoices?|orders?|accounts?|verify|verification)(?:[+._-].*)?$/i;
const LIST_SENDER =
  /^(?:newsletters?|news|digest|marketing|promo(?:s|tions?)?|offers?|deals?|campaigns?|mailing)(?:[+._-].*)?$/i;

type HeaderLine = { key: string; line: string };

const headerValue = (line: string) =>
  line
    .slice(line.indexOf(":") + 1)
    .trim()
    .toLowerCase();

export function mailboxCategory(input: {
  from: string;
  headerLines: readonly HeaderLine[];
}): MailboxCategory {
  const headers = new Map<string, string>();
  for (const { key, line } of input.headerLines) {
    const name = key.toLowerCase();
    if (!headers.has(name)) headers.set(name, headerValue(line));
  }
  const local = input.from.split("@")[0] ?? "";
  const submitted = headers.get("auto-submitted");
  if ((submitted && submitted !== "no") || SYSTEM_SENDER.test(local) || /no-?reply/i.test(local))
    return "notification";
  const precedence = headers.get("precedence");
  if (
    headers.has("list-unsubscribe") ||
    headers.has("list-id") ||
    precedence === "bulk" ||
    precedence === "list" ||
    LIST_SENDER.test(local)
  )
    return "newsletter";
  return "person";
}

export const isMailboxCategory = (value: unknown): value is MailboxCategory =>
  value === "person" || value === "notification" || value === "newsletter";
