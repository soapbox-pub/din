/**
 * Compound files (MS-CFB, "OLE2" structured storage): the container behind
 * Publisher's .pub, the old binary Word, Excel and PowerPoint formats, MSI
 * and more. A little FAT file system in one file: fixed-size sectors chained
 * through a FAT, a directory of storages (folders) and streams (files), and
 * small streams packed into 64-byte mini sectors of their own.
 *
 * Read-only. Damaged files fail with an Error rather than looping or reading
 * out of bounds; chains are cut where they leave the file or come back on
 * themselves.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;

export interface CfbEntry {
  name: string;
  /** Slash-separated path from the root, e.g. "Quill/QuillSub/CONTENTS". */
  path: string;
  type: 'storage' | 'stream';
  size: number;
}

export interface Cfb {
  entries: CfbEntry[];
  /** A stream's bytes by path (case-insensitive, as names are), or null when there's none. */
  stream(path: string): Uint8Array | null;
}

/** Whether bytes start like a compound file. */
export function isCfb(b: Uint8Array): boolean {
  return b.length >= 512 && SIGNATURE.every((v, i) => b[i] === v);
}

export function readCfb(b: Uint8Array): Cfb {
  if (!isCfb(b)) throw new Error('It isn’t a compound file.');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (o: number) => v.getUint32(o, true);
  const sectorShift = v.getUint16(30, true);
  const miniShift = v.getUint16(32, true);
  if (sectorShift !== 9 && sectorShift !== 12) throw new Error('Its sector size isn’t one compound files use.');
  const ss = 1 << sectorShift;
  const ms = 1 << miniShift;
  const numFat = u32(44);
  const dirStart = u32(48);
  const cutoff = u32(56) || 4096;
  const miniFatStart = u32(60);
  const numMiniFat = u32(64);
  let difatNext = u32(68);
  const numDifat = u32(72);
  const sectors = Math.floor((b.length - ss) / ss) + ((b.length - ss) % ss ? 1 : 0);
  const at = (s: number) => ss + s * ss;
  const sector = (s: number) => b.subarray(at(s), Math.min(b.length, at(s) + ss));

  // The FAT's own sectors: 109 listed in the header, the rest in DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    const s = u32(76 + i * 4);
    if (s !== FREE) fatSectors.push(s);
  }
  const seenDifat = new Set<number>();
  for (let n = 0; n < numDifat && difatNext < sectors && !seenDifat.has(difatNext); n++) {
    seenDifat.add(difatNext);
    const o = at(difatNext);
    const per = ss / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFat; i++) {
      if (o + i * 4 + 4 > b.length) break;
      const s = u32(o + i * 4);
      if (s !== FREE) fatSectors.push(s);
    }
    difatNext = o + per * 4 + 4 <= b.length ? u32(o + per * 4) : END_OF_CHAIN;
  }
  const fat = new Uint32Array(fatSectors.length * (ss / 4));
  fatSectors.forEach((s, i) => {
    if (s >= sectors) return;
    const src = sector(s);
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    for (let j = 0; j * 4 + 4 <= src.length; j++) fat[i * (ss / 4) + j] = dv.getUint32(j * 4, true);
  });

  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s < limit && s < table.length && !seen.has(s); s = table[s]) {
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const readChain = (start: number, size?: number): Uint8Array => {
    const list = chain(start, fat, sectors);
    const out = new Uint8Array(size ?? list.length * ss);
    let o = 0;
    for (const s of list) {
      if (o >= out.length) break;
      const part = sector(s).subarray(0, out.length - o);
      out.set(part, o);
      o += part.length;
    }
    return o < out.length ? out.subarray(0, o) : out;
  };

  // The directory: 128-byte entries forming red-black trees of siblings.
  const dir = readChain(dirStart);
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  interface Raw { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
  const raws: Raw[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = Math.min(64, dv.getUint16(o + 64, true));
    let name = '';
    for (let i = 0; i + 2 < nameLen; i += 2) name += String.fromCharCode(dv.getUint16(o + i, true));
    const size = sectorShift === 9 ? dv.getUint32(o + 120, true) : dv.getUint32(o + 120, true) + dv.getUint32(o + 124, true) * 2 ** 32;
    raws.push({ name, type: dir[o + 66], left: dv.getUint32(o + 68, true), right: dv.getUint32(o + 72, true), child: dv.getUint32(o + 76, true), start: dv.getUint32(o + 116, true), size });
  }
  const root = raws[0];
  if (!root || root.type !== 5) throw new Error('Its directory is damaged.');

  // Small streams live in the mini stream (the root entry's data), in mini sectors chained by the mini FAT.
  const miniStream = root.start < sectors ? readChain(root.start, root.size) : new Uint8Array(0);
  const miniFatBytes = numMiniFat && miniFatStart < sectors ? readChain(miniFatStart) : new Uint8Array(0);
  const miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
  {
    const m = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = m.getUint32(i * 4, true);
  }
  const readMini = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let o = 0;
    const limit = Math.floor(miniStream.length / ms);
    for (const s of chain(start, miniFat, limit)) {
      if (o >= size) break;
      const part = miniStream.subarray(s * ms, Math.min(miniStream.length, s * ms + Math.min(ms, size - o)));
      out.set(part, o);
      o += part.length;
    }
    return o < size ? out.subarray(0, o) : out;
  };

  const entries: CfbEntry[] = [];
  const byPath = new Map<string, Raw>();
  const visited = new Set<number>();
  const walk = (i: number, prefix: string) => {
    if (i === NO_STREAM || i >= raws.length || visited.has(i)) return;
    visited.add(i);
    const r = raws[i];
    walk(r.left, prefix);
    if (r.type === 1 || r.type === 2) {
      const path = prefix ? `${prefix}/${r.name}` : r.name;
      entries.push({ name: r.name, path, type: r.type === 1 ? 'storage' : 'stream', size: r.size });
      byPath.set(path.toUpperCase(), r);
      if (r.type === 1) walk(r.child, path);
    }
    walk(r.right, prefix);
  };
  walk(root.child, '');

  return {
    entries,
    stream(path: string) {
      const r = byPath.get(path.toUpperCase());
      if (!r || r.type !== 2) return null;
      const size = Math.min(r.size, b.length * 2);
      if (size === 0) return new Uint8Array(0);
      return size < cutoff ? readMini(r.start, size) : readChain(r.start, size);
    },
  };
}
