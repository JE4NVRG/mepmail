import { createHmac } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { type SQL, sql } from "drizzle-orm";
import { decryptPayload } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";

/**
 * Correio search over sealed mail: a blind index (mailbox_search_index, one row per
 * message). Every word of a field becomes a 64-bit token, an HMAC under a key derived
 * per team from the master key, so the table holds no text and a token only matches a
 * searcher who already has both the word and the key. Header fields (subject, from,
 * to/cc, attachment names) also store their prefixes from three letters, for "starts
 * with"; the body stores whole words. The worker fills the index (indexMailboxSearch)
 * and the web reads it (findMailboxSearchMatches), checking phrases against the
 * decrypted candidates.
 */

/** Bump with a new derivation: the sweep reindexes every row at another version. */
export const MAILBOX_SEARCH_KEY_VERSION = 1;

const MIN_TERM = 2;
const MAX_TERM = 40;
const MIN_PREFIX = 3;
const MIN_BODY_TERM = 3;
/** Body text read per message, and the distinct body words kept from it. */
const BODY_TEXT_CHARS = 64 * 1024;
const BODY_TERMS = 400;
/** Matches the table's check. */
const MAX_TOKENS = 8000;
const MAX_QUERY_GROUPS = 12;
const MAX_QUERY_CHARS = 200;

/** One message's searchable text, as the worker reads it from the sealed MIME. */
export interface MailboxSearchDocument {
  subject: string;
  /** Sender address and display name. */
  from: string[];
  /** To, Cc and (on sent mail) Bcc addresses and names. */
  to: string[];
  /** Plain text of the body (HTML already converted). */
  body: string;
  attachments: string[];
}

type Field = "s" | "f" | "t" | "b" | "a" | "h";
export type MailboxSearchField = "any" | "s" | "f" | "t";

/** Common short words that only grow the index (body only; headers keep every word). */
const BODY_STOPWORDS = new Set([
  "que",
  "nao",
  "para",
  "com",
  "uma",
  "por",
  "mais",
  "como",
  "mas",
  "dos",
  "das",
  "nos",
  "nas",
  "seu",
  "sua",
  "seus",
  "suas",
  "ele",
  "ela",
  "voce",
  "isso",
  "este",
  "esta",
  "esse",
  "essa",
  "foi",
  "ser",
  "tem",
  "sao",
  "the",
  "and",
  "for",
  "you",
  "your",
  "with",
  "this",
  "that",
  "are",
  "was",
  "from",
  "have",
  "has",
  "not",
  "but",
  "all",
  "our",
  "can",
  "will",
  "what",
  "when",
  "here",
  "there",
  "they",
  "them",
  "their",
  "its",
  "his",
  "her",
]);

export function deriveMailboxSearchKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("mepmail/mailbox-search/v1").digest();
}

function teamKey(searchKey: Buffer, teamId: string): Buffer {
  return createHmac("sha256", searchKey).update(`team\u0000${teamId}`).digest();
}

function token(key: Buffer, field: Field, term: string): bigint {
  return createHmac("sha256", key).update(`${field}\u0000${term}`).digest().readBigInt64BE(0);
}

/** Every word as search compares it: accents off, lower case, letters and digits only. */
function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The searchable words of a text (2 to 40 characters). */
export function mailboxSearchTerms(text: string): string[] {
  return words(text).filter((term) => term.length >= MIN_TERM && term.length <= MAX_TERM);
}

/** A text as phrases are compared: its words joined by single spaces, padded. */
export function mailboxSearchPhraseText(text: string): string {
  return ` ${words(text).join(" ")} `;
}

/** The tokens of one message under its team's key, deduplicated and bounded. */
export function mailboxSearchDocumentTokens(
  searchKey: Buffer,
  teamId: string,
  doc: MailboxSearchDocument,
): bigint[] {
  const key = teamKey(searchKey, teamId);
  const out = new Set<bigint>();
  const header = (field: Field, values: readonly string[]) => {
    // The word and each of its prefixes from three letters: "jea" finds "jean".
    for (const value of values)
      for (const term of mailboxSearchTerms(value))
        for (let n = Math.min(MIN_PREFIX, term.length); n <= term.length; n++)
          out.add(token(key, field, term.slice(0, n)));
  };
  header("s", [doc.subject]);
  header("f", doc.from);
  header("t", doc.to);
  header("a", doc.attachments);
  if (doc.attachments.length) out.add(token(key, "h", "attachment"));
  const body = new Set<string>();
  for (const term of mailboxSearchTerms(doc.body.slice(0, BODY_TEXT_CHARS))) {
    if (body.size >= BODY_TERMS) break;
    if (term.length >= MIN_BODY_TERM && !BODY_STOPWORDS.has(term)) body.add(term);
  }
  for (const term of body) out.add(token(key, "b", term));
  return [...out].slice(0, MAX_TOKENS);
}

