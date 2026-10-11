/**
 * Headers that stay on the sealed copy (the draft, the outbox snapshot and the sender's
 * own Sent copy) and never leave with the message: Bcc, whose people travel only in the
 * envelope, and the composer's format marker. Removed from the top-level header block,
 * folded continuation lines included; every other byte is kept as it was.
 */
const PRIVATE_HEADERS = new Set(["bcc", "x-mepmail-format"]);

/** The composer's marker on a draft whose HTML part is the person's own formatting. */
export const MAILBOX_RICH_FORMAT_HEADER = "X-MepMail-Format";

export function stripMailboxPrivateHeaders(raw: Buffer): Buffer {
  // latin1 maps bytes one to one, so the body and any 8-bit header survive untouched.
  const text = raw.toString("latin1");
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  const [cut, gap] =
    crlf !== -1 && (lf === -1 || crlf < lf) ? [crlf, 2] : lf !== -1 ? [lf, 1] : [-1, 0];
  const headEnd = cut === -1 ? text.length : cut + gap;
  const head = text.slice(0, headEnd);
  const lines = head.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let dropping = false;
  let removed = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (!/^[ \t]/.test(line)) {
      const colon = line.indexOf(":");
      dropping = colon > 0 && PRIVATE_HEADERS.has(line.slice(0, colon).trim().toLowerCase());
    }
    if (dropping) removed = true;
    else kept.push(line);
  }
  if (!removed) return raw;
  return Buffer.from(kept.join("") + text.slice(headEnd), "latin1");
}
