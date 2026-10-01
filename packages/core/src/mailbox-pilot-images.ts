// Bounded local raster previews. MIME labels and extensions are untrusted.
// SVG/HTML and remote URLs are never rendered by this qualification adapter.
export function pilotImageMetadata(content: Buffer) {
  if (content.length < 16 || content.length > 256 * 1024) return null;
  let contentType: string;
  let width = 0;
  let height = 0;
  if (
    content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    content.length >= 45 &&
    content.readUInt32BE(8) === 13 &&
    content.toString("ascii", 12, 16) === "IHDR" &&
    content.toString("ascii", content.length - 8, content.length - 4) === "IEND"
  ) {
    contentType = "image/png";
    width = content.readUInt32BE(16);
    height = content.readUInt32BE(20);
  } else if (
    ["GIF87a", "GIF89a"].includes(content.toString("ascii", 0, 6)) &&
    content[content.length - 1] === 0x3b
  ) {
    contentType = "image/gif";
    width = content.readUInt16LE(6);
    height = content.readUInt16LE(8);
  } else if (
    content.toString("ascii", 0, 4) === "RIFF" &&
    content.readUInt32LE(4) + 8 === content.length &&
    content.toString("ascii", 8, 12) === "WEBP" &&
    content.length >= 30
  ) {
    contentType = "image/webp";
    const chunk = content.toString("ascii", 12, 16);
    if (chunk === "VP8X" && content.readUInt32LE(16) === 10) {
      width = content.readUIntLE(24, 3) + 1;
      height = content.readUIntLE(27, 3) + 1;
    } else if (chunk === "VP8L" && content[20] === 0x2f) {
      const bits = content.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (
      chunk === "VP8 " &&
      content.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      width = content.readUInt16LE(26) & 0x3fff;
      height = content.readUInt16LE(28) & 0x3fff;
    }
  } else if (
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[content.length - 2] === 0xff &&
    content[content.length - 1] === 0xd9
  ) {
    contentType = "image/jpeg";
    let offset = 2;
    while (offset + 4 <= content.length && content[offset] === 0xff) {
      const marker = content[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xff) {
        offset++;
        continue;
      }
      const length = content.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > content.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 8
      ) {
        height = content.readUInt16BE(offset + 5);
        width = content.readUInt16BE(offset + 7);
        break;
      }
      offset += 2 + length;
    }
  } else return null;
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024)
    return null;
  return { contentType, width, height };
}