/** A search as typed, read into word groups, phrases and filters. */
export interface MailboxSearchQuery {
  /** Every group must match: a word in any field, or in the field an operator named. */
  groups: { field: MailboxSearchField; term: string }[];
  /** Quoted phrases, compared with mailboxSearchPhraseText on the candidates. */
  phrases: string[];
  hasAttachment: boolean;
  /** Received on or after this day (UTC), and before this day (UTC). */
  after: Date | null;
  before: Date | null;
}

const FIELD_OPERATORS: Record<string, MailboxSearchField> = {
  de: "f",
  from: "f",
  para: "t",
  to: "t",
  cc: "t",
  assunto: "s",
  subject: "s",
};
const ATTACHMENT_WORDS = new Set(["anexo", "anexos", "attachment", "attachments"]);

/** YYYY-MM-DD or DD/MM/YYYY, as the start of that day in UTC. */
function day(value: string): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : br ? [br[3], br[2], br[1]] : [];
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCDate() === Number(d) && date.getUTCMonth() === Number(m) - 1 ? date : null;
}

/**
 * Words, "phrases" and operators, in Portuguese and English: de:/from:, para:/to:/cc:,
 * assunto:/subject:, tem:anexo/has:attachment, depois:/after: and antes:/before: (a day).
 * Anything else, an unknown operator included, is plain words.
 */
export function parseMailboxSearchQuery(input: string): MailboxSearchQuery {
  const query = input.slice(0, MAX_QUERY_CHARS);
  const result: MailboxSearchQuery = {
    groups: [],
    phrases: [],
    hasAttachment: false,
    after: null,
    before: null,
  };
  const seen = new Set<string>();
  const add = (field: MailboxSearchField, text: string) => {
    for (const term of mailboxSearchTerms(text)) {
      const key = `${field}:${term}`;
      if (seen.has(key) || result.groups.length >= MAX_QUERY_GROUPS) continue;
      seen.add(key);
      result.groups.push({ field, term });
    }
  };
  const pattern = /([A-Za-z]+):"([^"]*)"?|([A-Za-z]+):(\S+)|"([^"]*)"?|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const operator = (match[1] ?? match[3])?.toLowerCase();
    const value = match[2] ?? match[4];
    if (operator !== undefined && value !== undefined) {
      const field = FIELD_OPERATORS[operator];
      if (field) {
        add(field, value);
        continue;
      }
      if ((operator === "tem" || operator === "has") && ATTACHMENT_WORDS.has(value.toLowerCase())) {
        result.hasAttachment = true;
        continue;
      }
      if (["depois", "after", "antes", "before"].includes(operator)) {
        const date = day(value);
        if (date) {
          if (operator === "depois" || operator === "after") result.after = date;
          else result.before = date;
          continue;
        }
      }
      add("any", `${operator} ${value}`);
      continue;
    }
    const phrase = match[5];
    if (phrase !== undefined) {
      add("any", phrase);
      if (words(phrase).length > 1) result.phrases.push(mailboxSearchPhraseText(phrase));
      continue;
    }
    if (match[6]) add("any", match[6]);
  }
  return result;
}

/** Nothing to search for: no word, attachment or date. */
export function mailboxSearchQueryEmpty(query: MailboxSearchQuery): boolean {
  return (
    !query.groups.length && !query.hasAttachment && query.after === null && query.before === null
  );
}

/** One token set per group (any of its tokens matches the group), under the team's key. */
export function mailboxSearchQueryTokens(
  searchKey: Buffer,
  teamId: string,
  query: MailboxSearchQuery,
): bigint[][] {
  const key = teamKey(searchKey, teamId);
  const groups = query.groups.map(({ field, term }) =>
    field === "any"
      ? (["s", "f", "t", "a", "b"] as const).map((f) => token(key, f, term))
      : [token(key, field, term)],
  );
  if (query.hasAttachment) groups.push([token(key, "h", "attachment")]);
  return groups;
}

