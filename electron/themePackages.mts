// Cursor and icon themes as Nostr publishes them (NIP.md, kinds 34628 and
// 34642): what's shared between exporting a theme for publishing and
// installing one someone published.
//
// A published cursor theme is its cursors/ directory, one Blossom blob per
// XCursor file and a tag per alias (cursor.mts). A published icon theme is
// one blob, a gzipped tarball of its directory (icon-theme.mts): big sets
// have tens of thousands of files, more than an event's tags can list.
//
// Installing downloads each blob from the servers the renderer names,
// checks it against its hash from the signed event, and writes the theme
// into a staging directory beside its final place, which takes that place
// in one rename. index.theme is stamped with where the theme came from, so
// the store can tell it's installed, offer an update, and remove it.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { net } from 'electron';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** Where an installed theme was published: its `<kind>:<pubkey>:<d>` coordinate. */
export const SOURCE_KEY = 'X-Din-Source';
/** The `created_at` of the version installed. */
export const PUBLISHED_KEY = 'X-Din-Published';

const SHA256 = /^[0-9a-f]{64}$/;
const COORDINATE = /^\d+:[0-9a-f]{64}:.+$/;

/** How long one blob may take to download; an icon set's archive can be tens of megabytes. */
const BLOB_TIMEOUT_MS = 10 * 60_000;
/** Blobs downloaded at once. */
const CONCURRENCY = 6;
/** What an archive may unpack to; a damaged or hostile one stops here rather than filling the disk. */
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;

export class PackageError extends Error {}

// ---------------------------------------------------------------------------
// index.theme
// ---------------------------------------------------------------------------

/** An index.theme's key in its [Icon Theme] group, or null. */
export function themeKey(text: string, key: string): string | null {
  let inHead = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inHead = line === '[Icon Theme]';
      continue;
    }
    const eq = line.indexOf('=');
    if (inHead && eq > 0 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  return null;
}

/** index.theme without Din's own keys, for publishing. */
export function stripDinKeys(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*X-Din-[A-Za-z]+\s*=/.test(line))
    .join('\n');
}

/** index.theme with Din's keys set in its [Icon Theme] group, which is added if it lacks one. */
export function stampDinKeys(text: string, keys: Record<string, string>): string {
  const lines = stripDinKeys(text).split('\n');
  const stamp = Object.entries(keys).map(([key, value]) => `${key}=${value}`);
  const head = lines.findIndex((line) => line.trim() === '[Icon Theme]');
  if (head === -1) return ['[Icon Theme]', ...stamp, '', ...lines].join('\n');
  lines.splice(head + 1, 0, ...stamp);
  return lines.join('\n');
}

/** Where a theme in `dir` came from, if Din installed it from Nostr. */
export interface PublishedSource {
  coordinate: string;
  publishedAt: number;
}

export async function readSource(dir: string): Promise<PublishedSource | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, 'index.theme'), 'utf8');
  } catch {
    return null;
  }
  const coordinate = themeKey(text, SOURCE_KEY);
  if (!coordinate || !COORDINATE.test(coordinate)) return null;
  return { coordinate, publishedAt: Number(themeKey(text, PUBLISHED_KEY)) || 0 };
}

/** The themes in `base` installed from a coordinate of `kind`, by directory name. */
export async function installedFromNostr(base: string, kind: number): Promise<{ id: string; source: PublishedSource }[]> {
  let ids: string[];
  try {
    ids = await fs.readdir(base);
  } catch {
    return [];
  }
  const found: { id: string; source: PublishedSource }[] = [];
  for (const id of ids) {
    if (id.startsWith('.')) continue;
    const source = await readSource(path.join(base, id));
    if (source?.coordinate.startsWith(`${kind}:`)) found.push({ id, source });
  }
  return found;
}

// ---------------------------------------------------------------------------
// What the renderer sends to install
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fields every published theme has, checked. */
export interface PackageBase {
  /** The `d` tag: what the theme's directory is called, when that's free. */
  identifier: string;
  name: string;
  coordinate: string;
  publishedAt: number;
  inherits: string[];
  servers: string[];
}

