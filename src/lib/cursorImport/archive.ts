/**
 * What's being imported, as a tree of files and symlinks by their paths
 * inside it, and the archive readers (ZIP, tar, gzip) that fill one.
 *
 * Nothing here touches a disk. Paths are cleaned (no `.`, `..` or leading
 * `/`, so nothing can name a place outside the tree), symlinks are kept as
 * links and only ever resolve to other entries of the same tree, and every
 * entry is charged to the import's budget at its declared size before it's
 * expanded, then held to that size while it is.
 */

import {
  Budget,
  DAMAGED,
  ImportError,
  LIMITS,
  TOO_BIG,
  inflate,
  need,
  slice,
  startsWith,
  text,
  u16le,
  u32le,
} from './bytes';

export type TreeNode = { data: Uint8Array } | { link: string };

/** Files and symlinks by path. */
export type Tree = Map<string, TreeNode>;

/** A path inside a source, without `.`, empty or leading parts; null if it climbs out. */
export function cleanPath(name: string): string | null {
  const parts = name.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) return null;
  return parts.join('/') || null;
}

/** The directory part of a tree path ('' at the top). */
export function dirOf(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash < 0 ? '' : key.slice(0, slash);
}

export function baseOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

export function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Follow symlinks within the tree to a file. */
export function resolve(tree: Tree, start: string): { path: string; data: Uint8Array } | null {
  let current = start;
  for (let hops = 0; hops < 16; hops++) {
    const node = tree.get(current);
    if (!node) return null;
    if ('data' in node) return { path: current, data: node.data };
    if (node.link.startsWith('/')) return null;
    const next = cleanPath(join(dirOf(current), node.link));
    if (!next) return null;
    current = next;
  }
  return null;
}

/** The files directly in `dir`, by lower-case name. */
export function listDir(tree: Tree, dir: string): Map<string, string> {
  const prefix = dir ? `${dir}/` : '';
  const found = new Map<string, string>();
  for (const key of tree.keys()) {
    if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
      found.set(key.slice(prefix.length).toLowerCase(), key);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;

export function isZip(data: Uint8Array): boolean {
  return startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06]);
}

/**
 * Read a ZIP into `tree` under `prefix`. The central directory says what's
 * in it; each entry is charged at its declared size and must inflate to
 * exactly that, so entries sharing one compressed stream (the overlapping
 * zip bomb) are each paid for in full.
 */