/** A bigint[] literal from computed tokens only (never from input text). */
function tokenArray(tokens: readonly bigint[]): SQL {
  const parts = tokens.map((value) => value.toString());
  if (!parts.every((part) => /^-?\d{1,20}$/.test(part))) throw new Error("invalid search token");
  return sql.raw(`'{${parts.join(",")}}'::bigint[]`);
}

function quarantinedRow(row: { deliveryFolder: string; inboundAssessment: unknown }): boolean {
  const decision =
    row.inboundAssessment && typeof row.inboundAssessment === "object"
      ? (row.inboundAssessment as { decision?: unknown }).decision
      : undefined;
  return row.deliveryFolder === "quarantine" || decision === "quarantine";
}

/**
 * Indexes up to `limit` messages whose index row is missing or stale (new content,
 * another key version, or released from quarantine), newest first, so fresh mail is
 * searchable within a sweep and older mail is backfilled over the next ones. A message
 * changed while it was read is left for the next sweep; one that cannot be read is
 * recorded with no tokens instead of being retried every minute.
 */
export async function indexMailboxSearch(
  db: Db,
  keys: Keyring,
  searchKey: Buffer,
  read: (raw: Buffer) => Promise<MailboxSearchDocument>,
  options: { limit?: number; deadline?: number } = {},
): Promise<{ indexed: number; quarantined: number; unreadable: number; remaining: boolean }> {
  const limit = options.limit ?? 200;
  const items = schema.mailboxItems;
  const index = schema.mailboxSearchIndex;
  const candidates = (await db.execute(sql`
    select ${items.id} as id
    from ${items}
    left join ${index} on ${index.itemId} = ${items.id}
    where ${index.itemId} is null
      or ${index.contentIv} <> ${items.iv}
      or ${index.keyVersion} <> ${MAILBOX_SEARCH_KEY_VERSION}
      or (${index.quarantined} and ${items.deliveryFolder} <> 'quarantine'
        and coalesce(${items.inboundAssessment}->>'decision', '') <> 'quarantine')
    order by ${items.createdAt} desc, ${items.id} desc
    limit ${limit + 1}
  `)) as unknown as { rows?: { id: string }[] } | { id: string }[];
  const ids = (Array.isArray(candidates) ? candidates : (candidates.rows ?? [])).map(
    (row) => row.id,
  );
  const result = { indexed: 0, quarantined: 0, unreadable: 0, remaining: ids.length > limit };
  for (const id of ids.slice(0, limit)) {
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      result.remaining = true;
      break;
    }
    const [row] = await db.select().from(items).where(sql`${items.id} = ${id}`);
    if (!row) continue;
    let tokens: bigint[] = [];
    const quarantined = quarantinedRow(row);
    if (quarantined) result.quarantined += 1;
    else {
      try {
        const raw = await decryptPayload(row, keys, {
          teamId: row.teamId,
          rowId: `mailbox-private-v1:${row.mailboxId}:${row.id}`,
          kind: "email_body",
        });
        tokens = mailboxSearchDocumentTokens(searchKey, row.teamId, await read(raw));
        result.indexed += 1;
      } catch {
        result.unreadable += 1;
      }
    }
    // Written only if the message still has the content that was read.
    await db.execute(sql`
      insert into ${index} (item_id, team_id, mailbox_id, content_iv, quarantined, key_version, tokens, indexed_at)
      select ${items.id}, ${items.teamId}, ${items.mailboxId}, ${items.iv}, ${quarantined},
        ${MAILBOX_SEARCH_KEY_VERSION}, ${tokenArray(tokens)}, now()
      from ${items}
      where ${items.id} = ${row.id} and ${items.iv} = ${row.iv}
      on conflict (item_id) do update set
        content_iv = excluded.content_iv,
        quarantined = excluded.quarantined,
        key_version = excluded.key_version,
        tokens = excluded.tokens,
        indexed_at = excluded.indexed_at
    `);
  }
  return result;
}

export type MailboxSearchFolder =
  | "all"
  | "inbox"
  | "drafts"
  | "sent"
  | "archive"
  | "trash"
  | "spam"
  | "favorites"
  | "custom";

/** The position a row holds in a newest-first listing (microseconds since epoch, id). */
export interface MailboxSearchPosition {
  at: string;
  id: string;
}

