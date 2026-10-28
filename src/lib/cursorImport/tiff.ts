/**
 * TIFF, as much of it as older Mousecape capes hold: one 8-bit RGB(A)
 * image, chunky, in strips, uncompressed or LZW / PackBits / Deflate
 * compressed, with or without the horizontal predictor. Every strip is
 * decoded into a buffer the size the image's header says it must have, and
 * no decoder can write past it.
 */

import { Budget, DAMAGED, ImportError, inflate, need, startsWith, u16be, u16le, u32be, u32le } from './bytes';
import type { Bitmap } from './image';

export function isTiff(data: Uint8Array): boolean {
  return startsWith(data, [0x4d, 0x4d, 0x00, 0x2a]) || startsWith(data, [0x49, 0x49, 0x2a, 0x00]);
}

/** Decode LZW (TIFF's flavor: MSB first, early change) into `out`; returns the bytes written. */
export function lzwDecode(input: Uint8Array, out: Uint8Array): number {
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
  }
  let next = 258;
  let width = 9;
  let previous = -1;
  let written = 0;
  let bitPosition = 0;
  const totalBits = input.length * 8;
  const stack = new Uint8Array(4096);

  while (bitPosition + width <= totalBits && written < out.length) {
    let code = 0;
    for (let i = 0; i < width; i++, bitPosition++) {
      code = (code << 1) | ((input[bitPosition >> 3] >> (7 - (bitPosition & 7))) & 1);
    }
    if (code === 257) break;
    if (code === 256) {
      next = 258;
      width = 9;
      previous = -1;
      continue;
    }
    let entry: number;
    if (code < next) entry = code;
    else if (code === next && previous >= 0) entry = previous;
    else throw new ImportError(DAMAGED);

    // Unwind the entry's string, back to front.
    let depth = 0;
    let first = 0;
    for (let c = entry; c >= 0; c = prefix[c]) {
      first = suffix[c];
      stack[depth++] = first;
      if (depth > 4096) throw new ImportError(DAMAGED);
    }
    if (code === next) {
      // KwKwK: the previous string plus its own first character.
      for (let i = depth - 1; i >= 0 && written < out.length; i--) out[written++] = stack[i];
      if (written < out.length) out[written++] = first;
    } else {
      for (let i = depth - 1; i >= 0 && written < out.length; i--) out[written++] = stack[i];
    }
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      next++;
    }
    previous = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return written;
}

/** Decode PackBits into `out`; returns the bytes written. */
function packBitsDecode(input: Uint8Array, out: Uint8Array): number {
  let p = 0;
  let written = 0;
  while (p < input.length && written < out.length) {
    const n = (input[p++] << 24) >> 24;
    if (n >= 0) {
      for (let i = 0; i <= n && p < input.length && written < out.length; i++) out[written++] = input[p++];
    } else if (n !== -128) {
      const value = input[p++];
      for (let i = 0; i < 1 - n && written < out.length; i++) out[written++] = value;
    }
  }
  return written;
}

interface Entry {
  type: number;
  count: number;
  /** Where the values are: in the entry itself when they fit, else at an offset. */
  at: number;
}

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };

export async function decodeTiff(data: Uint8Array, budget: Budget): Promise<Bitmap> {
  if (!isTiff(data)) throw new ImportError(DAMAGED);
  const big = data[0] === 0x4d;
  const r16 = (o: number) => (big ? u16be(data, o) : u16le(data, o));
  const r32 = (o: number) => (big ? u32be(data, o) : u32le(data, o));

  const ifd = r32(4);
  const count = r16(ifd);
  if (count > 512) throw new ImportError(DAMAGED);
  const entries = new Map<number, Entry>();
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const type = r16(e + 2);
    const n = r32(e + 4);
    const size = (TYPE_SIZES[type] ?? 0) * n;
    entries.set(r16(e), { type, count: n, at: size <= 4 ? e + 8 : r32(e + 8) });
  }
  const values = (tag: number): number[] => {
    const entry = entries.get(tag);
    if (!entry) return [];
    if (entry.count > 65_536) throw new ImportError(DAMAGED);
    const size = TYPE_SIZES[entry.type];
    if (!size || entry.type === 2 || entry.type === 7) throw new ImportError(DAMAGED);
    need(data, entry.at, size * entry.count);
    return Array.from({ length: entry.count }, (_, i) =>
      size === 1 ? data[entry.at + i] : size === 2 ? r16(entry.at + i * 2) : r32(entry.at + i * 4),
    );
  };
  const one = (tag: number, fallback: number) => values(tag)[0] ?? fallback;

  const width = one(256, 0);
  const height = one(257, 0);
  const bitsPerSample = values(258);
  const compression = one(259, 1);
  const samples = one(277, 1);
  const rowsPerStrip = Math.min(one(278, height), height) || height;
  const planar = one(284, 1);
  const predictor = one(317, 1);
  const extra = values(338);
  const offsets = values(273);
  const counts = values(279);

  if (samples !== 3 && samples !== 4) throw new ImportError(DAMAGED);
  if (bitsPerSample.some((b) => b !== 8) || planar !== 1 || ![1, 2].includes(predictor)) throw new ImportError(DAMAGED);
  budget.image(width, height);
  const strips = Math.ceil(height / rowsPerStrip);
  if (offsets.length !== strips || counts.length !== strips) throw new ImportError(DAMAGED);

  const rowBytes = width * samples;
  const raw = new Uint8Array(rowBytes * height);
  for (let s = 0; s < strips; s++) {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    const target = raw.subarray(s * rowsPerStrip * rowBytes, (s * rowsPerStrip + rows) * rowBytes);
    need(data, offsets[s], counts[s]);
    const input = data.subarray(offsets[s], offsets[s] + counts[s]);
    let written: number;
    if (compression === 1) {
      written = Math.min(input.length, target.length);
      target.set(input.subarray(0, written));
    } else if (compression === 5) {
      written = lzwDecode(input, target);
    } else if (compression === 32773) {
      written = packBitsDecode(input, target);
    } else if (compression === 8 || compression === 32946) {
      const inflated = await inflate(input, 'deflate', target.length);
      target.set(inflated);
      written = inflated.length;
    } else {
      throw new ImportError(DAMAGED);
    }
    if (written !== target.length) throw new ImportError(DAMAGED);
    if (predictor === 2) {
      for (let y = 0; y < rows; y++) {
        for (let x = samples; x < rowBytes; x++) target[y * rowBytes + x] += target[y * rowBytes + x - samples];
      }
    }
  }

  // Alpha is associated (premultiplied) when the extra sample says 1.
  const associated = samples === 4 && extra[0] === 1;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * samples;
    const a = samples === 4 ? raw[s + 3] : 255;
    const premultiply = (c: number) => (associated ? Math.min(c, a) : Math.round((c * a) / 255));
    pixels[i * 4] = premultiply(raw[s + 2]);
    pixels[i * 4 + 1] = premultiply(raw[s + 1]);
    pixels[i * 4 + 2] = premultiply(raw[s]);
    pixels[i * 4 + 3] = a;
  }
  return { width, height, pixels };
}
