import { lookup } from "node:dns/promises";
import {
  checkSignupSend,
  fetchTeamStanding,
  type Keyring,
  MailboxExternalOAuthError,
  type MailboxOutboxSender,
  MailboxSendDeferredError,
  MailboxSendRejectedError,
  mailboxExternalCredential,
  markMailboxExternalAuthFailed,
  openMailboxExternalAccount,
  publicAddress,
  stripMailboxPrivateHeaders,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";

/**
 * Contas externas: a send from an external mailbox leaves through the provider's own
 * SMTP (Gmail, iCloud…), with the person's address, instead of SES — SES cannot send as
 * @gmail.com. Every other mailbox keeps the SES sender. The provider's SMTP name must
 * resolve only to public addresses and the connection goes to the checked one (TLS still
 * verifies the name). A refused password stops the account (no retry every minute): the
 * person sees "senha recusada" and replaces it. A provider saying "not now" during sign-in
 * (an SMTP 4xx such as 454, even when nodemailer calls it EAUTH) is not a refusal: the
 * message was never handed over, so the send waits and the account stays connected. A
 * refusal seen by a send that opened an older connection (the person signed in again
 * meanwhile) leaves the new connection alone and retries the send with it.
 */
export function createMailboxExternalAwareSender(
  db: Db,
  keyring: Keyring,
  ses: MailboxOutboxSender | null,
  credentialFor: typeof mailboxExternalCredential = mailboxExternalCredential,
  deps: {
    createTransport?: typeof nodemailer.createTransport;
    lookup?: typeof lookup;
  } = {},
): MailboxOutboxSender {
  return {
    async send(input) {
      const recipients = [...input.to, ...input.cc, ...input.bcc];
      const standing = await fetchTeamStanding(db, input.teamId);
      if (standing?.suspended || standing?.sendReview) throw new MailboxSendDeferredError();
      if (!(await checkSignupSend(db, input.teamId, recipients)).allowed)
        throw new MailboxSendDeferredError();
      const [box] = await db
        .select({ origin: schema.mailboxes.origin })
        .from(schema.mailboxes)
        .where(eq(schema.mailboxes.id, input.mailboxId));
      if (box?.origin !== "external") {
        // SES off (MAILBOX_TRANSPORT_ENABLED unset): domain mailboxes wait, as before.
        if (!ses) throw new MailboxSendDeferredError();
        return ses.send(input);
      }
      const account = await openMailboxExternalAccount(db, keyring, input.mailboxId);
      if (!account || account.mailboxStatus !== "planned" || account.address !== input.from)
        throw new MailboxSendRejectedError();
      let address: string;
      try {
        const answers = await (deps.lookup ?? lookup)(account.smtpHost, {
          all: true,
          verbatim: true,
        });
        if (!answers.length || !answers.every((entry) => publicAddress(entry.address)))
          throw new MailboxSendRejectedError();
        address = answers[0]!.address;
      } catch (error) {
        if (error instanceof MailboxSendRejectedError) throw error;
        throw new MailboxSendDeferredError();
      }
      // An OAuth account sends with a fresh access token (XOAUTH2); a refused grant stops it.
      let credential: Awaited<ReturnType<typeof mailboxExternalCredential>>;
      try {
        credential = await credentialFor(db, keyring, account);
      } catch (error) {
        if (error instanceof MailboxExternalOAuthError && error.reason === "invalid_grant") {
          const marked = await markMailboxExternalAuthFailed(
            db,
            input.mailboxId,
            account.connectionGeneration,
            "oauth_refused",
          );
          // An old connection's grant: the person signed in again, so try with the new one.
          if (!marked) throw new MailboxSendDeferredError();
          throw new MailboxSendRejectedError();
        }
        throw new MailboxSendDeferredError();
      }
      const transport = (deps.createTransport ?? nodemailer.createTransport)({
        host: address,
        port: account.smtpPort,
        secure: account.smtpSecurity === "tls",
        requireTLS: account.smtpSecurity === "starttls",
        auth:
          "accessToken" in credential
            ? { type: "OAuth2", user: account.username, accessToken: credential.accessToken }
            : { user: account.username, pass: credential.password },
        tls: { servername: account.smtpHost, minVersion: "TLSv1.2", rejectUnauthorized: true },
        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 60_000,
      });
      try {
        // Credentials/DNS may have waited: a new restriction still precedes SMTP.
        const latest = await fetchTeamStanding(db, input.teamId);
        if (latest?.suspended || latest?.sendReview) throw new MailboxSendDeferredError();
        if (!(await checkSignupSend(db, input.teamId, recipients)).allowed)
          throw new MailboxSendDeferredError();
        const info = await transport.sendMail({
          envelope: { from: input.from, to: [...input.to, ...input.cc, ...input.bcc] },
          // Bcc and the format marker stay on the sealed copies and never leave.
          raw: stripMailboxPrivateHeaders(Buffer.from(input.raw)),
        });
        return { messageId: String(info.messageId ?? input.outboxId) };
      } catch (error) {
        const e = error as { code?: unknown; responseCode?: unknown };
        console.warn(
          `mailbox.send: external SMTP failed (${String(e.code ?? "error")} ${String(e.responseCode ?? "-")})`,
        );
        const status = typeof e.responseCode === "number" ? e.responseCode : null;
        // A 4xx is the provider's "try later", at sign-in (454 4.7.0, which nodemailer
        // reports as EAUTH) or for the message: nothing was accepted, so it waits.
        if (status !== null && status >= 400 && status < 500) throw new MailboxSendDeferredError();
        if (e.code === "EAUTH" || status === 535 || status === 534) {
          const marked = await markMailboxExternalAuthFailed(
            db,
            input.mailboxId,
            account.connectionGeneration,
            "smtp_login",
          );
          // Refused at sign-in, before the message was handed over: with an old
          // connection, the send retries with the new one instead of failing.
          if (!marked) throw new MailboxSendDeferredError();
          throw new MailboxSendRejectedError();
        }
        if (status !== null && status >= 500 && status < 600) throw new MailboxSendRejectedError();
        throw error;
      } finally {
        transport.close();
      }
    },
  };
}
