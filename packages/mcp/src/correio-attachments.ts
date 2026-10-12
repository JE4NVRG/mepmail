import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

/**
 * Attachments for the Correio tools, with the server's own limits so the agent gets a
 * precise reason before a request is refused: at most 10 files per message, 256 KiB
 * each, and the whole message within 1 MiB once encoded. Bytes reach the server only
 * inside a draft request; nothing is uploaded on its own, so nothing is left behind
 * when a draft is abandoned. Local paths are read only from the folder the person
 * configured (MEPMAIL_MAIL_UPLOAD_DIR), never from anywhere a message suggests.
 */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
/** Encoded attachments must leave room for the text and headers inside 1 MiB. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 700 * 1024;
/** Largest attachment returned inline (base64) to the model when no download folder is set. */
export const INLINE_ATTACHMENT_BYTES = 512 * 1024;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class AttachmentError extends Error {}

export interface NewAttachment {
  filename?: string | undefined;
  content_base64?: string | undefined;
  path?: string | undefined;
}

export interface SourceAttachment {
  index: number;
  filename: string;
  bytes: number;
}

const kib = (n: number) => `${Math.ceil(n / 1024)} KiB`;

/** A file name safe to keep: no path, no control characters, at most 160 characters. */
export function cleanFilename(name: string): string {
  const base = [...basename(name.replace(/\\/g, "/"))]
    .map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? "_" : char))
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 160);
  return base || "attachment";
}

/** A file inside the configured upload folder (symlinks resolved), as bytes. */
export async function readUploadFile(uploadDir: string | undefined, path: string) {
  if (!uploadDir)
    throw new AttachmentError(
      "Reading local files is off: set MEPMAIL_MAIL_UPLOAD_DIR to the folder the agent may attach files from, or pass content_base64.",
    );
  const root = await realpath(uploadDir).catch(() => {
    throw new AttachmentError("MEPMAIL_MAIL_UPLOAD_DIR does not exist.");
  });
  const target = await realpath(resolve(root, path)).catch(() => {
    throw new AttachmentError(`File not found in the upload folder: ${basename(path)}`);
  });
  if (target !== root && !target.startsWith(root + sep))
    throw new AttachmentError("Only files inside MEPMAIL_MAIL_UPLOAD_DIR can be attached.");
  const info = await lstat(target);
  if (!info.isFile()) throw new AttachmentError(`Not a file: ${basename(path)}`);
  if (info.size > MAX_ATTACHMENT_BYTES)
    throw new AttachmentError(
      `${basename(path)} is ${kib(info.size)}; each attachment can be at most 256 KiB.`,
    );
  return { filename: cleanFilename(basename(target)), content: await readFile(target) };
}

/**
 * What a draft request carries: the source's attachments to keep (by index) and the
 * new files as base64, checked against the limits with a reason the agent can act on.
 */
export async function planDraftAttachments(input: {
  keep: number[];
  source: SourceAttachment[];
  attachments: NewAttachment[];
  uploadDir?: string | undefined;
}): Promise<{ retainedAttachments: number[]; uploads: { filename: string; base64: string }[] }> {
  const keep = [...new Set(input.keep)];
  if (keep.length !== input.keep.length)
    throw new AttachmentError("keep_attachments repeats an index.");
  let total = 0;
  for (const index of keep) {
    const found = input.source.find((a) => a.index === index);
    if (!found)
      throw new AttachmentError(
        `keep_attachments: no attachment ${index} in the source message (read it with mailbox_read_message).`,
      );
    if (found.bytes > MAX_ATTACHMENT_BYTES)
      throw new AttachmentError(
        `Attachment ${index} (${found.filename}) is ${kib(found.bytes)}; a message can carry at most 256 KiB per file. Leave it out of keep_attachments.`,
      );
    total += found.bytes;
  }
  const uploads: { filename: string; base64: string }[] = [];
  for (const file of input.attachments) {
    if (file.path !== undefined && file.content_base64 !== undefined)
      throw new AttachmentError("Give each attachment either path or content_base64, not both.");
    let filename: string;
    let content: Buffer;
    if (file.path !== undefined) {
      ({ filename, content } = await readUploadFile(input.uploadDir, file.path));
      if (file.filename) filename = cleanFilename(file.filename);
    } else {
      const base64 = (file.content_base64 ?? "").replace(/\s+/g, "");
      if (!base64 || !BASE64.test(base64))
        throw new AttachmentError(
          `${file.filename ?? "An attachment"}: content_base64 is not valid base64.`,
        );
      if (!file.filename)
        throw new AttachmentError("An attachment given as content_base64 needs a filename.");
      filename = cleanFilename(file.filename);
      content = Buffer.from(base64, "base64");
    }
    if (!content.length) throw new AttachmentError(`${filename} is empty.`);
    if (content.length > MAX_ATTACHMENT_BYTES)
      throw new AttachmentError(
        `${filename} is ${kib(content.length)}; each attachment can be at most 256 KiB.`,
      );
    total += content.length;
    uploads.push({ filename, base64: content.toString("base64") });
  }
  if (keep.length + uploads.length > MAX_ATTACHMENTS)
    throw new AttachmentError(`A message can carry at most ${MAX_ATTACHMENTS} attachments.`);
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES)
    throw new AttachmentError(
      `The attachments add up to ${kib(total)}; a message fits about 700 KiB of attachments (1 MiB encoded).`,
    );
  return { retainedAttachments: keep, uploads };
}

/** The attachment's name from the download's Content-Disposition (filename*=UTF-8''…). */
export function attachmentFilename(disposition: string | null): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "");
  if (star) {
    try {
      return cleanFilename(decodeURIComponent(star[1]!));
    } catch {
      // fall through to the plain name
    }
  }
  const plain = /filename="([^"]*)"/i.exec(disposition ?? "");
  return cleanFilename(plain?.[1] ?? "attachment");
}

/** Writes bytes into the download folder under a fresh name (never overwrites). */
export async function saveDownload(dir: string, filename: string, bytes: Uint8Array) {
  const root = await realpath(dir).catch(() => {
    throw new AttachmentError("MEPMAIL_MAIL_DOWNLOAD_DIR does not exist.");
  });
  const name = cleanFilename(filename);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 0; n < 1000; n++) {
    const path = join(root, n ? `${stem} (${n})${ext}` : name);
    const handle = await open(path, "wx").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return null;
      throw error;
    });
    if (!handle) continue;
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return path;
  }
  throw new AttachmentError("Too many files with this name in the download folder.");
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
