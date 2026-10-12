import { readFileSync } from "node:fs";
import { appHostname, env, umamiFunnel } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { EMAIL_SEND_PRIORITY, Queue } from "@millionsend/queue";
import { createKeyringFromEnv } from "@millionsend/ses";
import { deriveMailboxAppPasswordKey } from "../../../packages/core/src/mailbox-app-passwords.js";
import { listenToChannel } from "../../../packages/db/src/listen.js";
import { createMailboxImapServer } from "./imap/server.js";
import { createMailboxSubmissionServer } from "./mailbox-submission.js";
import { mailboxSubmissionMime } from "./mailbox-transport-mime.js";
import { recentlySent, rememberSent } from "./recent-sends.js";
import { createSmtpServer } from "./smtp.js";

// Throws on missing encryption configuration, so boot fails before any
// listener starts.
const keyring = createKeyringFromEnv(env);

// The relay is an email.send producer, so the queue is unconditional.
const queue = await Queue.start(env.DATABASE_URL);

const certPath = env.SMTP_TLS_CERT_PATH;
const keyPath = env.SMTP_TLS_KEY_PATH;
if (!certPath && !env.SMTP_ALLOW_INSECURE_AUTH) {
  throw new Error(
    "SMTP requires TLS; set SMTP_TLS_CERT_PATH and SMTP_TLS_KEY_PATH, or explicitly set SMTP_ALLOW_INSECURE_AUTH=true only on a trusted private network",
  );
}

const server = createSmtpServer({
  db: getDb(),
  keyring,
  isCloud: env.IS_CLOUD,
  enqueueEmailSend: async (emailId, opts) => {
    await queue.send(
      "email.send",
      { emailId },
      {
        dedupeKey: emailId,
        priority: EMAIL_SEND_PRIORITY.transactional,
        ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}),
      },
    );
  },
  // A relay send is the team's send like any other: the funnel's activation
  // step is claimed here too (a no-op wherever UMAMI_ENDPOINT/UMAMI_WEBSITE_ID
  // are not set explicitly — umamiFunnel has no default).
  funnel: { ...umamiFunnel(), hostname: appHostname() },
  ...(certPath && keyPath
    ? { tls: { cert: readFileSync(certPath), key: readFileSync(keyPath) } }
    : {}),
  allowInsecureAuth: env.SMTP_ALLOW_INSECURE_AUTH,
});

server.on("error", (err) => {
  console.error("smtp server error", err);
});

server.listen(env.SMTP_PORT, () => {
  console.log(`mepmail smtp listening on :${env.SMTP_PORT}`);
});

// Correio in mail clients (specs/correio-imap-smtp.md): submission with an app password,
// TLS from the first byte and STARTTLS (the host maps 465 and 587 onto these ports). Off
// unless MAILBOX_SUBMISSION_ENABLED=1 with its own keypair for smtp.mepmail.dev.
const submissionCert = process.env.MAILBOX_SUBMISSION_TLS_CERT_PATH;
const submissionKey = process.env.MAILBOX_SUBMISSION_TLS_KEY_PATH;
if (process.env.MAILBOX_SUBMISSION_ENABLED === "1") {
  if (!submissionCert || !submissionKey)
    throw new Error(
      "MAILBOX_SUBMISSION_ENABLED needs MAILBOX_SUBMISSION_TLS_CERT_PATH and MAILBOX_SUBMISSION_TLS_KEY_PATH",
    );
  const tls = { cert: readFileSync(submissionCert), key: readFileSync(submissionKey) };
  const passwordKey = deriveMailboxAppPasswordKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64"));
  for (const [port, secure] of [
    [Number(process.env.MAILBOX_SUBMISSION_TLS_PORT ?? 1465), true],
    [Number(process.env.MAILBOX_SUBMISSION_STARTTLS_PORT ?? 1587), false],
  ] as const) {
    const submission = createMailboxSubmissionServer({
      db: getDb(),
      keyring,
      passwordKey,
      mime: mailboxSubmissionMime,
      enqueueSend: async (outboxId) => {
        await queue.send("mailbox.send", { outboxId }, { dedupeKey: outboxId });
      },
      transportEnabled: process.env.MAILBOX_TRANSPORT_ENABLED === "1",
      onQueued: rememberSent,
      tls,
      secure,
      proxyProtocol: process.env.MAILBOX_CLIENT_PROXY_PROTOCOL === "1",
    });
    submission.on("error", (err) => {
      console.error("mailbox submission error", err);
    });
    submission.listen(port, () => {
      console.log(
        `mepmail correio submission listening on :${port} (${secure ? "tls" : "starttls"})`,
      );
    });
  }
}

// IMAP for the same mail apps (993 on the host, mapped onto MAILBOX_IMAP_PORT). Same
// keypair as submission (one certificate names imap. and smtp.mepmail.dev).
if (process.env.MAILBOX_IMAP_ENABLED === "1") {
  if (!submissionCert || !submissionKey)
    throw new Error(
      "MAILBOX_IMAP_ENABLED needs MAILBOX_SUBMISSION_TLS_CERT_PATH and MAILBOX_SUBMISSION_TLS_KEY_PATH",
    );
  const arrivals = new Set<(mailboxId: string) => void>();
  // The announcement the web's live updates use (migration 0028): {"t": team, "m": mailbox}.
  await listenToChannel(env.DATABASE_URL, "mailbox_arrivals", (payload) => {
    try {
      const { m } = JSON.parse(payload) as { m?: unknown };
      if (typeof m === "string") for (const listener of arrivals) listener(m);
    } catch {
      // not an arrival
    }
  });
  const imap = createMailboxImapServer({
    db: getDb(),
    keyring,
    passwordKey: deriveMailboxAppPasswordKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64")),
    tls: { cert: readFileSync(submissionCert), key: readFileSync(submissionKey) },
    secure: true,
    proxyProtocol: process.env.MAILBOX_CLIENT_PROXY_PROTOCOL === "1",
    recentlySent,
    onArrival: (listener) => {
      arrivals.add(listener);
      return () => arrivals.delete(listener);
    },
  });
  const imapPort = Number(process.env.MAILBOX_IMAP_PORT ?? 1993);
  imap.listen(imapPort, () => {
    console.log(`mepmail correio imap listening on :${imapPort} (tls)`);
  });
}