/**
 * Messages of these mailboxes (all the team's, readable by the caller: the web
 * checks) matching every token group, newest first, after `before`. Quarantined mail
 * never matches. Rows carry the same metadata as a mailbox listing.
 */
export async function findMailboxSearchMatches(
  db: Db,
  input: {
    teamId: string;
    mailboxIds: string[];
    groups: bigint[][];
    folder: MailboxSearchFolder;
    customFolderId?: string | undefined;
    after?: Date | null;
    before?: Date | null;
    position?: MailboxSearchPosition | undefined;
    limit: number;
  },
) {
  const items = schema.mailboxItems;
  const index = schema.mailboxSearchIndex;
  if (!input.mailboxIds.length) return [];
  if (
    input.position &&
    (!/^\d{1,17}$/.test(input.position.at) || !/^[0-9a-f-]{36}$/.test(input.position.id))
  )
    throw new Error("invalid search position");
  const order = sql`(case when ${items.kind} = 'draft' then ${items.updatedAt} else coalesce(${items.resurfacedAt}, ${items.createdAt}) end)`;
  const boxes = sql`(${sql.join(
    input.mailboxIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
  const folder: SQL[] = (() => {
    const live = sql`${items.trashedAt} is null`;
    switch (input.folder) {
      case "all":
        return [live, sql`${items.deliveryFolder} = 'inbox'`];
      case "inbox":
        return [
          live,
          sql`${items.kind} = 'inbox'`,
          sql`${items.deliveryFolder} = 'inbox'`,
          sql`${items.archivedAt} is null`,
          sql`${items.folderId} is null`,
        ];
      case "drafts":
        return [live, sql`${items.kind} = 'draft'`];
      case "sent":
        return [live, sql`${items.kind} = 'sent'`];
      case "archive":
        return [live, sql`${items.archivedAt} is not null`];
      case "trash":
        return [sql`${items.trashedAt} is not null`];
      case "spam":
        return [live, sql`${items.deliveryFolder} = 'spam'`];
      case "favorites":
        return [live, sql`${items.starredAt} is not null`];
      case "custom":
        if (!input.customFolderId) throw new Error("custom search needs a folder");
        return [live, sql`${items.folderId} = ${input.customFolderId}::uuid`];
    }
  })();
  const conditions: SQL[] = [
    sql`${items.teamId} = ${input.teamId}::uuid`,
    sql`${items.mailboxId} in ${boxes}`,
    sql`${items.deliveryFolder} <> 'quarantine'`,
    sql`coalesce(${items.inboundAssessment}->>'decision', '') <> 'quarantine'`,
    ...folder,
    ...input.groups.map((group) => sql`${index.tokens} && ${tokenArray(group)}`),
    ...(input.groups.length ? [sql`${index.mailboxId} in ${boxes}`] : []),
    ...(input.after ? [sql`${items.createdAt} >= ${input.after.toISOString()}::timestamptz`] : []),
    ...(input.before ? [sql`${items.createdAt} < ${input.before.toISOString()}::timestamptz`] : []),
    ...(input.position
      ? [
          sql`(${order}, ${items.id}) < (timestamptz 'epoch' + ${input.position.at}::bigint * interval '1 microsecond', ${input.position.id}::uuid)`,
        ]
      : []),
  ];
  return db
    .select({
      id: items.id,
      mailboxId: items.mailboxId,
      kind: items.kind,
      deliveryFolder: items.deliveryFolder,
      inboundAssessment: items.inboundAssessment,
      trashedAt: items.trashedAt,
      starredAt: items.starredAt,
      seenAt: items.seenAt,
      archivedAt: items.archivedAt,
      folderId: items.folderId,
      snoozedUntil: items.snoozedUntil,
      pinnedAt: items.pinnedAt,
      sendAt: items.sendAt,
      sendFailure: items.sendFailure,
      remindAt: items.remindAt,
      remindedAt: items.remindedAt,
      threadKey: items.threadKey,
      revision: items.revision,
      createdAt: items.createdAt,
      updatedAt: items.updatedAt,
      orderAt: sql<string>`(extract(epoch from ${order}) * 1000000)::bigint::text`,
    })
    .from(items)
    .leftJoin(index, sql`${index.itemId} = ${items.id}`)
    .where(sql.join(conditions, sql` and `))
    .orderBy(sql`${order} desc`, sql`${items.id} desc`)
    .limit(input.limit);
}
