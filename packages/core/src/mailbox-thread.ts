import { createHash } from "node:crypto";
import { mailboxMessageId } from "./mailbox-message-id.js";

/**
 * Conversation keys for Correio items, read from the MIME header block only:
 * `messageKey` names this message, `threadKey` names the conversation it
 * belongs to (the oldest message it refers to, else itself). Both are short
 * digests of Message-ID values, never the values, and they only group items
 * inside one already-authorized mailbox: a key never grants access.
 */
export interface MailboxThreadKeys {
  messageKey: string | null;
  threadKey: string | null;
}

const HEADER_LIMIT = 64 * 1024;
const ID_TOKEN = /<[^<>\s]{1,510}>/g;

export function mailboxIdKey(id: string): string {
  return createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 32);
}

/** Unfolded `name: value` header lines of the top-level header block. */
function headerLines(raw: Uint8Array): Map<string, string[]> {
  const head = Buffer.from(raw.subarray(0, HEADER_LIMIT)).toString("latin1");
  const end = head.search(/\r?\n\r?\n/);
  const block = (end === -1 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string[]>();
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(line.slice(colon + 1));
    headers.set(name, values);
  }
  return headers;
}

function ids(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.match(ID_TOKEN) ?? [])
    .map(mailboxMessageId)
    .filter((id): id is string => id !== null);
}

export function mailboxThreadKeys(raw: Uint8Array): MailboxThreadKeys {
  const headers = headerLines(raw);
  const own = ids(headers.get("message-id"))[0] ?? null;
  // References lists the conversation oldest first; In-Reply-To is the parent.
  const root = ids(headers.get("references"))[0] ?? ids(headers.get("in-reply-to"))[0] ?? own;
  return {
    messageKey: own ? mailboxIdKey(own) : null,
    threadKey: root ? mailboxIdKey(root) : null,
  };
}

/**
 * When the provider rewrites a sent message's Message-ID, replies refer to the
 * provider's ID. A message that started its own conversation moves to that ID.
 */
export function mailboxProviderThreadKeys(
  current: MailboxThreadKeys,
  providerMessageId: string,
): MailboxThreadKeys {
  const messageKey = mailboxIdKey(providerMessageId);
  const selfRooted = !current.threadKey || current.threadKey === current.messageKey;
  return { messageKey, threadKey: selfRooted ? messageKey : current.threadKey };
}
