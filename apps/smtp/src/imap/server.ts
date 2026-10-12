import type { Keyring } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import {
  authenticateMailboxAppPassword,
  type MailboxClientIdentity,
  mailboxAppPasswordActive,
} from "../../../../packages/core/src/mailbox-app-passwords.js";
import {
  appendMailboxImapMessage,
  listMailboxImapFolders,
  type MailboxImapFolder,
  type MailboxImapFolderKey,
  type MailboxImapMessage,
  moveMailboxImapMessages,
  readMailboxImapMessages,
  resolveMailboxImapFolder,
  setMailboxImapFlags,
  syncMailboxImapFolder,
} from "../../../../packages/core/src/mailbox-imap.js";
import {
  archiveMailboxFolder,
  createMailboxFolder,
  listMailboxFolders,
  updateMailboxFolder,
} from "../../../../packages/core/src/mailbox-organization.js";
import {
  compileStream,
  IMAPServer,
  type ImapMessage,
  type ImapServer,
  type ImapSession,
  parseMimeTree,
} from "./imap-core.js";

/**
 * IMAP for the Correio (specs/correio-imap-smtp.md): Outlook, Apple Mail, Thunderbird or
 * the Gmail app read and organise a mailbox with its address and an app password. The
 * protocol is the vendored imap-core; every handler here goes through the Correio's core
 * (mailbox-imap.ts and friends) as the mailbox's owner, with the same rules as the web.
 *
 * A selected folder is a snapshot per connection (UID → message). Refreshing it means
 * syncing the folder again and telling the client what changed: new UIDs (EXISTS), UIDs
 * gone (EXPUNGE) and flags (FETCH). Refreshes come from the arrival announcements the web
 * uses ("mailbox_arrivals"), from a timer, faster while the client IDLEs, and run one at
 * a time per connection with its commands.
 */

/** Largest message an APPEND may bring (the Correio keeps received mail up to 25 MiB). */
export const MAX_APPEND_BYTES = 25 * 1024 * 1024;
const FETCH_BATCH = 50;
const METADATA_ITEMS = new Set(["uid", "flags", "modseq", "internaldate", "rfc822.size"]);
const IDLE_REFRESH_MS = 20_000;
const REFRESH_MS = 60_000;
/** The password is re-checked at most this often during a session. */
const PASSWORD_CHECK_MS = 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_PER_USER = 20;

export interface MailboxImapDeps {
  db: Db;
  keyring: Keyring;
  /** deriveMailboxAppPasswordKey(master key). */
  passwordKey: Buffer;
  tls?: { key: Buffer; cert: Buffer } | undefined;
  /** 993: TLS from the first byte. Tests run plain on loopback. */
  secure?: boolean;
  /** Mail this process just sent over SMTP (see recent-sends.ts). */
  recentlySent?: (mailboxId: string, messageKey: string) => boolean;
  /** Behind the host's nginx stream proxy: connections start with a PROXY header. */
  proxyProtocol?: boolean;
  /** Registers for arrival announcements; returns the unsubscribe. */
  onArrival?: (listener: (mailboxId: string) => void) => () => void;
  now?: () => number;
}

interface Selected {
  ref: { key: string; toString(): string };
  folder: MailboxImapFolder;
  uidValidity: number;
  messages: Map<number, MailboxImapMessage>;
  /** \Deleted is kept per connection until EXPUNGE (the Correio has no such flag). */
  deleted: Set<number>;
  modseq: number;
}

interface Connection {
  identity: MailboxClientIdentity;
  actor: { teamId: string; userId: string };
  selected: Selected | null;
  chain: Promise<unknown>;
  listener: ((message?: { command: string; reason?: string }) => void) | null;
  timer: ReturnType<typeof setInterval> | null;
  idling: boolean;
  checkedAt: number;
}

const flagsKey = (flags: string[]) => [...flags].sort().join(" ");

