import { lookup } from "node:dns/promises";
import {
  ImapError,
  MAILBOX_EXTERNAL_PRESETS,
  type MailboxExternalPresetId,
  openImap,
  publicAddress,
} from "@millionsend/core";
import nodemailer from "nodemailer";

/**
 * Contas externas: before an account is saved, prove both doors open with what the
 * person typed — IMAP (LOGIN on 993) and SMTP (AUTH on 465/587). Both servers are user
 * input on the open internet: names must resolve only to public addresses and the
 * connection goes to the checked address (TLS still verifies the name). The password is
 * used for these two logins and handed back to the caller to seal; nothing is kept here.
 */

export interface MailboxExternalServers {
  provider: MailboxExternalPresetId;
  imapHost: string;
  smtpHost: string;
  smtpPort: 465 | 587;
  smtpSecurity: "tls" | "starttls";
  username: string;
}

export type MailboxExternalCheckFailure =
  | "provider_unavailable"
  | "invalid_server"
  | "imap_login"
  | "imap_network"
  | "smtp_login"
  | "smtp_network";

export class MailboxExternalCheckError extends Error {
  constructor(public readonly reason: MailboxExternalCheckFailure) {
    super(reason);
  }
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The servers for a provider: the preset's, or the person's own for "imap". */
export function mailboxExternalServers(input: {
  provider: MailboxExternalPresetId;
  address: string;
  username?: string | undefined;
  imapHost?: string | undefined;
  smtpHost?: string | undefined;
  smtpPort?: 465 | 587 | undefined;
}): MailboxExternalServers {
  const preset = MAILBOX_EXTERNAL_PRESETS[input.provider];
  if (!preset?.available) throw new MailboxExternalCheckError("provider_unavailable");
  const imapHost = (preset.imapHost ?? input.imapHost ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const smtpHost = (preset.smtpHost ?? input.smtpHost ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const smtpPort = preset.smtpHost ? preset.smtpPort : (input.smtpPort ?? 465);
  if (!HOST.test(imapHost) || !HOST.test(smtpHost))
    throw new MailboxExternalCheckError("invalid_server");
  const username = (input.username?.trim() || input.address.trim()).slice(0, 254);
  return {
    provider: input.provider,
    imapHost,
    smtpHost,
    smtpPort,
    smtpSecurity: smtpPort === 465 ? "tls" : "starttls",
    username,
  };
}

/** A public address for an SMTP server name (every DNS answer public, or refused). */
async function smtpAddress(host: string): Promise<string> {
  let answers: { address: string }[];
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new MailboxExternalCheckError("smtp_network");
  }
  if (!answers.length) throw new MailboxExternalCheckError("smtp_network");
  if (!answers.every((entry) => publicAddress(entry.address)))
    throw new MailboxExternalCheckError("invalid_server");
  return answers[0]!.address;
}

/**
 * IMAP LOGIN, then SMTP AUTH; throws the first door that stays shut. An app password signs
 * in as typed; an OAuth access token (from "Entrar com a Microsoft/o Google") uses XOAUTH2.
 */
export async function checkMailboxExternalAccount(
  servers: MailboxExternalServers,
  credential: string | { accessToken: string },
): Promise<void> {
  const login =
    typeof credential === "string"
      ? { password: credential }
      : { accessToken: credential.accessToken };
  try {
    const session = await openImap(
      { host: servers.imapHost, port: 993, username: servers.username, ...login },
      { timeoutMs: 15_000 },
    );
    await session.logout();
  } catch (error) {
    // The provider's own words for a refused sign-in (Outlook.com refuses XOAUTH2 while the
    // account has IMAP off, for one). They never carry the credential.
    if (error instanceof ImapError && error.reason === "login" && error.detail)
      console.warn(
        `contas externas: ${servers.imapHost} refused the IMAP sign-in: ${error.detail}`,
      );
    if (error instanceof ImapError)
      throw new MailboxExternalCheckError(
        error.reason === "login"
          ? "imap_login"
          : error.reason === "blocked"
            ? "invalid_server"
            : "imap_network",
      );
    throw new MailboxExternalCheckError("imap_network");
  }
  const address = await smtpAddress(servers.smtpHost);
  const transport = nodemailer.createTransport({
    host: address,
    port: servers.smtpPort,
    secure: servers.smtpSecurity === "tls",
    requireTLS: servers.smtpSecurity === "starttls",
    auth:
      "accessToken" in login
        ? { type: "OAuth2", user: servers.username, accessToken: login.accessToken }
        : { user: servers.username, pass: login.password },
    tls: { servername: servers.smtpHost, minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.verify();
  } catch (error) {
    const code = (error as { code?: string; responseCode?: number }).code;
    const status = (error as { responseCode?: number }).responseCode ?? 0;
    throw new MailboxExternalCheckError(
      code === "EAUTH" || status === 535 || status === 534 ? "smtp_login" : "smtp_network",
    );
  } finally {
    transport.close();
  }
}
