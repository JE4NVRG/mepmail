import { createHash } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, inArray, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { Keyring } from "./crypto/keyring.js";
import {
  listMailboxFolders,
  setMailboxItemArchive,
  setMailboxItemFolder,
  setMailboxItemStar,
} from "./mailbox-organization.js";
import {
  importMailboxMime,
  type MailboxContentActor,
  MailboxContentError,
  saveMailboxDraft,
  setMailboxDeliveryFolder,
  setMailboxItemsSeenMany,
  setMailboxItemTrash,
  withMailboxItems,
  withMailboxOwnerAccess,
} from "./mailbox-private-store.js";
import { mailboxThreadKeys } from "./mailbox-thread.js";

/**
 * A Correio mailbox seen over IMAP (specs/correio-imap-smtp.md). The folders are the
 * Correio's own views, with the same rules the web lists them by: Caixa de entrada,
 * Enviados, Rascunhos, Spam, Arquivo, Lixeira and the owner's folders. Quarantined mail
 * never shows and snoozed mail shows again when it is due. Each folder numbers its
 * messages with UIDs that only grow: a message gets one when IMAP first sees it in the
 * folder and loses it when it leaves, so returning later means a new UID. Every change
 * goes through the same core functions as the web, under the owner's access.
 */

export type MailboxImapFolderKey =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "spam"
  | "trash"
  | `folder:${string}`;

export interface MailboxImapFolder {
  key: MailboxImapFolderKey;
  /** IMAP path: "INBOX", "Sent", … or the folder's own name. */
  path: string;
  specialUse: "\\Sent" | "\\Drafts" | "\\Archive" | "\\Junk" | "\\Trash" | null;
}

export interface MailboxImapMessage {
  uid: number;
  itemId: string;
  revision: number;
  kind: "inbox" | "draft" | "sent";
  flags: string[];
  /** When the Correio got it (INTERNALDATE). */
  idate: Date;
  size: number;
}

export interface MailboxImapFolderState {
  uidValidity: number;
  uidNext: number;
  /** Ascending by UID. */
  messages: MailboxImapMessage[];
}

const SPECIAL: MailboxImapFolder[] = [
  { key: "inbox", path: "INBOX", specialUse: null },
  { key: "sent", path: "Sent", specialUse: "\\Sent" },
  { key: "drafts", path: "Drafts", specialUse: "\\Drafts" },
  { key: "archive", path: "Archive", specialUse: "\\Archive" },
  { key: "spam", path: "Junk", specialUse: "\\Junk" },
  { key: "trash", path: "Trash", specialUse: "\\Trash" },
];
const FOLDER_KEY = /^folder:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Names clients and other providers use for the same special folders. */
const ALIASES = new Map<string, MailboxImapFolderKey>([
  ["inbox", "inbox"],
  ["sent", "sent"],
  ["sent items", "sent"],
  ["sent messages", "sent"],
  ["enviados", "sent"],
  ["drafts", "drafts"],
  ["rascunhos", "drafts"],
  ["archive", "archive"],
  ["arquivo", "archive"],
  ["junk", "spam"],
  ["spam", "spam"],
  ["junk e-mail", "spam"],
  ["trash", "trash"],
  ["deleted items", "trash"],
  ["deleted messages", "trash"],
  ["lixeira", "trash"],
]);

export function isMailboxImapFolderKey(value: string): value is MailboxImapFolderKey {
  return SPECIAL.some((folder) => folder.key === value) || FOLDER_KEY.test(value);
}

/** A folder name as an IMAP path: no hierarchy ("/") and no control characters. */
function folderPath(name: string) {
  const clean = [...name.replace(/[/\\]/g, "-")]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .trim();
  return clean || "Pasta";
}

