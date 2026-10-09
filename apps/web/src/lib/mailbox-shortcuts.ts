/** Correio keyboard shortcuts, in the spirit of the usual webmail keys. */
export type MailboxShortcut =
  | "next"
  | "previous"
  | "close"
  | "archive"
  | "trash"
  | "star"
  | "unread"
  | "reply"
  | "replyAll"
  | "forward"
  | "compose"
  | "search"
  | "help";

const KEYS: Record<string, MailboxShortcut> = {
  j: "next",
  k: "previous",
  Escape: "close",
  e: "archive",
  "#": "trash",
  s: "star",
  u: "unread",
  r: "reply",
  a: "replyAll",
  f: "forward",
  c: "compose",
  "/": "search",
  "?": "help",
};

/** The order the help dialog lists them in, with the key a person presses. */
export const MAILBOX_SHORTCUTS: { key: string; action: MailboxShortcut }[] = [
  { key: "J / K", action: "next" },
  { key: "Esc", action: "close" },
  { key: "R", action: "reply" },
  { key: "A", action: "replyAll" },
  { key: "F", action: "forward" },
  { key: "C", action: "compose" },
  { key: "E", action: "archive" },
  { key: "#", action: "trash" },
  { key: "S", action: "star" },
  { key: "U", action: "unread" },
  { key: "/", action: "search" },
  { key: "?", action: "help" },
];

type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "defaultPrevented" | "isComposing" | "repeat"
>;

/**
 * The shortcut a key press asks for, or null when the person is typing, holds a
 * modifier, or is inside a dialog: there the key keeps its normal meaning.
 */
export function mailboxShortcut(event: KeyEventLike, target: EventTarget | null) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (
    element &&
    typeof element.closest === "function" &&
    element.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], dialog, [role='dialog']",
    )
  )
    return null;
  return Object.hasOwn(KEYS, event.key) ? (KEYS[event.key] ?? null) : null;
}
