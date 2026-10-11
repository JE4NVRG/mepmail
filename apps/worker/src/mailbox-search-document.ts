import type { MailboxSearchDocument } from "@millionsend/core";
import { type AddressObject, simpleParser } from "mailparser";

/** Address and display name of every entry of a header (To, Cc, Bcc, From). */
function people(value: AddressObject | AddressObject[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((entry) => entry.value)
    .flatMap((address) => [address.address ?? "", address.name ?? ""])
    .filter(Boolean);
}

/**
 * What the search index reads from one sealed message: subject, sender, recipients
 * (Bcc too, kept on the sender's own sent copy), the body as text (mailparser turns
 * HTML-only mail into text) and attachment names. Never stored as text.
 */
export async function readMailboxSearchDocument(raw: Buffer): Promise<MailboxSearchDocument> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  return {
    subject: parsed.subject ?? "",
    from: people(parsed.from),
    to: [...people(parsed.to), ...people(parsed.cc), ...people(parsed.bcc)],
    body: parsed.text ?? "",
    attachments: parsed.attachments.map((attachment) => attachment.filename ?? "").filter(Boolean),
  };
}