/** The special folders, then the owner's folders in their own order. */
export async function listMailboxImapFolders(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
): Promise<MailboxImapFolder[]> {
  const custom = await listMailboxFolders(db, actor, { mailboxId });
  const taken = new Set(SPECIAL.map((folder) => folder.path.toLowerCase()));
  const out = [...SPECIAL];
  for (const folder of custom) {
    let path = folderPath(folder.name);
    // A folder named like a special one, or twice the same name: keep both reachable.
    for (let n = 2; taken.has(path.toLowerCase()) || ALIASES.has(path.toLowerCase()); n++)
      path = `${folderPath(folder.name)} (${n})`;
    taken.add(path.toLowerCase());
    out.push({ key: `folder:${folder.id}`, path, specialUse: null });
  }
  return out;
}

/** The folder a client names, by our path or a common name for a special folder. */
export function resolveMailboxImapFolder(
  folders: MailboxImapFolder[],
  path: string,
): MailboxImapFolder | null {
  const wanted = path.trim().toLowerCase();
  const exact = folders.find((folder) => folder.path.toLowerCase() === wanted);
  if (exact) return exact;
  const key = ALIASES.get(wanted.replace(/^\[gmail\]\//, ""));
  return key ? (folders.find((folder) => folder.key === key) ?? null) : null;
}

/** The web's rule for each view (apps/web/src/server/mailbox-content.ts), for one mailbox. */
function membership(mailboxId: string, teamId: string, key: MailboxImapFolderKey): SQL {
  const items = schema.mailboxItems;
  const notSnoozed = sql`not (${items.snoozedUntil} is not null and ${items.snoozedUntil} > now())`;
  const base = [
    eq(items.mailboxId, mailboxId),
    eq(items.teamId, teamId),
    ne(items.deliveryFolder, "quarantine"),
    sql`coalesce(${items.inboundAssessment}->>'decision', '') <> 'quarantine'`,
  ];
  const ordinary = [
    isNull(items.trashedAt),
    isNull(items.folderId),
    isNull(items.archivedAt),
    notSnoozed,
  ];
  const conditions: SQL[] =
    key === "inbox"
      ? [...ordinary, eq(items.kind, "inbox"), eq(items.deliveryFolder, "inbox")]
      : key === "sent"
        ? [...ordinary, eq(items.kind, "sent")]
        : key === "drafts"
          ? [...ordinary, eq(items.kind, "draft")]
          : key === "spam"
            ? [
                isNull(items.trashedAt),
                notSnoozed,
                eq(items.kind, "inbox"),
                eq(items.deliveryFolder, "spam"),
              ]
            : key === "archive"
              ? [
                  isNull(items.trashedAt),
                  notSnoozed,
                  isNotNull(items.archivedAt),
                  eq(items.deliveryFolder, "inbox"),
                ]
              : key === "trash"
                ? [isNotNull(items.trashedAt)]
                : [
                    isNull(items.trashedAt),
                    notSnoozed,
                    eq(items.folderId, key.slice("folder:".length)),
                    eq(items.deliveryFolder, "inbox"),
                  ];
  return and(...base, ...conditions)!;
}

function flagsOf(item: { kind: string; seenAt: Date | null; starredAt: Date | null }) {
  const flags: string[] = [];
  // Sent mail and drafts are the owner's own: never "unread" in a mail app.
  if (item.seenAt || item.kind !== "inbox") flags.push("\\Seen");
  if (item.starredAt) flags.push("\\Flagged");
  if (item.kind === "draft") flags.push("\\Draft");
  return flags;
}

/**
 * The folder now, numbered: new messages get the next UIDs (oldest first), messages
 * that left lose theirs. Run on SELECT and on every refresh of a selected folder.
 */
export async function syncMailboxImapFolder(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  key: MailboxImapFolderKey,
): Promise<MailboxImapFolderState> {
  if (!isMailboxImapFolderKey(key)) throw new MailboxContentError("invalid");
  return withMailboxOwnerAccess(db, actor, mailboxId, async (tx) => {
    if (key.startsWith("folder:")) {
      const [folder] = await tx
        .select({ id: schema.mailboxFolders.id })
        .from(schema.mailboxFolders)
        .where(
          and(
            eq(schema.mailboxFolders.id, key.slice("folder:".length)),
            eq(schema.mailboxFolders.mailboxId, mailboxId),
            eq(schema.mailboxFolders.teamId, actor.teamId),
            isNull(schema.mailboxFolders.archivedAt),
          ),
        );
      if (!folder) throw new MailboxContentError("not_found");
    }
    await tx
      .insert(schema.mailboxImapFolders)
      .values({
        mailboxId,
        teamId: actor.teamId,
        folderKey: key,
        // Seconds since 2020: a new folder row always gets a larger UIDVALIDITY.
        uidValidity: Math.max(1, Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 1000)),
      })
      .onConflictDoNothing();
    // One numbering at a time per folder, whatever the number of sessions.
    const [folder] = await tx
      .select()
      .from(schema.mailboxImapFolders)
      .where(
        and(
          eq(schema.mailboxImapFolders.mailboxId, mailboxId),
          eq(schema.mailboxImapFolders.folderKey, key),
        ),
      )
      .for("update");
    const items = schema.mailboxItems;
    const members = await tx
      .select({
        id: items.id,
        revision: items.revision,
        kind: items.kind,
        seenAt: items.seenAt,
        starredAt: items.starredAt,
        rawBytes: items.rawBytes,
        createdAt: items.createdAt,
      })
      .from(items)
      .where(membership(mailboxId, actor.teamId, key))
      .orderBy(asc(items.createdAt), asc(items.id));
    const numbered = await tx
      .select({ uid: schema.mailboxImapUids.uid, itemId: schema.mailboxImapUids.itemId })
      .from(schema.mailboxImapUids)
      .where(
        and(
          eq(schema.mailboxImapUids.mailboxId, mailboxId),
          eq(schema.mailboxImapUids.folderKey, key),
        ),
      );
    const present = new Set(members.map((m) => m.id));
    const gone = numbered.filter((row) => !present.has(row.itemId));
    if (gone.length)
      await tx.delete(schema.mailboxImapUids).where(
        and(
          eq(schema.mailboxImapUids.mailboxId, mailboxId),
          eq(schema.mailboxImapUids.folderKey, key),
          inArray(
            schema.mailboxImapUids.uid,
            gone.map((row) => row.uid),
          ),
        ),
      );
    const uidOf = new Map(
      numbered.filter((row) => present.has(row.itemId)).map((row) => [row.itemId, row.uid]),
    );
    let uidNext = folder!.uidNext;
    const fresh = members.filter((m) => !uidOf.has(m.id));
    if (fresh.length) {
      if (uidNext + fresh.length > 2147483647) throw new MailboxContentError("conflict");
      const rows = fresh.map((m) => ({
        mailboxId,
        teamId: actor.teamId,
        folderKey: key,
        uid: uidNext++,
        itemId: m.id,
      }));
      for (let i = 0; i < rows.length; i += 1000)
        await tx.insert(schema.mailboxImapUids).values(rows.slice(i, i + 1000));
      for (const row of rows) uidOf.set(row.itemId, row.uid);
      await tx
        .update(schema.mailboxImapFolders)
        .set({ uidNext })
        .where(
          and(
            eq(schema.mailboxImapFolders.mailboxId, mailboxId),
            eq(schema.mailboxImapFolders.folderKey, key),
          ),
        );
    }
    const messages = members
      .map((m) => ({
        uid: uidOf.get(m.id)!,
        itemId: m.id,
        revision: m.revision,
        kind: m.kind,
        flags: flagsOf(m),
        idate: m.createdAt,
        size: m.rawBytes,
      }))
      .sort((a, b) => a.uid - b.uid);
    return { uidValidity: folder!.uidValidity, uidNext, messages };
  });
}

/** The stored MIME of some of the folder's messages (at most 100 per call). */
export async function readMailboxImapMessages(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  mailboxId: string,
  itemIds: string[],
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < itemIds.length; i += 100)
    await withMailboxItems(
      db,
      keyring,
      actor,
      { mailboxId, ids: itemIds.slice(i, i + 100) },
      async (items) => {
        for (const item of items) out.set(item.id, item.raw);
      },
    );
  return out;
}

