import { createRequire } from "node:module";

/**
 * Typed doors into the vendored imap-core (WildDuck 1.46.1, EUPL-1.2; see
 * apps/smtp/vendor/imap-core/README.md). Only what the Correio's handlers use is typed.
 */
const require = createRequire(import.meta.url);

export interface ImapQueryItem {
  item: string;
  original: unknown;
}

export interface ImapMessage {
  uid: number;
  flags: string[];
  modseq: number;
  idate: Date;
  hdate?: Date;
  size: number;
  raw?: Buffer;
  mimeTree?: unknown;
}

export interface ImapSession {
  id: string;
  remoteAddress?: string;
  user?: { id: string; username: string };
  selected?: { mailbox: unknown; uidList: number[] } | false;
  writeStream: { write(data: unknown, done?: () => void): boolean };
  formatResponse(command: string, uid: number, data?: unknown): unknown;
  getQueryResponse(query: ImapQueryItem[], message: ImapMessage, options?: unknown): unknown[];
  matchSearchQuery(
    message: ImapMessage,
    query: unknown,
    callback: (err: Error | null, match: boolean) => void,
  ): void;
  isUTF8Enabled?: () => boolean;
}

type Callback = (err: Error | null, ...result: unknown[]) => void;

export interface ImapServer {
  notifier: unknown;
  onAuth?: (
    login: { username: string; password: string },
    session: ImapSession,
    callback: Callback,
  ) => void;
  onList?: (query: string, session: ImapSession, callback: Callback) => void;
  onLsub?: (query: string, session: ImapSession, callback: Callback) => void;
  onSubscribe?: (path: string, session: ImapSession, callback: Callback) => void;
  onUnsubscribe?: (path: string, session: ImapSession, callback: Callback) => void;
  onCreate?: (path: string, session: ImapSession, callback: Callback) => void;
  onRename?: (path: string, to: string, session: ImapSession, callback: Callback) => void;
  onDelete?: (path: string, session: ImapSession, callback: Callback) => void;
  onOpen?: (path: string, session: ImapSession, callback: Callback) => void;
  onStatus?: (path: string, session: ImapSession, callback: Callback) => void;
  onAppend?: (
    path: string,
    flags: string[],
    date: string | Date | null,
    raw: Buffer,
    session: ImapSession,
    callback: Callback,
  ) => void;
  onStore?: (
    mailbox: unknown,
    update: ImapStoreUpdate,
    session: ImapSession,
    callback: Callback,
  ) => void;
  onExpunge?: (
    mailbox: unknown,
    update: { isUid: boolean; messages: number[]; silent?: boolean },
    session: ImapSession,
    callback: Callback,
  ) => void;
  onCopy?: (
    connection: unknown,
    mailbox: unknown,
    update: { destination: string; messages: number[] },
    session: ImapSession,
    callback: Callback,
  ) => void;
  onMove?: (
    mailbox: unknown,
    update: { destination: string; messages: number[] },
    session: ImapSession,
    callback: Callback,
  ) => void;
  onFetch?: (
    mailbox: unknown,
    options: ImapFetchOptions,
    session: ImapSession,
    callback: Callback,
  ) => void;
  onSearch?: (
    mailbox: unknown,
    options: { query: unknown; terms: string[]; isUid: boolean },
    session: ImapSession,
    callback: Callback,
  ) => void;
  onIdleStart?: (mailbox: unknown, session: ImapSession) => void;
  onIdleEnd?: (mailbox: unknown, session: ImapSession) => void;
  on(event: "error", listener: (err: Error) => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  listen(port: number, callback?: () => void): void;
  close(callback?: () => void): void;
  server: { address(): unknown };
}

export interface ImapStoreUpdate {
  action: "set" | "add" | "remove";
  value: string[];
  messages: number[];
  silent?: boolean;
  isUid?: boolean;
  unchangedSince?: number;
}

export interface ImapFetchOptions {
  query: ImapQueryItem[];
  messages: number[];
  markAsSeen: boolean;
  metadataOnly?: boolean;
  changedSince?: number;
  isUid: boolean;
}

const core = require("../../vendor/imap-core/index.js") as {
  IMAPServer: new (options: Record<string, unknown>) => ImapServer;
  imapHandler: { compileStream(response: unknown): unknown };
};

const parse = require("../../vendor/imap-core/lib/indexer/parse-mime-tree.js") as (
  raw: Buffer,
) => unknown;

export const IMAPServer = core.IMAPServer;
/** The MIME tree imap-core's FETCH sections and SEARCH read (parsed once per message). */
export const parseMimeTree = (raw: Buffer) => parse(raw);
export const compileStream = (response: unknown) => core.imapHandler.compileStream(response);