export function checkPackageBase(value: unknown, kind: number, inheritName: RegExp): PackageBase & Record<string, unknown> {
  if (!isRecord(value)) throw new PackageError('Not a theme');
  const { identifier, name, coordinate, publishedAt, inherits, servers } = value;
  if (typeof identifier !== 'string' || !identifier || identifier.length > 200) throw new PackageError('Not a theme');
  if (typeof coordinate !== 'string' || !COORDINATE.test(coordinate) || !coordinate.startsWith(`${kind}:`)) {
    throw new PackageError('Not a theme');
  }
  if (typeof publishedAt !== 'number' || !Number.isInteger(publishedAt) || publishedAt < 0) throw new PackageError('Not a theme');
  if (!Array.isArray(servers)) throw new PackageError('Not a theme');
  const https = servers.filter((server): server is string => {
    if (typeof server !== 'string') return false;
    try {
      return new URL(server).protocol === 'https:';
    } catch {
      return false;
    }
  });
  if (!https.length) throw new PackageError('The theme names no server to download it from.');
  return {
    ...value,
    identifier,
    name: typeof name === 'string' && name.trim() ? name : identifier,
    coordinate,
    publishedAt,
    inherits: Array.isArray(inherits)
      ? inherits.filter((n): n is string => typeof n === 'string' && inheritName.test(n)).slice(0, 8)
      : [],
    servers: [...new Set(https)].slice(0, 16),
  };
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

function sha256(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** One blob, from the first server whose copy matches its hash. */
async function fetchBlob(hash: string, servers: string[]): Promise<Buffer> {
  for (const server of servers) {
    let url: string;
    try {
      url = new URL(hash, server.endsWith('/') ? server : `${server}/`).toString();
    } catch {
      continue;
    }
    try {
      const response = await net.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
      if (!response.ok) continue;
      const data = Buffer.from(await response.arrayBuffer());
      // The event is signed; the server isn't trusted.
      if (sha256(data) === hash) return data;
    } catch {
      // Unreachable or too slow: the next server.
    }
  }
  throw new PackageError('Some of the theme’s files couldn’t be downloaded from its servers.');
}

/** Several blobs, a few at a time, by hash. */
export async function fetchBlobs(hashes: string[], servers: string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(hashes)];
  const blobs = new Map<string, Buffer>();
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const hash = unique[next++];
      blobs.set(hash, await fetchBlob(hash, servers));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return blobs;
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/**
 * The directory a published theme installs as: where the same one is
 * already, else its `d` tag when nothing else has that name, else the `d`
 * with a number after it.
 */
export async function installId(
  base: string,
  kind: number,
  pkg: PackageBase,
  valid: RegExp,
  exists: (id: string) => Promise<boolean>,
): Promise<string> {
  const same = (await installedFromNostr(base, kind)).find((t) => t.source.coordinate === pkg.coordinate);
  if (same) return same.id;
  const stem = valid.test(pkg.identifier) ? pkg.identifier : slug(pkg.name);
  let id = stem;
  for (let n = 2; await exists(id); n++) id = `${stem}-${n}`;
  return id;
}

/** A directory name made from a display name. */
function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_.+-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 48) || 'theme'
  );
}