/** \Seen and \Flagged, the two flags the Correio keeps (others are not stored). */
export async function setMailboxImapFlags(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  messages: Pick<MailboxImapMessage, "itemId" | "revision" | "kind">[],
  change: { seen?: boolean; flagged?: boolean },
) {
  if (change.seen !== undefined) {
    const received = messages.filter((m) => m.kind === "inbox");
    for (let i = 0; i < received.length; i += 200)
      await setMailboxItemsSeenMany(db, actor, {
        items: received.slice(i, i + 200).map((m) => ({ mailboxId, id: m.itemId })),
        seen: change.seen,
      });
  }
  if (change.flagged !== undefined)
    for (const m of messages)
      await retryOnRevision(db, actor, mailboxId, m, (revision) =>
        setMailboxItemStar(db, actor, {
          mailboxId,
          id: m.itemId,
          expectedRevision: revision,
          starred: change.flagged!,
        }),
      );
}

/** The item's current revision, for a change that raced another client's. */
async function currentRevision(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  itemId: string,
) {
  const [row] = await db
    .select({ revision: schema.mailboxItems.revision })
    .from(schema.mailboxItems)
    .where(
      and(
        eq(schema.mailboxItems.id, itemId),
        eq(schema.mailboxItems.mailboxId, mailboxId),
        eq(schema.mailboxItems.teamId, actor.teamId),
      ),
    );
  return row?.revision ?? null;
}