export async function readZip(data: Uint8Array, tree: Tree, budget: Budget, prefix = ''): Promise<void> {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (u32le(data, i) === ZIP_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ImportError(DAMAGED);
  const count = u16le(data, end + 10);
  if (count > LIMITS.entries) throw new ImportError(TOO_BIG);
  let p = u32le(data, end + 16);
  for (let i = 0; i < count; i++) {
    if (u32le(data, p) !== ZIP_CENTRAL) throw new ImportError(DAMAGED);
    const madeBy = u16le(data, p + 4) >> 8;
    const flags = u16le(data, p + 8);
    const method = u16le(data, p + 10);
    const compressedSize = u32le(data, p + 20);
    const size = u32le(data, p + 24);
    const nameLength = u16le(data, p + 28);
    const extraLength = u16le(data, p + 30);
    const commentLength = u16le(data, p + 32);
    const external = u32le(data, p + 38);
    const local = u32le(data, p + 42);
    const name = text(slice(data, p + 46, nameLength), flags & 0x800 ? 'utf-8' : 'latin1');
    p += 46 + nameLength + extraLength + commentLength;

    const clean = cleanPath(name);
    if (name.endsWith('/') || !clean) continue;
    // ZIP64 isn't needed by anything cursor-sized.
    if (compressedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new ImportError(TOO_BIG);
    if (flags & 1) throw new ImportError('Encrypted archives can’t be imported.');
    budget.entry(size);
    if (u32le(data, local) !== ZIP_LOCAL) throw new ImportError(DAMAGED);
    const start = local + 30 + u16le(data, local + 26) + u16le(data, local + 28);
    const raw = slice(data, start, compressedSize);

    let content: Uint8Array;
    if (method === 0) {
      if (compressedSize !== size) throw new ImportError(DAMAGED);
      content = raw;
    } else if (method === 8) {
      content = await inflate(raw, 'deflate-raw', size);
      if (content.length !== size) throw new ImportError(DAMAGED);
    } else {
      throw new ImportError(DAMAGED);
    }

    const isSymlink = madeBy === 3 && ((external >>> 16) & 0o170000) === 0o120000;
    tree.set(join(prefix, clean), isSymlink ? { link: text(content) } : { data: content });
  }
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

export function isTar(data: Uint8Array): boolean {
  return data.length >= 512 && text(data.subarray(257, 262), 'latin1') === 'ustar';
}

/** A pax extended header's records. */
function parsePax(content: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  let p = 0;
  while (p < content.length) {
    let space = p;
    while (space < content.length && content[space] !== 0x20) space++;
    const length = Number.parseInt(text(content.subarray(p, space), 'latin1'), 10);
    if (!(length > 0) || p + length > content.length) throw new ImportError(DAMAGED);
    const record = text(content.subarray(space + 1, p + length - 1));
    const eq = record.indexOf('=');
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    p += length;
  }
  return records;
}

/** A NUL-terminated header field. */
function field(header: Uint8Array, offset: number, length: number): string {
  const value = text(header.subarray(offset, offset + length));
  const nul = value.indexOf('\0');
  return nul < 0 ? value : value.slice(0, nul);
}

export function readTar(data: Uint8Array, tree: Tree, budget: Budget, prefix = ''): void {
  let p = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  while (p + 512 <= data.length) {
    const header = data.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    const sizeField = field(header, 124, 12).trim() || '0';
    // Base-256 sizes are for files far bigger than any cursor theme.
    if (!/^[0-7]+$/.test(sizeField)) throw new ImportError(DAMAGED);
    const size = Number.parseInt(sizeField, 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const body = p + 512;
    need(data, body, size);
    const content = data.subarray(body, body + size);
    p = body + Math.ceil(size / 512) * 512;

    if (type === 'L' || type === 'K' || type === 'x') {
      budget.entry(size);
      if (type === 'L') longName = field(content, 0, content.length);
      else if (type === 'K') longLink = field(content, 0, content.length);
      else pax = parsePax(content);
      continue;
    }
    if (type === 'g') continue;
    if (pax.size !== undefined && Number(pax.size) !== size) throw new ImportError(DAMAGED);

    const ustarPrefix = text(header.subarray(257, 262), 'latin1') === 'ustar' ? field(header, 345, 155) : '';
    const name = pax.path ?? longName ?? (ustarPrefix ? `${ustarPrefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const link = pax.linkpath ?? longLink ?? field(header, 157, 100);
    longName = null;
    longLink = null;
    pax = {};

    const clean = cleanPath(name);
    if (!clean) continue;
    if (type === '0' || type === '7') {
      budget.entry(size);
      tree.set(join(prefix, clean), { data: content });
    } else if (type === '2') {
      budget.entry(0);
      tree.set(join(prefix, clean), { link });
    } else if (type === '1') {
      const target = cleanPath(link);
      const node = target ? tree.get(join(prefix, target)) : undefined;
      if (node) {
        budget.entry('data' in node ? node.data.length : 0);
        tree.set(join(prefix, clean), node);
      }
    }
  }
}

// ---------------------------------------------------------------------------

export function isGzip(data: Uint8Array): boolean {
  return startsWith(data, [0x1f, 0x8b]);
}

/**
 * Read `data` as an archive into `tree` under `prefix`: a ZIP, a tar, or a
 * gzipped tar. False if it's none of these.
 */
export async function readArchive(data: Uint8Array, tree: Tree, budget: Budget, prefix = ''): Promise<boolean> {
  if (isZip(data)) {
    await readZip(data, tree, budget, prefix);
    return true;
  }
  if (isGzip(data)) {
    const inner = await inflate(data, 'gzip', LIMITS.expandedBytes);
    budget.expanded(inner.length);
    if (!isTar(inner)) throw new ImportError(DAMAGED);
    readTar(inner, tree, budget, prefix);
    return true;
  }
  if (isTar(data)) {
    readTar(data, tree, budget, prefix);
    return true;
  }
  return false;
}
