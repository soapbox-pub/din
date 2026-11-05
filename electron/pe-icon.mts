// A Windows program's own icon and name, read from the resources in its
// .exe, for Files and the desktop to show in place of the generic program
// icon, and for its windows' Dock tile and title bar while it runs.
//
// An .exe is a PE file: its resource section holds icon groups (RT_GROUP_ICON,
// a list of sizes, each naming an RT_ICON with the image) and its version
// information (RT_VERSION). Windows shows the first icon group as the file's
// icon and the version's FileDescription as the program's name, and so does
// Din. Only the parts needed are read, at their offsets, so a program of
// hundreds of megabytes costs a few small reads; every offset in the file is
// checked against what was read before it's used, as the file may be anything.
//
// An icon is a PNG (Vista's 256px ones) or a DIB, a bitmap without its file
// header; DIBs are decoded here and made PNGs, so whatever shows the icon
// needs no ICO support.

import fs from 'node:fs';
import { nativeImage } from 'electron';

/** The largest icon kept: the largest a file's icon is drawn. */
const ICON_PX = 256;
/** An icon image bigger than this isn't one. */
const MAX_ICON_BYTES = 4 * 1024 * 1024;
/** Version information bigger than this isn't read. */
const MAX_VERSION_BYTES = 64 * 1024;
/** Resource directory entries looked at in one directory. */
const MAX_DIR_ENTRIES = 4096;

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ProgramInfo {
  /** The icon as a PNG, or null when it has none Din can read. */
  icon: Buffer | null;
  /** Its FileDescription, else its ProductName, or null. */
  name: string | null;
}

/** Positioned reads from the file, failing on a short one. */
class Reader {
  private readonly handle: fs.promises.FileHandle;
  readonly size: number;

  constructor(handle: fs.promises.FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new Error('Outside the file');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error('Short read');
    return buffer;
  }
}

interface Section {
  rva: number;
  size: number;
  offset: number;
}

/** A resource directory's entry: an id (or null for a named one) and where it leads. */
interface DirEntry {
  id: number | null;
  /** Offset from the start of the resource section. */
  target: number;
  isDir: boolean;
}

/** The resource section, read whole, and how to turn RVAs into file offsets. */
class Resources {
  private readonly reader: Reader;
  private readonly sections: Section[];
  private readonly root: Buffer;

  constructor(reader: Reader, sections: Section[], root: Buffer) {
    this.reader = reader;
    this.sections = sections;
    this.root = root;
  }

  /** The entries of the directory at `offset` in the resource section. */
  entries(offset: number): DirEntry[] {
    const { root } = this;
    if (offset + 16 > root.length) return [];
    const count = Math.min(root.readUInt16LE(offset + 12) + root.readUInt16LE(offset + 14), MAX_DIR_ENTRIES);
    const entries: DirEntry[] = [];
    for (let i = 0; i < count; i++) {
      const at = offset + 16 + i * 8;
      if (at + 8 > root.length) break;
      const name = root.readUInt32LE(at);
      const data = root.readUInt32LE(at + 4);
      entries.push({
        id: name & 0x80000000 ? null : name & 0xffff,
        target: data & 0x7fffffff,
        isDir: (data & 0x80000000) !== 0,
      });
    }
    return entries;
  }

  /**
   * The data of a resource, by type and (optionally) id: the first match,
   * in the first language it has. Named resources come before numbered
   * ones, as Windows orders them.
   */
  async data(type: number, id: number | null, maxBytes: number): Promise<Buffer | null> {
    const typeDir = this.entries(0).find((e) => e.isDir && e.id === type);
    if (!typeDir) return null;
    const nameDir = this.entries(typeDir.target).find((e) => e.isDir && (id === null || e.id === id));
    if (!nameDir) return null;
    const leaf = this.entries(nameDir.target).find((e) => !e.isDir);
    if (!leaf || leaf.target + 16 > this.root.length) return null;
    const rva = this.root.readUInt32LE(leaf.target);
    const size = this.root.readUInt32LE(leaf.target + 4);
    if (size === 0 || size > maxBytes) return null;
    const offset = rvaToOffset(this.sections, rva, size);
    return offset === null ? null : this.reader.read(offset, size).catch(() => null);
  }
}

/** Where in the file an RVA's `size` bytes are, or null when no section holds them. */
function rvaToOffset(sections: Section[], rva: number, size: number): number | null {
  for (const section of sections) {
    if (rva >= section.rva && rva + size <= section.rva + section.size) return section.offset + (rva - section.rva);
  }
  return null;
}

