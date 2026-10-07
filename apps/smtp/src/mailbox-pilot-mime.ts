import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { PilotMimeAdapter } from "../../../packages/core/src/mailbox-pilot.js";

// Existing locked MIME libraries. No SMTP connection: streamTransport captures
// the exact MIME bytes that a future qualified sender adapter must preserve.
export const mailboxPilotMime: PilotMimeAdapter = {
  async parse(raw) {
    const value = await simpleParser(raw, { skipImageLinks: true });
    const from = value.from?.value[0]?.address ?? "";
    return {
      messageId: value.messageId ?? "",
      subject: value.subject ?? "(sem assunto)",
      from,
      to: (Array.isArray(value.to) ? value.to : value.to ? [value.to] : [])
        .flatMap((item) => item.value)
        .map((item) => item.address)
        .filter((item): item is string => !!item),
      replyTo: value.replyTo?.value[0]?.address ?? from,
      text: value.text ?? "",
      references: [
        ...new Set([
          ...(Array.isArray(value.references)
            ? value.references
            : value.references
              ? [value.references]
              : []),
          ...(value.inReplyTo ? [value.inReplyTo] : []),
        ]),
      ],
      attachments: value.attachments.map((item) => ({
        filename: item.filename ?? "anexo",
        contentType: item.contentType,
        content: item.content,
        // Optional fields stay absent rather than undefined (exactOptionalPropertyTypes).
        ...(item.cid ? { cid: item.cid } : {}),
        ...(item.contentDisposition ? { disposition: item.contentDisposition } : {}),
      })),
    };
  },
  async compose(input) {
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "windows",
    });
    const result = await transport.sendMail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      attachments: input.attachments.map((item) => ({
        filename: item.filename,
        contentType: item.contentType,
        content: item.content,
        cid: item.cid,
        contentDisposition: item.disposition === "inline" ? "inline" : "attachment",
      })),
    });
    if (!Buffer.isBuffer(result.message)) throw new Error("MIME capture did not produce bytes");
    return result.message;
  },
};