/** Fill a staging directory beside `base/id` with `fill`, then swap it into place. */
export async function installStaged(base: string, id: string, fill: (staging: string) => Promise<void>): Promise<void> {
  await fs.mkdir(base, { recursive: true });
  const staging = await fs.mkdtemp(path.join(base, '.din-theme-'));
  try {
    await fill(staging);
    await fs.chmod(staging, 0o755);
    const dest = path.join(base, id);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(staging, dest);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tarballs (POSIX ustar, with pax headers for long names)
// ---------------------------------------------------------------------------

export type TarEntry =
  | { path: string; type: 'file'; data: Uint8Array }
  | { path: string; type: 'link'; target: string };

const BLOCK = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(name: string, type: string, size: number, link = '', prefix = ''): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(type === '2' || type === '5' ? 0o755 : 0o644, 8), 100, 'latin1');
  block.write(octal(0, 8), 108, 'latin1');
  block.write(octal(0, 8), 116, 'latin1');
  block.write(octal(size, 12), 124, 'latin1');
  block.write(octal(0, 12), 136, 'latin1');
  block.write('        ', 148, 'latin1');
  block.write(type, 156, 'latin1');
  block.write(link, 157, 100, 'utf8');
  block.write('ustar\u000000', 257, 'latin1');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + ' ', 148, 'latin1');
  return block;
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** A name split into ustar's prefix and name fields, or null when it needs a pax header. */
function splitName(name: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { prefix, name: rest };
  }
  return null;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

/** A gzipped tarball of `entries`, the same bytes for the same entries. */
export async function packTarGz(entries: TarEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const size = entry.type === 'file' ? entry.data.length : 0;
    const link = entry.type === 'link' ? entry.target : '';
    const split = splitName(entry.path);
    let records = '';
    if (!split) records += paxRecord('path', entry.path);
    if (Buffer.byteLength(link) > 100) records += paxRecord('linkpath', link);
    if (records) {
      const pax = Buffer.from(records, 'utf8');
      chunks.push(header('PaxHeader', 'x', pax.length), pax, padding(pax.length));
    }
    const name = split ?? { prefix: '', name: entry.path.slice(-100) };
    chunks.push(header(name.name, entry.type === 'file' ? '0' : '2', size, link.slice(0, 100), name.prefix));
    if (entry.type === 'file') chunks.push(Buffer.from(entry.data), padding(size));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzip(Buffer.concat(chunks));
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space === -1) break;
    const length = Number.parseInt(data.toString('latin1', position, space), 10);
    if (!length || position + length > data.length) break;
    const record = data.toString('utf8', space + 1, position + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    position += length;
  }
  return records;
}

/** The files and symlinks in a gzipped tarball; directories are implied, anything else is left out. */
export async function unpackTarGz(archive: Buffer): Promise<TarEntry[]> {
  let tar: Buffer;
  try {
    tar = await gunzip(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new PackageError('The theme’s archive is damaged.');
  }
  const entries: TarEntry[] = [];
  let pax = new Map<string, string>();
  let longName: string | null = null;
  let longLink: string | null = null;
  for (let position = 0; position + BLOCK <= tar.length; ) {
    const block = tar.subarray(position, position + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(block, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new PackageError('The theme’s archive is damaged.');
    const type = String.fromCharCode(block[156] || 0x30);
    const dataStart = position + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new PackageError('The theme’s archive is damaged.');
    position = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      pax = parsePax(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === 'K') {
      longLink = field(data, 0, data.length);
      continue;
    }

    const ustar = field(block, 257, 6) === 'ustar';
    const prefix = ustar ? field(block, 345, 155) : '';
    const name = pax.get('path') ?? longName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    const link = pax.get('linkpath') ?? longLink ?? field(block, 157, 100);
    pax = new Map();
    longName = null;
    longLink = null;

    if (type === '0' || type === '7') entries.push({ path: name, type: 'file', data });
    else if (type === '2') entries.push({ path: name, type: 'link', target: link });
  }
  return entries;
}

/** A path inside an archive made safe to join onto a theme's directory, or null if it leaves it. */
export function safeRelative(name: string): string | null {
  if (!name || name.includes('\0') || name.startsWith('/')) return null;
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

/** Whether a symlink at `at` pointing to `target` stays inside the theme. */
export function linkStaysInside(at: string, target: string): boolean {
  if (!target || target.startsWith('/') || target.includes('\0')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(at), target));
  return resolved !== '..' && !resolved.startsWith('../') && !resolved.startsWith('/');
}