/** The program's resource section, or null when it isn't a PE file or has none. */
async function openResources(reader: Reader): Promise<Resources | null> {
  const dos = await reader.read(0, 64);
  if (dos.toString('latin1', 0, 2) !== 'MZ') return null;
  const pe = dos.readUInt32LE(0x3c);
  const header = await reader.read(pe, 24);
  if (header.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"
  const sectionCount = header.readUInt16LE(6);
  const optionalSize = header.readUInt16LE(20);
  const optional = await reader.read(pe + 24, optionalSize);
  const magic = optional.readUInt16LE(0);
  // The data directories' count and place: PE32 or PE32+ (64-bit).
  const countAt = magic === 0x20b ? 108 : magic === 0x10b ? 92 : -1;
  if (countAt < 0 || countAt + 4 > optional.length) return null;
  const dirCount = optional.readUInt32LE(countAt);
  const resourceAt = countAt + 4 + 2 * 8;
  if (dirCount < 3 || resourceAt + 8 > optional.length) return null;
  const resourceRva = optional.readUInt32LE(resourceAt);
  const resourceSize = optional.readUInt32LE(resourceAt + 4);
  if (!resourceRva || !resourceSize) return null;

  const table = await reader.read(pe + 24 + optionalSize, Math.min(sectionCount, 96) * 40);
  const sections: Section[] = [];
  for (let i = 0; i + 40 <= table.length; i += 40) {
    const virtualSize = table.readUInt32LE(i + 8);
    const rawSize = table.readUInt32LE(i + 16);
    sections.push({
      rva: table.readUInt32LE(i + 12),
      // The part that's in the file: the rest of a section is zeros in memory.
      size: virtualSize ? Math.min(virtualSize, rawSize) : rawSize,
      offset: table.readUInt32LE(i + 20),
    });
  }
  // The directories themselves sit at the start of the section; a megabyte
  // holds them in any program, and the data they lead to is read apart.
  const holder = sections.find((s) => resourceRva >= s.rva && resourceRva < s.rva + s.size);
  if (!holder) return null;
  const length = Math.min(resourceSize, holder.rva + holder.size - resourceRva, 1024 * 1024);
  const root = await reader.read(holder.offset + (resourceRva - holder.rva), length);
  return new Resources(reader, sections, root);
}

/** The best image in the first icon group: the largest, up to ICON_PX, with the most colors. */
async function bestIcon(resources: Resources): Promise<Buffer | null> {
  const group = await resources.data(RT_GROUP_ICON, null, 64 * 1024);
  if (!group || group.length < 6 || group.readUInt16LE(2) !== 1) return null;
  const count = group.readUInt16LE(4);
  const images: { px: number; bits: number; id: number }[] = [];
  for (let i = 0; i < count && 6 + (i + 1) * 14 <= group.length; i++) {
    const at = 6 + i * 14;
    const px = group[at] || 256;
    const colors = group[at + 2];
    const bits = group.readUInt16LE(at + 6) || (colors ? Math.ceil(Math.log2(colors)) : 8);
    images.push({ px, bits, id: group.readUInt16LE(at + 12) });
  }
  const score = (image: { px: number; bits: number }) =>
    (image.px > ICON_PX ? ICON_PX - image.px : image.px) * 64 + image.bits;
  images.sort((a, b) => score(b) - score(a));
  for (const image of images) {
    const data = await resources.data(RT_ICON, image.id, MAX_ICON_BYTES);
    const png = data && iconToPng(data);
    if (png) return png;
  }
  return null;
}

/** An RT_ICON's image as a PNG no bigger than ICON_PX, or null. */
function iconToPng(data: Buffer): Buffer | null {
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const image = nativeImage.createFromBuffer(data);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    if (Math.max(width, height) <= ICON_PX) return data;
    const scale = ICON_PX / Math.max(width, height);
    const small = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'best',
    });
    return small.isEmpty() ? null : small.toPNG();
  }
  const bitmap = decodeDib(data);
  if (!bitmap) return null;
  const image = nativeImage.createFromBitmap(bitmap.bgra, { width: bitmap.width, height: bitmap.height });
  return image.isEmpty() ? null : image.toPNG();
}

/**
 * An icon's DIB as BGRA pixels, top row first: a BITMAPINFOHEADER whose
 * height counts the image and its AND mask, the palette for 8 bits or
 * fewer, the image bottom row first, then the 1-bit mask (transparent where
 * set) for images without an alpha channel.
 */
