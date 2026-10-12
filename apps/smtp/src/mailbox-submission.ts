import {
  type Keyring,
  MailboxContentError,
  MailboxServiceError,
  type MailboxTransportMimeAdapter,
  queueMailboxDraft,
  saveMailboxDraft,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { simpleParser } from "mailparser";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import {
  authenticateMailboxAppPassword,
  type MailboxClientIdentity,
} from "../../../packages/core/src/mailbox-app-passwords.js";

/**
 * SMTP submission for mail clients (specs/correio-imap-smtp.md): Outlook, Apple Mail,
 * Thunderbird or the Gmail app send as a Correio mailbox with its address and an app
 * password, on 465 (TLS) and 587 (STARTTLS). Each message becomes a draft of the mailbox
 * and goes out through the same admission as the Correio's own Send button: the owner's
 * human send, with its plan, seat, limits, recipient blocks and duplicate guard, and the
 * copy lands in Enviados.
 */

/** The Correio's own ceiling for outgoing mail (drafts and the outbox hold 1 MiB). */
export const MAX_SUBMISSION_BYTES = 1024 * 1024;
export const MAX_SUBMISSION_RCPT = 20;
const MAX_CLIENTS = 200;
const MAX_CONNECTIONS_PER_IP = 20;
/** Failed sign-ins tolerated per address and per IP in a window, then 421 until it ends. */
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_PER_USER = 20;

export interface MailboxSubmissionDeps {
  db: Db;
  keyring: Keyring;
  /** deriveMailboxAppPasswordKey(master key). */
  passwordKey: Buffer;
  mime: MailboxTransportMimeAdapter;
  /** queue.send("mailbox.send", { outboxId }), as the web's Send does. */
  enqueueSend: (outboxId: string) => Promise<void>;
  /** MAILBOX_TRANSPORT_ENABLED: off, every message is a 451. */
  transportEnabled: boolean;
  /** After a message is queued (recent-sends.ts: IMAP then knows its copy in Enviados). */
  onQueued?: (mailboxId: string, raw: Buffer) => void;
  tls?: { key: Buffer; cert: Buffer } | undefined;
  /** 465: TLS from the first byte. Otherwise STARTTLS (587). */
  secure?: boolean;
  /** Tests on loopback only. */
  allowInsecureAuth?: boolean;
  /**
   * Behind the host's nginx stream proxy (the container's ports are published on
   * loopback only): each connection starts with a PROXY header naming the client.
   */
  proxyProtocol?: boolean;
  now?: () => number;
}

function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

function toSmtpError(err: unknown): Error {
  if (err instanceof Error && "responseCode" in err) return err;
  if (err instanceof MailboxServiceError)
    return smtpError(
      err.code === "quota" ? 452 : 550,
      err.code === "quota"
        ? "The plan's sending allowance is used up for this period"
        : "This mailbox cannot send now: check its plan in the Correio",
    );
  if (err instanceof MailboxContentError)
    return err.code === "invalid"
      ? smtpError(554, "Message refused: check the sender, the recipients (up to 20) and the size")
      : err.code === "forbidden"
        ? smtpError(550, "This mailbox cannot send now: check it in the Correio")
        : smtpError(451, "Try again in a moment");
  console.error("mailbox submission internal error", err);
  return smtpError(451, "Temporary local error, please retry");
}

/** Addresses of a header, lower-cased. */
function headerAddresses(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((v: { value?: { address?: string }[] }) => v.value ?? [])
    .map((v) => v.address?.toLowerCase())
    .filter((v): v is string => !!v);
}

/**
 * The client's MIME with its Bcc header replaced by the envelope recipients that are not
 * in To or Cc: the draft then names every recipient, and the provider adapter takes the
 * Bcc header off before sending (as for the Correio's own Bcc).
 */
export function withEnvelopeBcc(raw: Buffer, bcc: string[]): Buffer {
  const text = raw.toString("latin1");
  const split = text.search(/\r?\n\r?\n/);
  const head = split === -1 ? text : text.slice(0, split);
  const rest = split === -1 ? "" : text.slice(split);
  const newline = head.includes("\r\n") ? "\r\n" : "\n";
  const kept: string[] = [];
  let dropping = false;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = /^bcc\s*:/i.test(line);
    if (!dropping) kept.push(line);
  }
  if (bcc.length) kept.push(`Bcc: ${bcc.join(", ")}`);
  return Buffer.from(kept.join(newline) + rest, "latin1");
}

