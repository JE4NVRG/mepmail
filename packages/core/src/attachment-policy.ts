/**
 * Uma caixa de e-mail sem anexo nao serve, mas "anexo" nao pode ser um canal
 * aberto. Esta policy e o unico lugar onde se decide o que passa: nome, tipo e
 * tamanho. O gate de conteudo chama isto em vez de recusar a mensagem inteira,
 * para que o remetente receba o motivo exato da recusa.
 */

export interface DispatchAttachmentMeta {
  filename: string;
  contentType: string;
  /** Bytes no fio (o conteudo decodificado). */
  size: number;
}

export type AttachmentRejection =
  | "attachment_too_large"
  | "attachment_type_blocked"
  | "attachment_name_blocked"
  | "attachment_structure_invalid";

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;
const ATTACHMENT_MAX_NAME_LENGTH = 180;

/**
 * O composer do Correio (web e app) envia os anexos em base64 dentro do JSON:
 * 16 MiB de arquivos viram ~21,4 MiB no fio, abaixo do teto de 25 MiB do proxy
 * e da mensagem MIME completa (o mesmo teto do que recebemos). O worker ainda
 * aplica os 20 MiB acima; este e o pedaco que cabe numa requisicao.
 */
export const COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** A mensagem montada pelo composer, anexos incluidos (igual ao teto de recebimento). */
export const COMPOSER_MIME_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Tipo declarado de um arquivo enviado pelo composer, a partir da extensao.
 * Declarar `application/octet-stream` faz o parser do worker adivinhar o tipo
 * pela extensao e recusar a divergencia; aqui o tipo ja sai certo e dentro da
 * allowlist. `null` = extensao fora da allowlist (recusar antes de enviar).
 */
const COMPOSER_EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  json: "application/json",
  xml: "application/xml",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  heic: "image/heic",
  avif: "image/avif",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  ics: "text/calendar",
  vcf: "text/vcard",
};

export function composerAttachmentContentType(filename: string): string | null {
  if (attachmentFilenameBlocked(filename)) return null;
  return COMPOSER_EXTENSION_TYPES[extensionOf(filename)] ?? null;
}

/**
 * Allowlist, nunca denylist: um tipo desconhecido e recusado. `text/*` entra
 * pelo prefixo, o resto precisa estar aqui.
 */
const ALLOWED_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/tiff",
  "image/bmp",
  "image/heic",
  "image/avif",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/quicktime",
]);

/**
 * Extensoes que executam codigo, instalam software ou carregam macros. Vale
 * mesmo quando o content-type declarado e permitido: o tipo declarado mente.
 */
const BLOCKED_EXTENSIONS = new Set([
  "ade",
  "adp",
  "apk",
  "app",
  "asp",
  "aspx",
  "bas",
  "bat",
  "bin",
  "cab",
  "cmd",
  "com",
  "cpl",
  "csh",
  "dll",
  "dmg",
  "docm",
  "dotm",
  "exe",
  "gadget",
  "hta",
  "htc",
  "inf",
  "ins",
  "iso",
  "isp",
  "jar",
  "js",
  "jse",
  "ksh",
  "lnk",
  "mde",
  "mjs",
  "msc",
  "msi",
  "msp",
  "mst",
  "pif",
  "pl",
  "potm",
  "ppam",
  "pptm",
  "ps1",
  "ps1xml",
  "ps2",
  "ps2xml",
  "psc1",
  "psc2",
  "py",
  "pyc",
  "rb",
  "reg",
  "scf",
  "scr",
  "sh",
  "shb",
  "shs",
  "url",
  "vb",
  "vbe",
  "vbs",
  "vhd",
  "vhdx",
  "vxd",
  "wsc",
  "wsf",
  "wsh",
  "xlam",
  "xlsm",
  "xltm",
  "xnk",
  "zsh",
]);

const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Bidi overrides (o nome exibido mente sobre o real), controles e separadores de
 * caminho. Comparacao por code point: uma classe de regex com controles crus
 * quebra o linter e e facil de ler errado.
 */
function hasHiddenOrSeparatingCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (character === "/" || character === "\\") return true;
  }
  return false;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function attachmentFilenameBlocked(filename: string): boolean {
  if (!filename.trim() || filename.length > ATTACHMENT_MAX_NAME_LENGTH) return true;
  if (hasHiddenOrSeparatingCharacter(filename)) return true;
  // Windows descarta ponto/espaco no fim: "nota.pdf " vira "nota.pdf" sem aviso.
  if (/[. ]$/.test(filename)) return true;
  if (filename.includes("..")) return true;
  // ".exe" escondido atras de uma extensao inocente aparece em qualquer posicao.
  const segments = filename.toLowerCase().split(".");
  if (segments.slice(1, -1).some((segment) => BLOCKED_EXTENSIONS.has(segment))) return true;
  return BLOCKED_EXTENSIONS.has(extensionOf(filename));
}

export function attachmentTypeAllowed(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (!MEDIA_TYPE_RE.test(type)) return false;
  if (type.startsWith("text/")) return true;
  return ALLOWED_MEDIA_TYPES.has(type);
}

/** Um anexo, isolado. O chamador decide se para tudo; aqui so se diz o motivo. */
export function validateDispatchAttachment(
  attachment: DispatchAttachmentMeta,
): { ok: true } | { ok: false; detail: AttachmentRejection } {
  if (
    !Number.isFinite(attachment.size) ||
    attachment.size < 0 ||
    attachment.size > ATTACHMENT_MAX_BYTES
  )
    return { ok: false, detail: "attachment_too_large" };
  if (attachmentFilenameBlocked(attachment.filename))
    return { ok: false, detail: "attachment_name_blocked" };
  if (!attachmentTypeAllowed(attachment.contentType))
    return { ok: false, detail: "attachment_type_blocked" };
  return { ok: true };
}

/** A lista inteira: primeiro o conjunto (quantidade/total), depois cada item. */
export function validateDispatchAttachments(
  attachments: readonly DispatchAttachmentMeta[],
): { ok: true } | { ok: false; detail: AttachmentRejection } {
  if (attachments.length === 0) return { ok: true };
  if (attachments.length > ATTACHMENT_MAX_COUNT)
    return { ok: false, detail: "attachment_too_large" };
  const total = attachments.reduce((sum, a) => sum + (Number.isFinite(a.size) ? a.size : 0), 0);
  if (total > ATTACHMENT_MAX_TOTAL_BYTES) return { ok: false, detail: "attachment_too_large" };
  for (const attachment of attachments) {
    const result = validateDispatchAttachment(attachment);
    if (!result.ok) return result;
  }
  return { ok: true };
}