export function decodeDib(data: Buffer): { bgra: Buffer; width: number; height: number } | null {
  if (data.length < 40) return null;
  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  const height = Math.abs(data.readInt32LE(8)) / 2;
  const bits = data.readUInt16LE(14);
  const compression = data.readUInt32LE(16);
  if (headerSize < 40 || headerSize > data.length || width <= 0 || width > 1024 || !Number.isInteger(height)) return null;
  if (height <= 0 || height > 1024 || compression !== 0 || ![1, 4, 8, 24, 32].includes(bits)) return null;
  const paletteSize = bits <= 8 ? data.readUInt32LE(32) || 1 << bits : 0;
  const palette = headerSize;
  const pixels = palette + paletteSize * 4;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const mask = pixels + stride * height;
  if (mask > data.length) return null;
  const hasMask = mask + maskStride * height <= data.length;

  const bgra = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixels + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (bits === 32) {
        data.copy(bgra, out, row + x * 4, row + x * 4 + 4);
        if (bgra[out + 3]) anyAlpha = true;
      } else if (bits === 24) {
        data.copy(bgra, out, row + x * 3, row + x * 3 + 3);
        bgra[out + 3] = 255;
      } else {
        const bit = x * bits;
        const byte = data[row + (bit >> 3)];
        const index = (byte >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
        const entry = palette + Math.min(index, paletteSize - 1) * 4;
        data.copy(bgra, out, entry, entry + 3);
        bgra[out + 3] = 255;
      }
    }
  }
  // A 32-bit image with no alpha at all is an old one that relies on its
  // mask, like those with fewer bits.
  if (bits === 32 && !anyAlpha) for (let i = 3; i < bgra.length; i += 4) bgra[i] = 255;
  if (hasMask && (bits !== 32 || !anyAlpha)) {
    for (let y = 0; y < height; y++) {
      const row = mask + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x++) {
        if ((data[row + (x >> 3)] >> (7 - (x & 7))) & 1) bgra.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 4);
      }
    }
  }
  return { bgra, width, height };
}

/** A UTF-16 string from `start`, up to a NUL or `end`. */
function utf16(data: Buffer, start: number, end: number): { text: string; next: number } {
  let at = start;
  while (at + 1 < end && data.readUInt16LE(at) !== 0) at += 2;
  return { text: data.toString('utf16le', start, at), next: at + 2 };
}

const align4 = (n: number) => (n + 3) & ~3;

/**
 * The strings in a VS_VERSIONINFO, by key, from its first StringTable (the
 * one for US English when there's one). Each block is a length, its value's
 * length, a type, a NUL-ended UTF-16 key, its value and its children, each
 * on a 4-byte boundary.
 */
export function versionStrings(data: Buffer): Map<string, string> {
  const tables: Map<string, string>[] = [];
  let english: Map<string, string> | null = null;
  const walk = (start: number, end: number, depth: number, table: Map<string, string> | null): void => {
    let at = start;
    while (at + 6 <= end && depth <= 3) {
      const length = data.readUInt16LE(at);
      if (length < 6 || at + length > end) return;
      const valueLength = data.readUInt16LE(at + 2);
      const type = data.readUInt16LE(at + 4);
      const blockEnd = at + length;
      const key = utf16(data, at + 6, blockEnd);
      const value = align4(key.next);
      if (depth === 3 && table && type === 1 && valueLength > 0) {
        table.set(key.text, utf16(data, value, blockEnd).text.trim());
      }
      const children = align4(value + (type === 1 ? valueLength * 2 : valueLength));
      if (depth === 1 && key.text !== 'StringFileInfo') {
        // VarFileInfo: nothing wanted in it.
      } else if (depth === 2) {
        const strings = new Map<string, string>();
        tables.push(strings);
        if (key.text.toLowerCase().startsWith('0409')) english ??= strings;
        walk(children, blockEnd, depth + 1, strings);
      } else if (depth < 3) {
        walk(children, blockEnd, depth + 1, table);
      }
      at = align4(blockEnd);
    }
  };
  walk(0, data.length, 0, null);
  return english ?? tables[0] ?? new Map();
}

/** Programs' icons and names kept before the oldest are dropped. */
const INFO_CACHE = 200;
const infos = new Map<string, Promise<ProgramInfo>>();

/** A program's icon and name, read once per version of the file. */
export async function programInfo(file: string): Promise<ProgramInfo> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(file);
  } catch {
    return { icon: null, name: null };
  }
  const key = `${file}\0${stats.mtimeMs}\0${stats.size}`;
  let info = infos.get(key);
  if (!info) {
    info = readProgramInfo(file).catch(() => ({ icon: null, name: null }));
    infos.set(key, info);
    if (infos.size > INFO_CACHE) infos.delete(infos.keys().next().value!);
  }
  return info;
}

/** A program's icon and name, from its resources; nulls for what it hasn't got. */
export async function readProgramInfo(file: string): Promise<ProgramInfo> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY);
  } catch {
    return { icon: null, name: null };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { icon: null, name: null };
    const resources = await openResources(new Reader(handle, stats.size)).catch(() => null);
    if (!resources) return { icon: null, name: null };
    const icon = await bestIcon(resources).catch(() => null);
    const version = await resources.data(RT_VERSION, null, MAX_VERSION_BYTES).catch(() => null);
    const strings = version ? versionStrings(version) : new Map<string, string>();
    const name = strings.get('FileDescription') || strings.get('ProductName') || null;
    return { icon, name: name && name.length <= 128 ? name : null };
  } finally {
    await handle.close();
  }
}
