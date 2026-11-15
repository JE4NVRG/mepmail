import type { ParsedMail } from "mailparser";

export type MailboxDraftMessageFormat = "plain_text" | "formatted" | "unknown";

/** Classify stored MIME, never the editor projection or a parser's implicit text default. */
export function mailboxDraftMessageFormat(
  raw: Buffer,
  mime: ParsedMail,
): MailboxDraftMessageFormat {
  const source = raw.toString("latin1");
  const split = /\r?\n\r?\n/.exec(source);
  if (!split) return "unknown";
  const headers = source
    .slice(0, split.index)
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/);
  if (headers.some((line) => !/^[!-9;-~]+:[\t\x20-\x7e\x80-\xff]*$/.test(line))) return "unknown";
  const values = (name: string) =>
    headers
      .filter((line) => line.slice(0, line.indexOf(":")).toLowerCase() === name)
      .map((line) => line.slice(line.indexOf(":") + 1).trim());
  const types = values("content-type");
  if (types.length !== 1) return "unknown";
  // Refuse malformed/duplicate parameters instead of accepting mailparser's repair.
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const parameter = `${token}=(?:${token}|"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*")`;
  if (!new RegExp(`^${token}/${token}(?:\\s*;\\s*${parameter})*\\s*$`).test(types[0]!))
    return "unknown";
  const parameters = [...types[0]!.matchAll(/;\s*([^=;\s]+)=/g)].map((m) => m[1]!.toLowerCase());
  if (new Set(parameters).size !== parameters.length) return "unknown";
  const encoding = values("content-transfer-encoding");
  if (
    encoding.length > 1 ||
    (encoding[0] && !/^(7bit|8bit|binary|base64|quoted-printable)$/i.test(encoding[0]))
  )
    return "unknown";
  const contentType = mime.headers.get("content-type");
  if (
    !contentType ||
    typeof contentType !== "object" ||
    !("value" in contentType) ||
    typeof contentType.value !== "string"
  )
    return "unknown";
  const type = contentType.value.toLowerCase();
  if (type === "text/plain") {
    const params = "params" in contentType ? contentType.params : undefined;
    if (
      params &&
      Object.entries(params).some(
        ([name, value]) => name !== "charset" || !/^(utf-8|us-ascii)$/i.test(value),
      )
    )
      return "unknown";
    if (
      mime.attachments.length ||
      mime.html !== false ||
      typeof mime.text !== "string" ||
      values("content-disposition").some((v) => /^attachment\b/i.test(v))
    )
      return "unknown";
    if (mime.text.includes("\ufffd")) return "unknown";
    const body = source.slice(split.index + split[0].length);
    if (
      encoding[0]?.toLowerCase() === "base64" &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        body.replace(/\s/g, ""),
      )
    )
      return "unknown";
    if (encoding[0]?.toLowerCase() === "quoted-printable" && /=(?![0-9a-f]{2}|\r?\n)/i.test(body))
      return "unknown";
    return "plain_text";
  }
  if (type === "text/html") return typeof mime.html === "string" ? "formatted" : "unknown";
  if (!["multipart/mixed", "multipart/alternative", "multipart/related"].includes(type))
    return "unknown";
  const boundary = "params" in contentType ? contentType.params?.boundary : undefined;
  if (typeof boundary !== "string" || !boundary || boundary.length > 70) return "unknown";
  const lines = source.slice(split.index + split[0].length).split(/\r?\n/);
  const first = lines.indexOf(`--${boundary}`);
  const last = lines.indexOf(`--${boundary}--`);
  return first >= 0 &&
    last > first &&
    (typeof mime.html === "string" || typeof mime.text === "string" || mime.attachments.length > 0)
    ? "formatted"
    : "unknown";
}
