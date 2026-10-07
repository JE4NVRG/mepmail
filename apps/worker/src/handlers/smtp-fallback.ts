import { createTransport } from "nodemailer";
import type { SesSender } from "./send-email.js";

/**
 * The platform's own mail over an SMTP relay (SMTP_FALLBACK_URL, e.g.
 * smtps://user:pass@smtp.example.com:465) while SES has paused the account.
 * The MIME is the one built for SES, sent byte for byte; the envelope sender
 * is the relay's authenticated user, so SPF passes for the relay and DKIM is
 * the relay's own signature on the domain. The message id is prefixed so it
 * never collides with an SES id (no SES event will ever join on it).
 */
export function createSmtpFallback(url: string): SesSender {
  const parsed = new URL(url);
  const envelopeFrom = decodeURIComponent(parsed.username);
  if (!envelopeFrom.includes("@")) throw new Error("SMTP_FALLBACK_URL user must be a mailbox address");
  const transport = createTransport(url);
  return {
    async sendRaw(params) {
      const info = await transport.sendMail({
        envelope: {
          from: envelopeFrom,
          to: [...params.to, ...(params.cc ?? []), ...(params.bcc ?? [])],
        },
        raw: params.raw,
      });
      return { messageId: `smtp-fallback:${info.messageId ?? params.emailId}` };
    },
  };
}
