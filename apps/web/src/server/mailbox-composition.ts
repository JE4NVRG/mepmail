import { createHash } from "node:crypto";
import type { ParsedMail } from "mailparser";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function mailboxPayloadSha256(input: {
  from: string;
  recipient: string;
  subject: string;
  text: string;
}) {
  return sha256(
    JSON.stringify({
      from: input.from.trim().toLowerCase(),
      recipient: input.recipient.trim().toLowerCase(),
      subject: input.subject,
      text: input.text.replace(/\r\n/g, "\n"),
    }),
  );
}

/** Full semantic MIME equality, not a body prefix. MIME multipart boundaries
 * are framing, not content. All other headers (including duplicates), exact
 * parsed plaintext/HTML and attachment bytes/metadata participate. */
export function mailboxCompositionSemantics(mime: ParsedMail) {
  const headers = mime.headerLines
    .filter((h) => !["date", "message-id"].includes(h.key))
    .map((h) => [
      h.key,
      h.line
        .slice(h.line.indexOf(":") + 1)
        .replace(/\r?\n[ \t]+/g, " ")
        .trim()
        .replace(h.key === "content-type" ? /;\s*boundary=(?:"[^"]*"|[^;\s]*)/gi : /$^/g, ""),
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({
    headers,
    text: mime.text ?? null,
    html: mime.html,
    attachments: mime.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      contentDisposition: a.contentDisposition,
      cid: a.cid,
      headers: [...a.headers],
      content: a.content.toString("base64"),
    })),
  });
}

export function mailboxCompositionReceipt(
  input: {
    mailboxId: string;
    draftId: string;
    draftRevision: number;
    sourceItemId: string;
    from: string;
    recipient: string;
    subject: string;
    text: string;
  },
  mime: ParsedMail,
  raw: Buffer,
) {
  return {
    version: "mepmail-compose-v1" as const,
    mailboxId: input.mailboxId,
    draftId: input.draftId,
    draftRevision: input.draftRevision,
    sourceItemId: input.sourceItemId,
    submittedPayloadSha256: mailboxPayloadSha256(input),
    composedPayloadSha256: mailboxPayloadSha256({
      from: mime.from?.value[0]?.address ?? "",
      recipient: (Array.isArray(mime.to) ? mime.to[0] : mime.to)?.value[0]?.address ?? "",
      subject: mime.subject ?? "",
      text: mime.text ?? "",
    }),
    composedMimeSha256: sha256(raw),
  };
}
