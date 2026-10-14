import { lookup } from "node:dns/promises";
import {
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
 * person sees "senha recusada" and replaces it.
 */
export function createMailboxExternalAwareSender(
  db: Db,
  keyring: Keyring,
  ses: MailboxOutboxSender | null,
  credentialFor: typeof mailboxExternalCredential = mailboxExternalCredential,
): MailboxOutboxSender {
  return {
    async send(input) {
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
        const answers = await lookup(account.smtpHost, { all: true, verbatim: true });
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
        if (
          error instanceof MailboxExternalOAuthError &&
          (error.reason === "invalid_grant" || error.reason === "unconfigured")
        ) {
          await markMailboxExternalAuthFailed(db, input.mailboxId, "oauth_refused");
          throw new MailboxSendRejectedError();
        }
        throw new MailboxSendDeferredError();
      }
      const transport = nodemailer.createTransport({
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
        if (e.code === "EAUTH" || e.responseCode === 535 || e.responseCode === 534) {
          await markMailboxExternalAuthFailed(db, input.mailboxId, "smtp_login");
          throw new MailboxSendRejectedError();
        }
        if (typeof e.responseCode === "number" && e.responseCode >= 400 && e.responseCode < 600)
          throw e.responseCode < 500
            ? new MailboxSendDeferredError()
            : new MailboxSendRejectedError();
        throw error;
      } finally {
        transport.close();
      }
    },
  };
}
