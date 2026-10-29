import { createTransport } from "nodemailer";
import type { SesSender } from "./send-email.js";

/** What an SMTP sender needs of a nodemailer transport; tests hand in a fake. */
export interface SmtpTransport {
  sendMail(mail: {
    envelope: { from: string; to: string[] };
    raw: Buffer;
  }): Promise<{ messageId?: string; response?: string | undefined }>;
}

/**
 * The platform's own mail over an SMTP relay (SMTP_FALLBACK_URL, e.g.
 * smtps://user:pass@smtp.example.com:465) while SES has paused the account.
 * The MIME is the one built for SES, sent byte for byte; the envelope sender
 * is the relay's authenticated user, so SPF passes for the relay and DKIM is
 * the relay's own signature on the domain. The message id is prefixed so it
 * never collides with an SES id (no SES event will ever join on it).
 */
export function createSmtpFallback(url: string, transport?: SmtpTransport): SesSender {
  const parsed = new URL(url);
  const envelopeFrom = decodeURIComponent(parsed.username);
  if (!envelopeFrom.includes("@"))
    throw new Error("SMTP_FALLBACK_URL user must be a mailbox address");
  return smtpSender(transport ?? createTransport(url), "smtp-fallback:", () => envelopeFrom);
}

/**
 * Customer mail over a second provider's SMTP relay (CUSTOMER_SMTP_RELAY_URL)
 * while SES has paused the account, for the domains an operator verified at
 * that provider. The same raw MIME as the fallback, but the relay's login is
 * no mailbox (an Azure resource id, an OCI user OCID): the envelope sender is
 * the message's own From address, the one the provider approved for the
 * domain, and the provider signs DKIM for it. Ids read
 * `smtp-relay:<name>:<id>`, so a relayed row is told apart at a glance.
 */
export function createCustomerSmtpRelay(
  url: string,
  name: string,
  transport?: SmtpTransport,
): SesSender {
  return smtpSender(transport ?? createTransport(url), `smtp-relay:${name}:`, (params) => {
    if (!params.envelopeFrom) throw new Error("customer relay send without an envelope sender");
    return params.envelopeFrom;
  });
}

function smtpSender(
  transport: SmtpTransport,
  idPrefix: string,
  envelopeFrom: (params: Parameters<SesSender["sendRaw"]>[0]) => string,
): SesSender {
  return {
    async sendRaw(params) {
      const info = await transport.sendMail({
        envelope: {
          from: envelopeFrom(params),
          to: [...params.to, ...(params.cc ?? []), ...(params.bcc ?? [])],
        },
        raw: params.raw,
      });
      if (idPrefix === "smtp-relay:azure:") {
        const id = azureSmtpReceipt(info.response);
        // SMTP has accepted DATA: absent receipt is ambiguous, never retry or use RFC Message-ID.
        if (!id) throw new Error("azure_smtp_accepted_without_receipt");
        return { messageId: `${idPrefix}${id}` };
      }
      return { messageId: `${idPrefix}${info.messageId ?? params.emailId}` };
    },
  };
}

/** Accept exactly one ACS UUID from the successful SMTP DATA response, not MIME headers. */
export function azureSmtpReceipt(response: string | undefined): string | null {
  if (!response || !/^250[ -]/.test(response)) return null;
  const ids = response.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi);
  return ids?.length === 1 ? (ids[0]?.toLowerCase() ?? null) : null;
}