async function retryOnRevision<T>(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  message: Pick<MailboxImapMessage, "itemId" | "revision">,
  run: (revision: number) => Promise<T>,
): Promise<T> {
  try {
    return await run(message.revision);
  } catch (error) {
    if (!(error instanceof MailboxContentError) || error.code !== "conflict") throw error;
    const revision = await currentRevision(db, actor, mailboxId, message.itemId);
    if (revision === null) throw error;
    return run(revision);
  }
}

/**
 * MOVE (and EXPUNGE into Lixeira): the Correio's own actions, as many as it takes for the
 * message to be in the destination view, read from its state now. Lixeira: trash. Any
 * other destination first takes it out of Lixeira. Caixa de entrada: not archived, in no
 * folder, not spam. Arquivo: archived. Spam: spam, in no folder, not archived (received
 * mail only). A folder: filed there, not spam. Enviados and Rascunhos take nothing in.
 */
export async function moveMailboxImapMessages(
  db: Db,
  actor: MailboxContentActor,
  mailboxId: string,
  from: MailboxImapFolderKey,
  to: MailboxImapFolderKey,
  messages: Pick<MailboxImapMessage, "itemId" | "revision" | "kind">[],
): Promise<"moved" | "cannot"> {
  if (to === "sent" || to === "drafts" || from === to) return "cannot";
  if (to === "spam" && messages.some((m) => m.kind !== "inbox")) return "cannot";
  const items = schema.mailboxItems;
  const folderId = to.startsWith("folder:") ? to.slice("folder:".length) : null;
  for (const message of messages) {
    const state = async () => {
      const [row] = await db
        .select({
          revision: items.revision,
          trashedAt: items.trashedAt,
          archivedAt: items.archivedAt,
          folderId: items.folderId,
          deliveryFolder: items.deliveryFolder,
        })
        .from(items)
        .where(
          and(
            eq(items.id, message.itemId),
            eq(items.mailboxId, mailboxId),
            eq(items.teamId, actor.teamId),
          ),
        );
      if (!row) throw new MailboxContentError("not_found");
      return row;
    };
    const step = async (change: (revision: number) => Promise<unknown>) => {
      const { revision } = await state();
      await retryOnRevision(db, actor, mailboxId, { ...message, revision }, change);
    };
    const id = message.itemId;
    if (to === "trash") {
      await step((revision) =>
        setMailboxItemTrash(db, actor, {
          mailboxId,
          id,
          expectedRevision: revision,
          trashed: true,
        }),
      );
      continue;
    }
    let now = await state();
    if (now.trashedAt)
      await step((revision) =>
        setMailboxItemTrash(db, actor, {
          mailboxId,
          id,
          expectedRevision: revision,
          trashed: false,
        }),
      );
    now = await state();
    const wantArchived = to === "archive";
    if (!!now.archivedAt !== wantArchived)
      await step((revision) =>
        setMailboxItemArchive(db, actor, {
          mailboxId,
          id,
          expectedRevision: revision,
          archived: wantArchived,
        }),
      );
    now = await state();
    if (!wantArchived && now.folderId !== folderId)
      await step((revision) =>
        setMailboxItemFolder(db, actor, { mailboxId, id, expectedRevision: revision, folderId }),
      );
    now = await state();
    const wantDelivery = to === "spam" ? "spam" : "inbox";
    if (message.kind === "inbox" && now.deliveryFolder !== wantDelivery)
      await step((revision) =>
        setMailboxDeliveryFolder(db, actor, {
          mailboxId,
          id,
          expectedRevision: revision,
          folder: wantDelivery,
        }),
      );
  }
  return "moved";
}

