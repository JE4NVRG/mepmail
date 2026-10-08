/** Formats accepted for team logos. SVG is deliberately excluded: it can carry
 * scripts, and logos are served from the public storage bucket. */
export type LogoImageType = "png" | "jpeg" | "webp";

export const TEAM_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const TEAM_LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

/** Signature logos travel inside every email: kept small, and never WebP
 * (Outlook desktop does not render it). The browser re-encodes to PNG first. */
export const SIGNATURE_LOGO_MAX_BYTES = 512 * 1024;
export const SIGNATURE_LOGO_ACCEPT = "image/png,image/jpeg";

/** Pixel size from a PNG IHDR or a JPEG SOF marker; null when not found. */
export function imagePixelSize(
  bytes: Uint8Array,
  type: LogoImageType,
): { width: number; height: number } | null {
  const u16 = (at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
  const u32 = (at: number) => u16(at) * 65536 + u16(at + 2);
  if (type === "png") {
    const width = u32(16);
    const height = u32(20);
    return width && height ? { width, height } : null;
  }
  if (type !== "jpeg") return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = u16(at + 5);
      const width = u16(at + 7);
      return width && height ? { width, height } : null;
    }
    at += 2 + u16(at + 2);
  }
  return null;
}

/**
 * Identifies the image format from magic bytes — the client-supplied
 * Content-Type is never trusted. Returns null for anything else.
 */
export function sniffImageType(bytes: Uint8Array): LogoImageType | null {
  const ascii = (start: number, text: string) =>
    [...text].every((ch, i) => bytes[start + i] === ch.charCodeAt(0));
  if (
    bytes[0] === 0x89 &&
    ascii(1, "PNG") &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  return null;
}
