import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES,
  composerAttachmentContentType,
} from "@millionsend/core/attachment-policy";

/** What the composer can tell before reading a file (mirrors mailbox-content). */
export type ComposerFileProblem = "count" | "size" | "type";

export interface ComposerFileMeta {
  name: string;
  size: number;
}

/** Bytes a padded base64 string decodes to. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, (base64.length / 4) * 3 - padding);
}

/** A received attachment the composer can carry forward as is. */
export function composerCanCarry(attachment: { bytes: number; filename: string }): boolean {
  return (
    attachment.bytes > 0 &&
    attachment.bytes <= ATTACHMENT_MAX_BYTES &&
    composerAttachmentContentType(attachment.filename) !== null
  );
}

/** Splits carried attachments into what fits the composer and what stays behind. */
export function carryForwardSelection(
  attachments: readonly { index: number; filename: string; bytes: number }[],
): { keep: number[]; skip: string[] } {
  const keep: number[] = [];
  const skip: string[] = [];
  let bytes = 0;
  for (const attachment of attachments) {
    if (
      keep.length < ATTACHMENT_MAX_COUNT &&
      composerCanCarry(attachment) &&
      bytes + attachment.bytes <= COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES
    ) {
      keep.push(attachment.index);
      bytes += attachment.bytes;
    } else {
      skip.push(attachment.filename);
    }
  }
  return { keep, skip };
}

export function composerFileProblem(
  current: { count: number; bytes: number },
  files: readonly ComposerFileMeta[],
): ComposerFileProblem | null {
  if (current.count + files.length > ATTACHMENT_MAX_COUNT) return "count";
  if (files.some((f) => !composerAttachmentContentType(f.name))) return "type";
  if (files.some((f) => !f.size || f.size > ATTACHMENT_MAX_BYTES)) return "size";
  const total = files.reduce((sum, f) => sum + f.size, current.bytes);
  if (total > COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES) return "size";
  return null;
}

const PASTE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Clipboard images arrive as "image.png" (or nameless): give each a dated,
 * distinct name so two pasted screenshots don't look like the same file.
 */
export function pastedFileName(file: { name: string; type: string }, now: Date, index = 0): string {
  const extension = PASTE_EXTENSIONS[file.type];
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  if (!extension || !generic) return file.name;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `screenshot-${stamp}${index ? `-${index + 1}` : ""}.${extension}`;
}

/**
 * A paste is taken as attachments only when it carries files and no text: a
 * screenshot or a copied image. Word and Excel put a picture of the selection
 * next to its text; that paste stays text.
 */
export function clipboardAttachments(data: {
  files: ArrayLike<File> | null | undefined;
  getData(type: string): string;
}): File[] {
  const files = data.files ? Array.from(data.files) : [];
  if (!files.length) return [];
  if (data.getData("text/plain").trim()) return [];
  return files;
}
