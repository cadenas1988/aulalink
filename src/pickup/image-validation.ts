export type SupportedImageMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectImageMime(bytes: Buffer): SupportedImageMime | undefined {
  if (isPng(bytes)) return 'image/png';
  if (isJpeg(bytes)) return 'image/jpeg';
  if (isWebp(bytes)) return 'image/webp';
  return undefined;
}

function isJpeg(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

function isPng(bytes: Buffer): boolean {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return false;
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return false;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    width === 0 ||
    height === 0 ||
    width > 12000 ||
    height > 12000 ||
    width * height > 40_000_000
  ) {
    return false;
  }

  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString('ascii', offset + 4, offset + 8);
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset > bytes.length) return false;
    if (chunkType === 'IDAT') hasImageData = true;
    if (chunkType === 'IEND') {
      return chunkLength === 0 && hasImageData && nextOffset === bytes.length;
    }
    offset = nextOffset;
  }
  return false;
}

function isWebp(bytes: Buffer): boolean {
  if (
    bytes.length < 30 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP' ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  ) {
    return false;
  }
  const chunk = bytes.toString('ascii', 12, 16);
  return chunk === 'VP8 ' || chunk === 'VP8L' || chunk === 'VP8X';
}
