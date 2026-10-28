/**
 * Shared ground for the cursor converter: its errors, its limits, the budget
 * every import draws on, bounds-checked reads, and capped decompression.
 *
 * Everything the converter reads is untrusted: any offset or length in it may
 * point anywhere, and any size in it may lie. Reads go through `need()`, which
 * throws rather than read past the end, and anything that grows (expanded
 * bytes, archive entries, decoded pixels, output) is charged to a `Budget`
 * before it's done, so no input can make the converter run away.
 */

/** A failure to tell the user about; its message is shown as is. */
export class ImportError extends Error {}

export const DAMAGED = 'The file is damaged or not in a format Din can read.';
export const TOO_BIG = 'That is too big to be a cursor theme.';

const MiB = 1024 * 1024;

export const LIMITS = {
  /** Bytes an import may expand to, across every archive and stream in it. */
  expandedBytes: 128 * MiB,
  /** Files and links an import may hold. */
  entries: 20_000,
  /** Pixels decoded across an import, every image counted. */
  decodedPixels: 100_000_000,
  /** Pixels one source image may have. */
  imagePixels: 32_000_000,
  /** Width or height a source image may have (frames side by side are long). */
  imageDimension: 16_384,
  /** Width or height of a cursor frame, as written. */
  frameDimension: 512,
  /** Frames one cursor's animation may have, at one size. */
  framesPerCursor: 256,
  /** Bytes of cursor images an import may produce. */
  outputBytes: 256 * MiB,
  /** How deep anything nested (plist, RIFF lists, scripts) may go. */
  depth: 32,
  /** Themes one import may hold. */
  themes: 16,
} as const;

/** What one import has used so far; throws once anything is over its limit. */
export class Budget {
  private bytes = 0;
  private entries = 0;
  private pixels = 0;
  private output = 0;

  /** An entry of `size` bytes, before it's expanded. */
  entry(size: number): void {
    this.bytes += size;
    this.entries++;
    if (this.bytes > LIMITS.expandedBytes || this.entries > LIMITS.entries) throw new ImportError(TOO_BIG);
  }

  /** Bytes expanded from a stream that isn't an archive entry. */
  expanded(size: number): void {
    this.bytes += size;
    if (this.bytes > LIMITS.expandedBytes) throw new ImportError(TOO_BIG);
  }

  /** An image of `width` × `height` about to be decoded or made. */
  image(width: number, height: number): void {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > LIMITS.imageDimension ||
      height > LIMITS.imageDimension ||
      width * height > LIMITS.imagePixels
    ) {
      throw new ImportError(TOO_BIG);
    }
    this.pixels += width * height;
    if (this.pixels > LIMITS.decodedPixels) throw new ImportError(TOO_BIG);
  }

  /** A cursor frame of `bytes` about to be kept. */
  frame(bytes: number): void {
    this.output += bytes;
    if (this.output > LIMITS.outputBytes) throw new ImportError(TOO_BIG);
  }
}

/** Throw unless `length` bytes from `offset` lie within `data`. */
export function need(data: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > data.length
  ) {
    throw new ImportError(DAMAGED);
  }
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function u16le(data: Uint8Array, offset: number): number {
  need(data, offset, 2);
  return view(data).getUint16(offset, true);
}

export function u32le(data: Uint8Array, offset: number): number {
  need(data, offset, 4);
  return view(data).getUint32(offset, true);
}

export function i32le(data: Uint8Array, offset: number): number {
  need(data, offset, 4);
  return view(data).getInt32(offset, true);
}

export function u16be(data: Uint8Array, offset: number): number {
  need(data, offset, 2);
  return view(data).getUint16(offset, false);
}

export function u32be(data: Uint8Array, offset: number): number {
  need(data, offset, 4);
  return view(data).getUint32(offset, false);
}

/** `length` bytes from `offset`, as a view (not a copy). */
export function slice(data: Uint8Array, offset: number, length: number): Uint8Array {
  need(data, offset, length);
  return data.subarray(offset, offset + length);
}

const decoders = new Map<string, TextDecoder>();

/** Bytes as text in `encoding` (malformed bytes become U+FFFD). */
export function text(data: Uint8Array, encoding: 'utf-8' | 'utf-16le' | 'latin1' = 'utf-8'): string {
  let decoder = decoders.get(encoding);
  if (!decoder) {
    decoder = new TextDecoder(encoding);
    decoders.set(encoding, decoder);
  }
  return decoder.decode(data);
}

/** Whether `data` starts with `bytes`. */
export function startsWith(data: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  return data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b);
}

export function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}

/**
 * Decompress `data` (`deflate` is zlib-wrapped, `deflate-raw` bare, `gzip`
 * gzip), stopping as soon as the output passes `limit` bytes, so a stream that
 * expands without end costs no more than the limit.
 */
export async function inflate(
  data: Uint8Array,
  format: 'deflate' | 'deflate-raw' | 'gzip',
  limit: number,
): Promise<Uint8Array> {
  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  // Not awaited: the stream only takes more input as its output is read.
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new ImportError(TOO_BIG);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof ImportError) throw error;
    throw new ImportError(DAMAGED);
  }
  return concat(chunks, total);
}

/** An integer from untrusted text, or `fallback`. */
export function toInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** `n` clamped into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