async function submit(
  deps: MailboxSubmissionDeps,
  identity: MailboxClientIdentity,
  session: SMTPServerSession,
  raw: Buffer,
): Promise<string> {
  if (!deps.transportEnabled) throw smtpError(451, "Sending is paused, try again later");
  const mailFrom = session.envelope.mailFrom;
  const envelopeFrom = mailFrom ? mailFrom.address.toLowerCase() : "";
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const from = headerAddresses(parsed.from);
  // Mail goes out from the mailbox's own address (aliases receive, they do not send yet).
  if (from.length !== 1 || from[0] !== identity.address || envelopeFrom !== identity.address)
    throw smtpError(553, `Send as ${identity.address}: other From addresses are not allowed`);
  const envelope = [...new Set(session.envelope.rcptTo.map((r) => r.address.toLowerCase()))];
  const visible = [...headerAddresses(parsed.to), ...headerAddresses(parsed.cc)];
  // The envelope decides delivery, so nothing in To/Cc may be outside it. A client that
  // went past the recipient limit had the extra RCPTs refused: say that, not "stray".
  const stray = visible.find((address) => !envelope.includes(address));
  if (stray && envelope.length >= MAX_SUBMISSION_RCPT)
    throw smtpError(452, `Up to ${MAX_SUBMISSION_RCPT} recipients per message`);
  if (stray) throw smtpError(554, `${stray} is in the headers but not in RCPT TO`);
  const bcc = envelope.filter((address) => !visible.includes(address));
  const actor = { teamId: identity.teamId, userId: identity.userId };
  const draft = await saveMailboxDraft(deps.db, deps.keyring, actor, {
    mailboxId: identity.mailboxId,
    expectedRevision: 0,
    raw: withEnvelopeBcc(raw, bcc),
  });
  const queued = await queueMailboxDraft(
    deps.db,
    deps.keyring,
    actor,
    { mailboxId: identity.mailboxId, id: draft.id, expectedRevision: draft.revision },
    deps.mime,
  );
  deps.onQueued?.(identity.mailboxId, raw);
  // Commit-first outbox: the reconcile sends it even if this enqueue fails.
  await deps.enqueueSend(queued.id).catch((err) => {
    console.warn("mailbox submission enqueue deferred", err instanceof Error ? err.message : err);
  });
  return `Queued as ${queued.id}`;
}

export function createMailboxSubmissionServer(deps: MailboxSubmissionDeps): SMTPServer {
  const now = deps.now ?? Date.now;
  const connectionsByIp = new Map<string, number>();
  const admitted = new Set<string>();
  const failures = new Map<string, number[]>();
  const recent = (key: string) => {
    const since = now() - FAILURE_WINDOW_MS;
    const kept = (failures.get(key) ?? []).filter((at) => at > since);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept.length;
  };
  const fail = (key: string) => failures.set(key, [...(failures.get(key) ?? []), now()]);
  return new SMTPServer({
    ...(deps.tls
      ? { key: deps.tls.key, cert: deps.tls.cert, secure: deps.secure ?? false }
      : { hideSTARTTLS: true, allowInsecureAuth: deps.allowInsecureAuth ?? false }),
    ...(deps.proxyProtocol ? { useProxy: true } : {}),
    name: "smtp.mepmail.dev",
    banner: "MepMail Correio submission",
    authMethods: ["PLAIN", "LOGIN"],
    size: MAX_SUBMISSION_BYTES,
    maxClients: MAX_CLIENTS,
    disabledCommands: deps.tls || deps.allowInsecureAuth ? [] : ["AUTH"],
    onConnect(session, callback) {
      const open = connectionsByIp.get(session.remoteAddress) ?? 0;
      if (open >= MAX_CONNECTIONS_PER_IP) {
        callback(smtpError(421, "Too many connections from your address, try again later"));
        return;
      }
      connectionsByIp.set(session.remoteAddress, open + 1);
      admitted.add(session.id);
      callback();
    },
    onClose(session) {
      if (!admitted.delete(session.id)) return;
      const open = (connectionsByIp.get(session.remoteAddress) ?? 1) - 1;
      if (open <= 0) connectionsByIp.delete(session.remoteAddress);
      else connectionsByIp.set(session.remoteAddress, open);
    },
    onAuth(auth, session, callback) {
      const ip = `ip:${session.remoteAddress}`;
      const user = `user:${(auth.username ?? "").trim().toLowerCase()}`;
      if (recent(ip) >= MAX_FAILURES_PER_IP || recent(user) >= MAX_FAILURES_PER_USER) {
        callback(smtpError(421, "Too many failed sign-ins, try again later"));
        return;
      }
      void authenticateMailboxAppPassword(deps.db, deps.passwordKey, {
        username: auth.username ?? "",
        password: auth.password ?? "",
      }).then(
        (identity) => {
          if (identity) {
            callback(null, { user: identity });
            return;
          }
          fail(ip);
          fail(user);
          callback(
            smtpError(535, "Authentication failed: use the mailbox address and an app password"),
          );
        },
        (err) => callback(toSmtpError(err)),
      );
    },
    onMailFrom(address, session, callback) {
      const identity = session.user as unknown as MailboxClientIdentity | undefined;
      if (!identity) {
        callback(smtpError(530, "Authentication required"));
        return;
      }
      if (address.address.toLowerCase() !== identity.address) {
        callback(smtpError(553, `Send as ${identity.address}`));
        return;
      }
      callback();
    },
    onRcptTo(_address, session, callback) {
      if (session.envelope.rcptTo.length >= MAX_SUBMISSION_RCPT) {
        callback(smtpError(452, `Up to ${MAX_SUBMISSION_RCPT} recipients per message`));
        return;
      }
      callback();
    },
    onData(stream: SMTPServerDataStream, session, callback) {
      const chunks: Buffer[] = [];
      let received = 0;
      stream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_SUBMISSION_BYTES) chunks.length = 0;
        else chunks.push(chunk);
      });
      stream.once("end", () => {
        void (async () => {
          if (stream.sizeExceeded || received > MAX_SUBMISSION_BYTES)
            throw smtpError(552, "Messages sent from the Correio go up to 1 MiB");
          const identity = session.user as unknown as MailboxClientIdentity | undefined;
          if (!identity) throw smtpError(530, "Authentication required");
          return submit(deps, identity, session, Buffer.concat(chunks));
        })().then(
          (message) => callback(null, message),
          (err) => callback(toSmtpError(err)),
        );
      });
    },
  });
}
