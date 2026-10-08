/** A recipient the composer can suggest: an address and, when known, a name. */
export interface MailboxContact {
  address: string;
  name: string;
}

// The same rule as the server's z.email() (zod 4's default email pattern), so
// a chip the composer accepts is one saveDraft accepts.
const EMAIL =
  /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export function isRecipientAddress(value: string) {
  return value.length <= 254 && EMAIL.test(value);
}

/** "Ana <ana@x.com>", "mailto:ana@x.com" or "ana@x.com" -> "ana@x.com". */
export function recipientAddress(value: string) {
  const trimmed = value.trim();
  const angle = /<([^<>]*)>\s*$/.exec(trimmed);
  return (angle ? (angle[1] ?? "") : trimmed)
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/^["']+|["']+$/g, "");
}

/**
 * Typed or pasted text as addresses: split at commas, semicolons and line
 * breaks; a part without "<...>" is also split at spaces, so a pasted
 * "a@x.com b@y.com" gives two. Invalid entries are kept for the user to fix.
 */
export function splitRecipients(text: string) {
  const out: string[] = [];
  for (const part of text.split(/[,;\n\r]+/)) {
    if (!part.trim()) continue;
    if (part.includes("<")) {
      const address = recipientAddress(part);
      if (address) out.push(address);
      continue;
    }
    for (const word of part.split(/\s+/)) {
      const address = recipientAddress(word);
      if (address) out.push(address);
    }
  }
  return out;
}

/** Adds addresses that are not there yet (case-insensitive), keeping order. */
export function mergeRecipients(current: string[], added: string[]) {
  const seen = new Set(current.map((address) => address.toLowerCase()));
  const next = [...current];
  for (const address of added) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(address);
  }
  return next;
}

// Addresses nobody reads: suggesting them only invites a bounce.
const UNREPLIABLE = /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)(?:[+._-]|@)/i;

/**
 * Suggestions from what this person already uses: recent recipients first,
 * then people they sent to, then people who wrote to them. One entry per
 * address, the first name seen wins; no-reply senders and `exclude` (the
 * mailbox itself) are left out. At most `limit` entries.
 */
export function mailboxContacts(
  groups: MailboxContact[][],
  exclude: string[] = [],
  limit = 300,
): MailboxContact[] {
  const skip = new Set(exclude.map((address) => address.toLowerCase()));
  const byAddress = new Map<string, MailboxContact>();
  for (const group of groups)
    for (const contact of group) {
      const address = recipientAddress(contact.address);
      const key = address.toLowerCase();
      if (!isRecipientAddress(address) || skip.has(key) || UNREPLIABLE.test(address)) continue;
      const known = byAddress.get(key);
      if (known) {
        if (!known.name && contact.name.trim()) known.name = contact.name.trim();
        continue;
      }
      if (byAddress.size >= limit) continue;
      byAddress.set(key, { address, name: contact.name.trim() });
    }
  return [...byAddress.values()];
}

/**
 * Contacts matching what is being typed, best first: an address or a name
 * word that starts with it, then any that contains it. Already chosen
 * addresses are left out.
 */
export function matchContacts(
  contacts: MailboxContact[],
  query: string,
  chosen: string[],
  limit = 6,
) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const taken = new Set(chosen.map((address) => address.toLowerCase()));
  const starts: MailboxContact[] = [];
  const contains: MailboxContact[] = [];
  for (const contact of contacts) {
    const address = contact.address.toLowerCase();
    if (taken.has(address)) continue;
    const name = contact.name.toLowerCase();
    if (
      address.startsWith(q) ||
      name.startsWith(q) ||
      name.split(/\s+/).some((w) => w.startsWith(q))
    )
      starts.push(contact);
    else if (address.includes(q) || name.includes(q)) contains.push(contact);
  }
  return [...starts, ...contains].slice(0, limit);
}

const RECENT_KEY = "mepmail.correio.recentRecipients";

/** Recipients this browser used last, newest first. Empty when storage is unavailable. */
export function readRecentRecipients(): MailboxContact[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is MailboxContact =>
          !!entry &&
          typeof entry.address === "string" &&
          typeof entry.name === "string" &&
          isRecipientAddress(entry.address),
      )
      .slice(0, 100);
  } catch {
    return [];
  }
}

/** Remembers the recipients of a saved message on this browser (at most 100). */
export function rememberRecipients(addresses: string[], names: Map<string, string>) {
  try {
    const fresh = addresses
      .filter(isRecipientAddress)
      .map((address) => ({ address, name: names.get(address.toLowerCase()) ?? "" }));
    const next = mailboxContacts([fresh, readRecentRecipients()], [], 100);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode or storage full: suggestions just stay as they were.
  }
}
