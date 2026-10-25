import { unzlibSync } from 'fflate';

/**
 * A small baseline TIFF reader, for InDesign's previews of linked graphics
 * (Chromium can't show TIFF). Strips or tiles; uncompressed, LZW, PackBits
 * or Deflate; horizontal differencing; 8 or 16 bits; gray, RGB, palette or
 * CMYK, with or without alpha. Enough for previews, not for every TIFF.
 */

export function decodeTiff(d: Uint8Array): ImageData {
  if (d.length < 8) throw new Error('The TIFF is cut short.');
  const le = d[0] === 0x49;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u16 = (o: number) => v.getUint16(o, le);
  const u32 = (o: number) => v.getUint32(o, le);
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = new Map<number, number[]>();
  const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    const type = u16(e + 2);
    const count = u32(e + 4);
    const size = (SIZES[type] ?? 1) * count;
    const at = size <= 4 ? e + 8 : u32(e + 8);
    const vals: number[] = [];
    const max = Math.min(count, tag === 320 ? 3 * 65536 : 1 << 20);
    for (let k = 0; k < max; k++) {
      if (type === 3 || type === 8) vals.push(u16(at + k * 2));
      else if (type === 4 || type === 9 || type === 16) vals.push(u32(at + k * (type === 16 ? 8 : 4)));
      else if (type === 1 || type === 2 || type === 6 || type === 7) vals.push(d[at + k]);
      else if (type === 5) vals.push(u32(at + k * 8) / (u32(at + k * 8 + 4) || 1));
    }
    tags.set(tag, vals);
  }
  const get = (t: number, dflt = 0) => tags.get(t)?.[0] ?? dflt;
  const w = get(256);
  const h = get(257);
  if (!w || !h || w * h > 64e6) throw new Error('The TIFF has no usable size.');
  const bps = get(258, 1);
  const comp = get(259, 1);
  const photo = get(262, 1);
  const spp = get(277, 1);
  const planar = get(284, 1);
  const predictor = get(317, 1);
  const extra = tags.get(338) ?? [];
  const map = tags.get(320);
  if (planar !== 1 && spp > 1) throw new Error('Planar TIFFs aren’t supported.');
  if (comp === 7 || comp === 6) throw new Error('JPEG-compressed TIFFs aren’t supported.');
  const bytesPerSample = bps === 16 ? 2 : 1;
  const tiled = tags.has(322);
  const tw = tiled ? get(322) : w;
  const th = tiled ? get(323) : get(278, h) || h;
  const offsets = tags.get(tiled ? 324 : 273) ?? [];
  const counts = tags.get(tiled ? 325 : 279) ?? [];
  const rowBytes = bps < 8 ? Math.ceil((tw * spp * bps) / 8) : tw * spp * bytesPerSample;
  const out = new ImageData(w, h);
  const px = out.data;
  const across = Math.ceil(w / tw);
  for (let s = 0; s < offsets.length; s++) {
    const raw = d.subarray(offsets[s], offsets[s] + (counts[s] ?? 0));
    let buf: Uint8Array;
    if (comp === 1) buf = raw;
    else if (comp === 5) buf = lzw(raw, rowBytes * th);
    else if (comp === 32773) buf = packbits(raw, rowBytes * th);
    else if (comp === 8 || comp === 32946) buf = unzlibSync(raw);
    else throw new Error('The TIFF’s compression isn’t supported.');
    const x0 = tiled ? (s % across) * tw : 0;
    const y0 = tiled ? Math.floor(s / across) * th : s * th;
    const rows = Math.min(th, h - y0);
    if (predictor === 2 && bps === 8) {
      for (let r = 0; r < rows; r++) {
        const o = r * rowBytes;
        for (let i = spp; i < tw * spp; i++) buf[o + i] = (buf[o + i] + buf[o + i - spp]) & 255;
      }
    }
    for (let r = 0; r < rows; r++) {
      const y = y0 + r;
      for (let c = 0; c < tw; c++) {
        const x = x0 + c;
        if (x >= w) break;
        const o = r * rowBytes + c * spp * bytesPerSample;
        const sample = (k: number) => (bps === 16 ? buf[o + k * 2 + (le ? 1 : 0)] : bps === 8 ? buf[o + k] : bitSample(buf, r * rowBytes, c * spp + k, bps));
        let R: number;
        let G: number;
        let B: number;
        let A = 255;
        if (photo === 2) {
          R = sample(0);
          G = sample(1);
          B = sample(2);
          if (spp > 3 && extra.length) A = sample(3);
        } else if (photo === 5) {
          const C = sample(0);
          const M = sample(1);
          const Y = sample(2);
          const K = sample(3);
          R = 255 - Math.min(255, C + K);
          G = 255 - Math.min(255, M + K);
          B = 255 - Math.min(255, Y + K);
          if (spp > 4 && extra.length) A = sample(4);
        } else if (photo === 3 && map) {
          const i = sample(0);
          const third = map.length / 3;
          R = map[i] >> 8;
          G = map[third + i] >> 8;
          B = map[2 * third + i] >> 8;
        } else {
          let g = sample(0);
          if (bps < 8) g = Math.round((g / ((1 << bps) - 1)) * 255);
          if (photo === 0) g = 255 - g;
          R = G = B = g;
          if (spp > 1 && extra.length) A = sample(1);
        }
        const p = (y * w + x) * 4;
        px[p] = R;
        px[p + 1] = G;
        px[p + 2] = B;
        px[p + 3] = A;
      }
    }
  }
  return out;
}

function bitSample(buf: Uint8Array, rowStart: number, index: number, bps: number): number {
  const bit = index * bps;
  const byte = buf[rowStart + (bit >> 3)] ?? 0;
  const shift = 8 - bps - (bit & 7);
  return (byte >> shift) & ((1 << bps) - 1);
}

function packbits(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) {
      for (let k = 0; k <= n && o < expected; k++) out[o++] = src[i++];
    } else if (n !== -128) {
      const b = src[i++];
      for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = b;
    }
  }
  return out;
}

function lzw(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(Math.max(expected, 1));
  let o = 0;
  const dictStart = new Int32Array(4096);
  const dictLen = new Int32Array(4096);
  let next = 258;
  let width = 9;
  let bitPos = 0;
  let prev = -1;
  const read = () => {
    let v = 0;
    for (let k = 0; k < width; k++) {
      const byte = src[bitPos >> 3];
      if (byte === undefined) return 257;
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  // Codes point back into what's been written.
  const emit = (start: number, len: number) => {
    for (let k = 0; k < len && o < out.length; k++) out[o++] = out[start + k];
  };
  while (o < out.length) {
    const code = read();
    if (code === 257) break;
    if (code === 256) {
      next = 258;
      width = 9;
      prev = -1;
      continue;
    }
    const at = o;
    const plen = prev < 0 ? 0 : prev < 256 ? 1 : dictLen[prev];
    if (code < 256) out[o++] = code;
    else if (code < next) emit(dictStart[code], dictLen[code]);
    else {
      if (prev < 0) break;
      // The code being defined: the previous string plus its own first byte.
      emit(at - plen, plen);
      if (o < out.length) out[o++] = out[at - plen];
    }
    // The new entry is the previous string and the first byte of this one, which sit together in the output.
    if (prev >= 0 && next < 4096) {
      dictStart[next] = at - plen;
      dictLen[next] = plen + 1;
      next++;
    }
    prev = code;
    // TIFF's LZW widens one code early.
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}
