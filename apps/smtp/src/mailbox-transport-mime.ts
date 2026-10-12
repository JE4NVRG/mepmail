import { MailboxContentError, type MailboxTransportMimeAdapter } from "@millionsend/core";
import { simpleParser } from "mailparser";

/**
 * The send admission's MIME reading, as the web's (apps/web/src/server/mailbox-transport.ts):
 * one From, and every To, Cc and Bcc address. Delivery uses exactly these.
 */
export const mailboxSubmissionMime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    if (
      parsed.headerLines.filter((line) => line.key === "from").length !== 1 ||
      parsed.from?.value.length !== 1 ||
      !parsed.from.value[0]?.address
    )
      throw new MailboxContentError("invalid");
    const addresses = (value: typeof parsed.to) =>
      (Array.isArray(value) ? value : value ? [value] : [])
        .flatMap((v) => v.value)
        .map((v) => v.address)
        .filter((v): v is string => !!v);
    return {
      from: parsed.from.value[0].address,
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      bcc: addresses(parsed.bcc),
      attachmentBytes: parsed.attachments.map((a) => a.content.length),
    };
  },
};
