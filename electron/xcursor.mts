// The XCursor file format: what a cursor theme's cursors/ directory holds,
// one file per cursor. A file is a table of chunks; each image chunk is one
// frame at one nominal size, with its hotspot and, when animated, how long
// it shows. Pixels are premultiplied ARGB, one little-endian word each,
// which in memory is BGRA: the same layout Electron's nativeImage.toBitmap()
// gives on this platform.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

const MAGIC = 'Xcur';
const FILE_HEADER = 16;
const TOC_ENTRY = 12;
const IMAGE_HEADER = 36;
export const XCURSOR_IMAGE = 0xfffd0002;

/** libXcursor refuses anything larger. */
const MAX_DIMENSION = 0x7fff;
/** No real cursor has more frames and sizes than this. */
const MAX_CHUNKS = 4096;

/** One frame, ready to write. */
export interface XcursorFrame {
  /** Nominal size: the size a theme user asks for to get this image. */
  size: number;
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  /** Milliseconds until the next frame; 0 when not animated. */
  delay: number;
  /** Premultiplied BGRA, width * height * 4 bytes. */
  pixels: Buffer;
}

/** An XCursor file holding `frames`, in order (one animation per nominal size). */
export function encodeXcursor(frames: XcursorFrame[]): Buffer {
  const tocEnd = FILE_HEADER + frames.length * TOC_ENTRY;
  const total = frames.reduce((sum, f) => sum + IMAGE_HEADER + f.pixels.length, tocEnd);
  const out = Buffer.alloc(total);
  out.write(MAGIC, 0, 'latin1');
  out.writeUInt32LE(FILE_HEADER, 4);
  out.writeUInt32LE(0x10000, 8);
  out.writeUInt32LE(frames.length, 12);
  let position = tocEnd;
  frames.forEach((frame, i) => {
    const toc = FILE_HEADER + i * TOC_ENTRY;
    out.writeUInt32LE(XCURSOR_IMAGE, toc);
    out.writeUInt32LE(frame.size, toc + 4);
    out.writeUInt32LE(position, toc + 8);
    out.writeUInt32LE(IMAGE_HEADER, position);
    out.writeUInt32LE(XCURSOR_IMAGE, position + 4);
    out.writeUInt32LE(frame.size, position + 8);
    out.writeUInt32LE(1, position + 12);
    out.writeUInt32LE(frame.width, position + 16);
    out.writeUInt32LE(frame.height, position + 20);
    out.writeUInt32LE(Math.min(frame.hotX, frame.width - 1), position + 24);
    out.writeUInt32LE(Math.min(frame.hotY, frame.height - 1), position + 28);
    out.writeUInt32LE(frame.delay, position + 32);
    frame.pixels.copy(out, position + IMAGE_HEADER);
    position += IMAGE_HEADER + frame.pixels.length;
  });
  return out;
}

/** An image chunk's place in a file. */
interface ImageEntry {
  size: number;
  position: number;
}

/**
 * The image chunks of an XCursor file, or null if it isn't one or any of
 * them doesn't fit in the file.
 */
function imageEntries(data: Buffer): ImageEntry[] | null {
  if (data.length < FILE_HEADER || data.toString('latin1', 0, 4) !== MAGIC) return null;
  const headerSize = data.readUInt32LE(4);
  const count = data.readUInt32LE(12);
  if (headerSize < FILE_HEADER || count > MAX_CHUNKS) return null;
  if (headerSize + count * TOC_ENTRY > data.length) return null;
  const entries: ImageEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entry = headerSize + i * TOC_ENTRY;
    if (data.readUInt32LE(entry) !== XCURSOR_IMAGE) continue;
    const size = data.readUInt32LE(entry + 4);
    const position = data.readUInt32LE(entry + 8);
    if (position + IMAGE_HEADER > data.length) return null;
    const width = data.readUInt32LE(position + 16);
    const height = data.readUInt32LE(position + 20);
    if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
    if (position + IMAGE_HEADER + width * height * 4 > data.length) return null;
    entries.push({ size, position });
  }
  return entries;
}

/** Whether `data` is a well-formed XCursor file with at least one image. */
export function isXcursor(data: Buffer): boolean {
  return (imageEntries(data)?.length ?? 0) > 0;
}

/** The distinct nominal sizes an XCursor file has images at. */
export function xcursorSizes(data: Buffer): number[] {
  return [...new Set((imageEntries(data) ?? []).map((e) => e.size))].sort((a, b) => a - b);
}

/** The first image of an XCursor file nearest `want` in nominal size, as straight RGBA. */
export function decodeXcursor(
  data: Buffer,
  want: number,
): { width: number; height: number; rgba: Uint8Array } | null {
  let best: ImageEntry | null = null;
  for (const entry of imageEntries(data) ?? []) {
    if (!best || Math.abs(entry.size - want) < Math.abs(best.size - want)) best = entry;
  }
  if (!best) return null;
  const width = data.readUInt32LE(best.position + 16);
  const height = data.readUInt32LE(best.position + 20);
  if (width > 512 || height > 512) return null;
  const pixels = best.position + IMAGE_HEADER;

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const argb = data.readUInt32LE(pixels + i * 4);
    const a = argb >>> 24;
    const unpremultiply = (c: number) => (a === 0 ? 0 : Math.min(255, Math.round((c * 255) / a)));
    rgba[i * 4] = unpremultiply((argb >>> 16) & 0xff);
    rgba[i * 4 + 1] = unpremultiply((argb >>> 8) & 0xff);
    rgba[i * 4 + 2] = unpremultiply(argb & 0xff);
    rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}
