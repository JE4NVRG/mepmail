/**
 * Pure helpers for the Correio message list: the date section a row falls
 * in, the initials shown in its avatar and a stable hue for that avatar.
 */

const DAY_MS = 86_400_000;

export type MailboxDateSection = "today" | "yesterday" | "week" | "month" | "older";

export const MAILBOX_DATE_SECTIONS: readonly MailboxDateSection[] = [
  "today",
  "yesterday",
  "week",
  "month",
  "older",
];

/**
 * Which heading a list row sits under, read in local time: today, yesterday,
 * the rest of the last seven days, the rest of this calendar month, and
 * everything older. A date in the future (a scheduled message) counts as today.
 */
export function mailboxDateSection(value: Date, now: Date): MailboxDateSection {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(value)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  if (value.getFullYear() === now.getFullYear() && value.getMonth() === now.getMonth())
    return "month";
  return "older";
}

function firstGlyph(word: string): string {
  for (const char of word) if (/[\p{L}\p{N}]/u.test(char)) return char;
  return "";
}

/**
 * One or two characters for a sender avatar: the first letters of the first
 * and last words of the display name, else the first letter of the address,
 * else a question mark. Quotes and punctuation around names are ignored.
 */
export function mailboxInitials(
  name: string | null | undefined,
  address: string | null | undefined,
): string {
  const words = (name ?? "")
    .split(/\s+/)
    .map(firstGlyph)
    .filter((glyph) => glyph !== "");
  if (words.length >= 2) return `${words[0]}${words[words.length - 1]}`.toUpperCase();
  if (words.length === 1) return words[0]!.toUpperCase();
  const local = (address ?? "").split("@")[0] ?? "";
  const glyph = firstGlyph(local);
  return glyph ? glyph.toUpperCase() : "?";
}

/**
 * A hue in 0..359 that is always the same for the same address (case and
 * surrounding spaces ignored), so one sender keeps one colour everywhere.
 */
export function mailboxAvatarHue(address: string | null | undefined): number {
  const key = (address ?? "").trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 360;
}