/**
 * APPEND: Rascunhos saves a draft; Enviados keeps a copy the client made after sending
 * (`recentlySent` says whether this process just sent that Message-ID, and then nothing
 * is added); Caixa de entrada, Arquivo and the owner's folders import the message.
 * Returns the item that holds it, or null when it was a known sent copy.
 */
export async function appendMailboxImapMessage(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  mailboxId: string,
  to: MailboxImapFolderKey,
  raw: Buffer,
  options: { seen: boolean; date: Date | null; recentlySent?: (messageKey: string) => boolean },
): Promise<{ itemId: string } | null> {
  const { messageKey } = mailboxThreadKeys(raw);
  if (to === "drafts") {
    const draft = await saveMailboxDraft(db, keyring, actor, {
      mailboxId,
      expectedRevision: 0,
      raw,
    });
    return { itemId: draft.id };
  }
  if (to === "trash" || to === "spam") throw new MailboxContentError("invalid");
  if (to === "sent") {
    if (messageKey && options.recentlySent?.(messageKey)) return null;
    if (messageKey) {
      // Sent from here: its send record or its copy in Enviados already holds it.
      const known = await withMailboxOwnerAccess(db, actor, mailboxId, async (tx) => {
        const [item] = await tx
          .select({ id: schema.mailboxItems.id })
          .from(schema.mailboxItems)
          .where(
            and(
              eq(schema.mailboxItems.mailboxId, mailboxId),
              eq(schema.mailboxItems.teamId, actor.teamId),
              eq(schema.mailboxItems.kind, "sent"),
              eq(schema.mailboxItems.messageKey, messageKey),
            ),
          )
          .limit(1);
        if (item) return item;
        const [queued] = await tx
          .select({ id: schema.mailboxOutbox.id })
          .from(schema.mailboxOutbox)
          .where(
            and(
              eq(schema.mailboxOutbox.mailboxId, mailboxId),
              eq(schema.mailboxOutbox.teamId, actor.teamId),
              eq(schema.mailboxOutbox.messageKey, messageKey),
            ),
          )
          .limit(1);
        return queued ? { id: null } : null;
      });
      if (known) return known.id ? { itemId: known.id } : null;
    }
  }
  const imported = await importMailboxMime(db, keyring, actor, {
    mailboxId,
    // The same bytes appended twice are one message.
    sourceId: `imap-append:${createHash("sha256").update(raw).digest("hex")}`,
    raw,
    history: {
      kind: to === "sent" ? "sent" : "inbox",
      receivedAt: options.date ?? new Date(),
      seen: options.seen || to === "sent",
      archived: to === "archive",
    },
  });
  if (to.startsWith("folder:"))
    await setMailboxItemFolder(db, actor, {
      mailboxId,
      id: imported.id,
      expectedRevision: imported.revision,
      folderId: to.slice("folder:".length),
    });
  return { itemId: imported.id };
}