export function createMailboxImapServer(deps: MailboxImapDeps): ImapServer {
  const now = deps.now ?? Date.now;
  const connections = new Map<string, Connection>();
  const failures = new Map<string, number[]>();
  const recent = (key: string) => {
    const since = now() - FAILURE_WINDOW_MS;
    const kept = (failures.get(key) ?? []).filter((at) => at > since);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept.length;
  };
  const fail = (key: string) => failures.set(key, [...(failures.get(key) ?? []), now()]);

  const server = new IMAPServer({
    // TLS 1.2 or later only (the vendored defaults carry no keypair: no handshake without ours).
    ...(deps.tls ? { key: deps.tls.key, cert: deps.tls.cert, minVersion: "TLSv1.2" } : {}),
    secure: deps.secure ?? false,
    // imap-core installs its default SNI handler only for servers that are not secure,
    // yet its TLS-from-the-first-byte path (993) calls one on every connection: answer
    // with the default context (the keypair above, valid for imap. and smtp.mepmail.dev).
    SNICallback: (_servername: string, done: (err: Error | null, context?: unknown) => void) =>
      done(null),
    // Plain loopback (tests) needs neither STARTTLS nor LOGINDISABLED.
    ...(deps.tls ? {} : { disableSTARTTLS: true, ignoreSTARTTLS: true }),
    id: { name: "MepMail", vendor: "MepMail", "support-url": "https://mepmail.dev/support" },
    maxMessage: MAX_APPEND_BYTES,
    ...(deps.proxyProtocol ? { useProxy: ["*"] } : {}),
    // Modification sequences and quotas are not kept: clients sync by UID and flags.
    disabledCapabilities: ["CONDSTORE", "QUOTA"],
    logger: false,
  });

  const unsubscribe = deps.onArrival?.((mailboxId) => {
    for (const connection of connections.values())
      if (connection.identity.mailboxId === mailboxId && connection.selected)
        connection.listener?.();
  });

  /** One thing at a time per connection: its commands and its refreshes. */
  const run = <T>(session: ImapSession, task: (c: Connection) => Promise<T>): Promise<T> => {
    const connection = connections.get(session.id);
    if (!connection) return Promise.reject(new Error("not signed in"));
    const next = connection.chain.then(async () => {
      // A revoked password (or a mailbox that stopped) ends the session.
      if (now() - connection.checkedAt > PASSWORD_CHECK_MS) {
        connection.checkedAt = now();
        if (!(await mailboxAppPasswordActive(deps.db, connection.identity))) {
          connection.listener?.({ command: "LOGOUT", reason: "This app password no longer works" });
          throw Object.assign(new Error("password revoked"), { response: "NO" });
        }
      }
      return task(connection);
    });
    connection.chain = next.catch(() => undefined);
    return next;
  };
  const respond = <T>(
    promise: Promise<T>,
    callback: (err: Error | null, ...result: unknown[]) => void,
    map: (value: T) => unknown[],
  ) => {
    promise.then(
      (value) => callback(null, ...map(value)),
      (err: unknown) => {
        if (!(err instanceof Error && "response" in err)) console.error("imap handler error", err);
        callback(err instanceof Error ? err : new Error(String(err)));
      },
    );
  };
  const folders = (c: Connection) => listMailboxImapFolders(deps.db, c.actor, c.identity.mailboxId);
  const sync = (c: Connection, key: MailboxImapFolderKey) =>
    syncMailboxImapFolder(deps.db, c.actor, c.identity.mailboxId, key);
  const selectedOf = (c: Connection, mailbox: unknown) =>
    c.selected && mailbox === c.selected.ref ? c.selected : null;
  const imapMessage = (
    message: MailboxImapMessage,
    selected: Selected,
    raw?: Buffer,
  ): ImapMessage => ({
    uid: message.uid,
    flags: [...message.flags, ...(selected.deleted.has(message.uid) ? ["\\Deleted"] : [])],
    modseq: selected.modseq,
    idate: message.idate,
    hdate: message.idate,
    size: message.size,
    ...(raw ? { raw, mimeTree: parseMimeTree(raw) } : {}),
  });

  /** What changed in the selected folder since the client last heard, as journal entries. */
  const updates = async (c: Connection) => {
    const selected = c.selected;
    if (!selected) return [];
    const state = await sync(c, selected.folder.key);
    const entries: { command: string; uid: number; flags?: string[]; modseq: number }[] = [];
    const fresh = new Map(state.messages.map((m) => [m.uid, m]));
    for (const uid of [...selected.messages.keys()].sort((a, b) => a - b))
      if (!fresh.has(uid)) {
        selected.messages.delete(uid);
        selected.deleted.delete(uid);
        entries.push({ command: "EXPUNGE", uid, modseq: ++selected.modseq });
      }
    for (const message of state.messages) {
      const known = selected.messages.get(message.uid);
      if (!known) entries.push({ command: "EXISTS", uid: message.uid, modseq: ++selected.modseq });
      else if (flagsKey(known.flags) !== flagsKey(message.flags))
        entries.push({
          command: "FETCH",
          uid: message.uid,
          flags: imapMessage(message, selected).flags,
          modseq: ++selected.modseq,
        });
      selected.messages.set(message.uid, message);
    }
    return entries;
  };

  const schedule = (c: Connection) => {
    if (c.timer) clearInterval(c.timer);
    c.timer = setInterval(() => c.listener?.(), c.idling ? IDLE_REFRESH_MS : REFRESH_MS);
    c.timer.unref?.();
  };

  server.notifier = {
    addListener(session: ImapSession, listener: Connection["listener"]) {
      const c = connections.get(session.id);
      if (!c) return;
      c.listener = listener;
      schedule(c);
    },
    removeListener(session: ImapSession) {
      const c = connections.get(session.id);
      if (!c) return;
      c.listener = null;
      if (c.timer) clearInterval(c.timer);
      c.timer = null;
    },
    getUpdates(
      mailbox: { key?: string },
      _modifyIndex: number,
      callback: (err: Error | null, entries?: unknown[]) => void,
    ) {
      const sessionId = typeof mailbox?.key === "string" ? mailbox.key.split("|")[0]! : "";
      const c = connections.get(sessionId);
      if (!c?.selected || c.selected.ref !== mailbox) return callback(null, []);
      run({ id: sessionId } as ImapSession, updates).then(
        (entries) => callback(null, entries),
        (err: Error) => callback(err),
      );
    },
    releaseConnection(data: { session: ImapSession }, callback: () => void) {
      const c = connections.get(data.session.id);
      if (c?.timer) clearInterval(c.timer);
      connections.delete(data.session.id);
      callback();
    },
  };

  server.onAuth = (login, session, callback) => {
    const ip = `ip:${session.remoteAddress ?? ""}`;
    const user = `user:${(login.username ?? "").trim().toLowerCase()}`;
    if (recent(ip) >= MAX_FAILURES_PER_IP || recent(user) >= MAX_FAILURES_PER_USER) {
      callback(
        Object.assign(new Error("too many attempts"), {
          response: "NO",
          code: "LIMIT",
          message: "Too many failed sign-ins, try again later",
        }),
      );
      return;
    }
    authenticateMailboxAppPassword(deps.db, deps.passwordKey, {
      username: login.username ?? "",
      password: login.password ?? "",
    }).then(
      (identity) => {
        if (!identity) {
          fail(ip);
          fail(user);
          callback(null);
          return;
        }
        connections.set(session.id, {
          identity,
          actor: { teamId: identity.teamId, userId: identity.userId },
          selected: null,
          chain: Promise.resolve(),
          listener: null,
          timer: null,
          idling: false,
          checkedAt: now(),
        });
        callback(null, { user: { id: identity.passwordId, username: identity.address } });
      },
      (err: Error) => callback(err),
    );
  };

  const listing = (session: ImapSession, callback: (err: Error | null, ...r: unknown[]) => void) =>
    respond(run(session, folders), callback, (list) => [
      list.map((folder) => ({
        path: folder.path,
        specialUse: folder.specialUse ?? undefined,
        flags: [],
      })),
    ]);
  server.onList = (_query, session, callback) => listing(session, callback);
  server.onLsub = (_query, session, callback) => listing(session, callback);
  // Every folder counts as subscribed.
  server.onSubscribe = (path, session, callback) =>
    respond(run(session, folders), callback, (list) => [
      resolveMailboxImapFolder(list, path) ? true : "NONEXISTENT",
    ]);
  server.onUnsubscribe = server.onSubscribe;

  server.onCreate = (path, session, callback) =>
    respond(
      run(session, async (c) => {
        if (resolveMailboxImapFolder(await folders(c), path)) return "ALREADYEXISTS";
        if (path.includes("/") || !path.trim()) return "CANNOT";
        await createMailboxFolder(deps.db, c.actor, {
          mailboxId: c.identity.mailboxId,
          name: path.trim(),
        });
        return true;
      }),
      callback,
      (result) => [result],
    );
  /** The owner's folder by IMAP path, with its revision (special folders are not theirs). */
  const ownFolder = async (c: Connection, path: string) => {
    const folder = resolveMailboxImapFolder(await folders(c), path);
    if (!folder?.key.startsWith("folder:")) return { folder, row: null };
    const rows = await listMailboxFolders(deps.db, c.actor, { mailboxId: c.identity.mailboxId });
    return { folder, row: rows.find((row) => `folder:${row.id}` === folder.key) ?? null };
  };
  server.onRename = (path, to, session, callback) =>
    respond(
      run(session, async (c) => {
        const { folder, row } = await ownFolder(c, path);
        if (!folder) return "NONEXISTENT";
        if (!row) return "CANNOT";
        if (resolveMailboxImapFolder(await folders(c), to)) return "ALREADYEXISTS";
        if (to.includes("/") || !to.trim()) return "CANNOT";
        await updateMailboxFolder(deps.db, c.actor, {
          mailboxId: c.identity.mailboxId,
          id: row.id,
          expectedRevision: row.revision,
          name: to.trim(),
        });
        return true;
      }),
      callback,
      (result) => [result],
    );
  server.onDelete = (path, session, callback) =>
    respond(
      run(session, async (c) => {
        const { folder, row } = await ownFolder(c, path);
        if (!folder) return "NONEXISTENT";
        if (!row) return "CANNOT";
        await archiveMailboxFolder(deps.db, c.actor, {
          mailboxId: c.identity.mailboxId,
          id: row.id,
          expectedRevision: row.revision,
        });
        return true;
      }),
      callback,
      (result) => [result],
    );

  server.onOpen = (path, session, callback) =>
    respond(
      run(session, async (c) => {
        const folder = resolveMailboxImapFolder(await folders(c), path);
        if (!folder) return null;
        const state = await sync(c, folder.key);
        const key = `${session.id}|${folder.key}|${now()}`;
        c.selected = {
          ref: { key, toString: () => key },
          folder,
          uidValidity: state.uidValidity,
          messages: new Map(state.messages.map((m) => [m.uid, m])),
          deleted: new Set(),
          modseq: 1,
        };
        return {
          _id: c.selected.ref,
          specialUse: folder.specialUse ?? undefined,
          uidValidity: state.uidValidity,
          uidNext: state.uidNext,
          modifyIndex: 1,
          uidList: state.messages.map((m) => m.uid),
        };
      }),
      callback,
      (result) => [result ?? "NONEXISTENT"],
    );

  server.onStatus = (path, session, callback) =>
    respond(
      run(session, async (c) => {
        const folder = resolveMailboxImapFolder(await folders(c), path);
        if (!folder) return null;
        const state = await sync(c, folder.key);
        return {
          messages: state.messages.length,
          uidNext: state.uidNext,
          uidValidity: state.uidValidity,
          highestModseq: 1,
          unseen: state.messages.filter((m) => !m.flags.includes("\\Seen")).length,
        };
      }),
      callback,
      (result) => [result ?? "NONEXISTENT"],
    );

  server.onFetch = (mailbox, options, session, callback) =>
    respond(
      run(session, async (c) => {
        const selected = selectedOf(c, mailbox);
        if (!selected) return "NONEXISTENT";
        const wanted = new Set(options.messages);
        const messages = [...selected.messages.values()]
          .filter((m) => wanted.has(m.uid))
          .sort((a, b) => a.uid - b.uid);
        if (options.markAsSeen) {
          const unseen = messages.filter((m) => !m.flags.includes("\\Seen"));
          if (unseen.length) {
            await setMailboxImapFlags(deps.db, c.actor, c.identity.mailboxId, unseen, {
              seen: true,
            });
            for (const m of unseen) m.flags = [...m.flags, "\\Seen"];
          }
        }
        const utf8 = session.isUTF8Enabled?.() ?? false;
        // Only these come from the Correio's own columns; anything else reads the MIME.
        const metadataOnly = options.query.every((q) => METADATA_ITEMS.has(q.item));
        for (let i = 0; i < messages.length; i += FETCH_BATCH) {
          const batch = messages.slice(i, i + FETCH_BATCH);
          const raw = metadataOnly
            ? new Map<string, Buffer>()
            : await readMailboxImapMessages(
                deps.db,
                deps.keyring,
                c.actor,
                c.identity.mailboxId,
                batch.map((m) => m.itemId),
              );
          for (const message of batch) {
            const body = raw.get(message.itemId);
            // Content asked of a message that could not be read (gone meanwhile): skip it.
            if (!metadataOnly && !body) continue;
            const values = session.getQueryResponse(
              options.query,
              imapMessage(message, selected, body),
              {
                acceptUTF8Enabled: utf8,
              },
            );
            await new Promise<void>((resolve) =>
              session.writeStream.write(
                compileStream(
                  session.formatResponse("FETCH", message.uid, { query: options.query, values }),
                ),
                resolve,
              ),
            );
          }
        }
        return true;
      }),
      callback,
      (result) => [result],
    );

  server.onSearch = (mailbox, options, session, callback) =>
    respond(
      run(session, async (c) => {
        const selected = selectedOf(c, mailbox);
        if (!selected) return "NONEXISTENT";
        const messages = [...selected.messages.values()].sort((a, b) => a.uid - b.uid);
        const content = options.terms.some((term) => ["body", "text", "header"].includes(term));
        const uidList: number[] = [];
        for (let i = 0; i < messages.length; i += FETCH_BATCH) {
          const batch = messages.slice(i, i + FETCH_BATCH);
          const raw = content
            ? await readMailboxImapMessages(
                deps.db,
                deps.keyring,
                c.actor,
                c.identity.mailboxId,
                batch.map((m) => m.itemId),
              )
            : new Map<string, Buffer>();
          for (const message of batch) {
            const body = raw.get(message.itemId);
            if (content && !body) continue;
            const match = await new Promise<boolean>((resolve) =>
              session.matchSearchQuery(
                imapMessage(message, selected, body),
                options.query,
                (err, ok) => resolve(!err && ok),
              ),
            );
            if (match) uidList.push(message.uid);
          }
        }
        return { uidList, highestModseq: selected.modseq };
      }),
      callback,
      (result) => [result],
    );

  server.onStore = (mailbox, update, session, callback) =>
    respond(
      run(session, async (c) => {
        const selected = selectedOf(c, mailbox);
        if (!selected) return "NONEXISTENT";
        const has = (flag: string) =>
          update.value.some((v) => v.toLowerCase() === flag.toLowerCase());
        const wanted = new Set(update.messages);
        const messages = [...selected.messages.values()].filter((m) => wanted.has(m.uid));
        const want = (current: boolean, flag: string) =>
          update.action === "set"
            ? has(flag)
            : update.action === "add"
              ? current || has(flag)
              : current && !has(flag);
        const seenOn = messages.filter((m) => !m.flags.includes("\\Seen") && want(false, "\\Seen"));
        const seenOff = messages.filter(
          (m) => m.kind === "inbox" && m.flags.includes("\\Seen") && !want(true, "\\Seen"),
        );
        const flagOn = messages.filter(
          (m) => !m.flags.includes("\\Flagged") && want(false, "\\Flagged"),
        );
        const flagOff = messages.filter(
          (m) => m.flags.includes("\\Flagged") && !want(true, "\\Flagged"),
        );
        const mailboxId = c.identity.mailboxId;
        if (seenOn.length)
          await setMailboxImapFlags(deps.db, c.actor, mailboxId, seenOn, { seen: true });
        if (seenOff.length)
          await setMailboxImapFlags(deps.db, c.actor, mailboxId, seenOff, { seen: false });
        if (flagOn.length)
          await setMailboxImapFlags(deps.db, c.actor, mailboxId, flagOn, { flagged: true });
        if (flagOff.length)
          await setMailboxImapFlags(deps.db, c.actor, mailboxId, flagOff, { flagged: false });
        for (const m of messages) {
          const flags = new Set(m.flags);
          if (seenOn.includes(m)) flags.add("\\Seen");
          if (seenOff.includes(m)) flags.delete("\\Seen");
          if (flagOn.includes(m)) flags.add("\\Flagged");
          if (flagOff.includes(m)) flags.delete("\\Flagged");
          m.flags = [...flags];
          if (want(selected.deleted.has(m.uid), "\\Deleted")) selected.deleted.add(m.uid);
          else selected.deleted.delete(m.uid);
          if (!update.silent)
            session.writeStream.write(
              session.formatResponse("FETCH", m.uid, {
                uid: update.isUid ? m.uid : false,
                flags: imapMessage(m, selected).flags,
              }),
            );
        }
        return true;
      }),
      callback,
      (result) => (result === true ? [true, []] : [result]),
    );

  /** Moves out of the selected folder and tells the client which UIDs left (EXPUNGE). */
  const moveOut = async (
    c: Connection,
    session: ImapSession,
    selected: Selected,
    uids: number[],
    to: MailboxImapFolderKey,
    silent = false,
  ) => {
    const messages = uids.map((uid) => selected.messages.get(uid)).filter((m) => !!m);
    if (!messages.length) return { outcome: "moved" as const, messages };
    const outcome = await moveMailboxImapMessages(
      deps.db,
      c.actor,
      c.identity.mailboxId,
      selected.folder.key,
      to,
      messages,
    );
    if (outcome !== "moved") return { outcome, messages };
    for (const m of messages) {
      selected.messages.delete(m.uid);
      selected.deleted.delete(m.uid);
      // formatResponse also takes the UID out of the client's sequence numbering.
      const response = session.formatResponse("EXPUNGE", m.uid);
      if (response && !silent) session.writeStream.write(response);
    }
    return { outcome, messages };
  };

  server.onExpunge = (mailbox, update, session, callback) =>
    respond(
      run(session, async (c) => {
        const selected = selectedOf(c, mailbox);
        if (!selected) return "NONEXISTENT";
        const marked = [...selected.deleted].filter(
          (uid) => !update.isUid || update.messages.includes(uid),
        );
        // In Lixeira nothing is erased from a mail app: the flag just goes away.
        if (selected.folder.key === "trash") {
          for (const uid of marked) selected.deleted.delete(uid);
          return true;
        }
        await moveOut(c, session, selected, marked, "trash", update.silent);
        return true;
      }),
      callback,
      (result) => [result],
    );

  const destination = async (c: Connection, path: string) =>
    resolveMailboxImapFolder(await folders(c), path);
  /** The destination's UIDs for the moved items (they get them on this sync). */
  const destinationUids = async (c: Connection, key: MailboxImapFolderKey, itemIds: string[]) => {
    const state = await sync(c, key);
    const byItem = new Map(state.messages.map((m) => [m.itemId, m.uid]));
    return { uidValidity: state.uidValidity, uids: itemIds.map((id) => byItem.get(id) ?? 0) };
  };
  const transfer = (
    mailbox: unknown,
    update: { destination: string; messages: number[] },
    session: ImapSession,
    callback: (err: Error | null, ...r: unknown[]) => void,
    expunge: boolean,
  ) =>
    respond(
      run(session, async (c) => {
        const selected = selectedOf(c, mailbox);
        if (!selected) return { code: "NONEXISTENT" as const };
        const to = await destination(c, update.destination);
        if (!to) return { code: "TRYCREATE" as const };
        const uids = update.messages.filter((uid) => selected.messages.has(uid));
        const itemIds = uids.map((uid) => selected.messages.get(uid)!.itemId);
        // A message lives in one view at a time: COPY files it there too, and the source
        // shows it gone on its next refresh (MOVE says so at once).
        const moved = expunge
          ? await moveOut(c, session, selected, uids, to.key)
          : {
              outcome: await moveMailboxImapMessages(
                deps.db,
                c.actor,
                c.identity.mailboxId,
                selected.folder.key,
                to.key,
                uids.map((uid) => selected.messages.get(uid)!),
              ),
            };
        if (moved.outcome !== "moved") return { code: "CANNOT" as const };
        const dest = await destinationUids(c, to.key, itemIds);
        return {
          code: true as const,
          info: { uidValidity: dest.uidValidity, sourceUid: uids, destinationUid: dest.uids },
        };
      }),
      callback,
      (result) => (result.code === true ? [true, result.info] : [result.code]),
    );
  server.onMove = (mailbox, update, session, callback) =>
    transfer(mailbox, update, session, callback, true);
  server.onCopy = (_connection, mailbox, update, session, callback) =>
    transfer(mailbox, update, session, callback, false);

  server.onAppend = (path, flags, date, raw, session, callback) =>
    respond(
      run(session, async (c) => {
        const folder = await destination(c, path);
        if (!folder) return { code: "TRYCREATE" as const };
        if (folder.key === "trash" || folder.key === "spam") return { code: "CANNOT" as const };
        const when = date ? new Date(date) : null;
        const added = await appendMailboxImapMessage(
          deps.db,
          deps.keyring,
          c.actor,
          c.identity.mailboxId,
          folder.key,
          raw,
          {
            seen: flags.some((f) => f.toLowerCase() === "\\seen"),
            date: when && !Number.isNaN(when.getTime()) ? when : null,
            recentlySent: (key) => deps.recentlySent?.(c.identity.mailboxId, key) ?? false,
          },
        );
        if (!added) return { code: true as const, info: undefined };
        const dest = await destinationUids(c, folder.key, [added.itemId]);
        if (flags.some((f) => f.toLowerCase() === "\\flagged")) {
          const state = await sync(c, folder.key);
          const message = state.messages.find((m) => m.itemId === added.itemId);
          if (message)
            await setMailboxImapFlags(deps.db, c.actor, c.identity.mailboxId, [message], {
              flagged: true,
            });
        }
        return {
          code: true as const,
          info: dest.uids[0] ? { uidValidity: dest.uidValidity, uid: dest.uids[0] } : undefined,
        };
      }),
      callback,
      (result) => (result.code === true ? [true, result.info] : [result.code]),
    );

  server.onIdleStart = (_mailbox, session) => {
    const c = connections.get(session.id);
    if (!c) return;
    c.idling = true;
    schedule(c);
  };
  server.onIdleEnd = (_mailbox, session) => {
    const c = connections.get(session.id);
    if (!c) return;
    c.idling = false;
    schedule(c);
  };

  server.on("error", (err) => {
    console.error("imap server error", err.message);
  });
  const close = server.close.bind(server);
  server.close = (callback?: () => void) => {
    unsubscribe?.();
    for (const c of connections.values()) if (c.timer) clearInterval(c.timer);
    close(callback);
  };
  return server;
}
