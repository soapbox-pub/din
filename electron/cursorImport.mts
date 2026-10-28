// Importing cursor themes: whatever the user picked (a CursorXP
// .CurXPTheme, an XCursor theme as a folder or an archive) becomes a plain
// XCursor theme in ~/.local/share/icons, which Settings lists and the
// pointer uses like any other (electron/cursor.mts).
//
// Every source is read into memory first, as a tree of files and symlinks
// by their paths inside it, so nothing from it touches the disk until it has
// been understood and checked: paths can't climb out, symlinks only resolve
// within the tree, and sizes are capped. Then each theme found is written
// out fresh: the XCursor files, their aliases as symlinks, and an
// index.theme marking it as Din's, so that it can be removed again.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { nativeImage } from 'electron';
import { runCommand } from './system.mts';
import { encodeXcursor, isXcursor, type XcursorFrame } from './xcursor.mts';

const inflateRaw = promisify(zlib.inflateRaw);
const gunzip = promisify(zlib.gunzip);

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_FRAME_DIMENSION = 512;
const MAX_FRAMES = 256;
/** How long a play-once animation holds its last frame: for good, in practice. */
const HOLD_MS = 3_600_000;

/** What fills in the cursors an imported theme lacks; DinOS's default. */
export const FALLBACK_THEME = 'capitaine-cursors';

/** A cursor's file name in a theme. */
const CURSOR_NAME = /^(?!\.)[A-Za-z0-9_.+-]+$/;
/** A theme name we'll write into Inherits=. */
const INHERIT_NAME = /^(?![-.])[A-Za-z0-9_ .+-]+$/;

/** The marker in index.theme that Din imported a theme. */
export const IMPORTED_KEY = 'X-Din-Imported';

/** What's being imported, by path within it. */
type Tree = Map<string, { data: Buffer } | { link: string }>;

/** A theme, ready to write. */
export interface ImportedTheme {
  name: string;
  /** Themes to take missing cursors from, before the fallback. */
  inherits: string[];
  /** Cursor name → XCursor file. */
  files: Map<string, Buffer>;
  /** Alias → the cursor name it stands for. */
  links: Map<string, string>;
}

class ImportError extends Error {}

const DAMAGED = 'The file is damaged or not in a format Din can read.';
const TOO_BIG = 'That is too big to be a cursor theme.';

/** Counts what has been read, so an archive can't expand without end. */
function newBudget() {
  let bytes = 0;
  let entries = 0;
  return (size: number) => {
    bytes += size;
    entries++;
    if (bytes > MAX_EXPANDED_BYTES || entries > MAX_ENTRIES) throw new ImportError(TOO_BIG);
  };
}
type Budget = ReturnType<typeof newBudget>;

/** A path inside a source, without `.`, empty or leading parts; null if it climbs out. */
function cleanPath(name: string): string | null {
  const parts = name.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) return null;
  return parts.join('/') || null;
}

/** Follow symlinks within the tree to a file. */
function resolve(tree: Tree, start: string): { path: string; data: Buffer } | null {
  let current = start;
  for (let hops = 0; hops < 16; hops++) {
    const node = tree.get(current);
    if (!node) return null;
    if ('data' in node) return { path: current, data: node.data };
    if (node.link.startsWith('/')) return null;
    const next = cleanPath(path.posix.join(path.posix.dirname(current), node.link));
    if (!next) return null;
    current = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading sources
// ---------------------------------------------------------------------------

async function readZip(data: Buffer, tree: Tree, budget: Budget): Promise<void> {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ImportError(DAMAGED);
  const count = data.readUInt16LE(end + 10);
  let p = data.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (p + 46 > data.length || data.readUInt32LE(p) !== 0x02014b50) throw new ImportError(DAMAGED);
    const madeBy = data.readUInt16LE(p + 4) >> 8;
    const flags = data.readUInt16LE(p + 8);
    const method = data.readUInt16LE(p + 10);
    const compressedSize = data.readUInt32LE(p + 20);
    const size = data.readUInt32LE(p + 24);
    const nameLength = data.readUInt16LE(p + 28);
    const extraLength = data.readUInt16LE(p + 30);
    const commentLength = data.readUInt16LE(p + 32);
    const external = data.readUInt32LE(p + 38);
    const local = data.readUInt32LE(p + 42);
    const name = data.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    const clean = cleanPath(name);
    if (name.endsWith('/') || !clean) continue;
    if (flags & 1) throw new ImportError('Encrypted archives can’t be imported.');
    budget(size);
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) throw new ImportError(DAMAGED);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    if (start + compressedSize > data.length) throw new ImportError(DAMAGED);
    const raw = data.subarray(start, start + compressedSize);

    let content: Buffer;
    if (method === 0) {
      content = raw;
    } else if (method === 8) {
      try {
        content = await inflateRaw(raw, { maxOutputLength: Math.max(1, size) });
      } catch {
        throw new ImportError(DAMAGED);
      }
    } else {
      throw new ImportError(DAMAGED);
    }

    const isSymlink = madeBy === 3 && ((external >>> 16) & 0o170000) === 0o120000;
    tree.set(clean, isSymlink ? { link: content.toString('utf8') } : { data: content });
  }
}

/** A pax extended header's records. */
function parsePax(content: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let p = 0;
  while (p < content.length) {
    const space = content.indexOf(0x20, p);
    if (space < 0) break;
    const length = Number.parseInt(content.toString('latin1', p, space), 10);
    if (!(length > 0)) break;
    const record = content.toString('utf8', space + 1, p + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    p += length;
  }
  return records;
}

function readTar(data: Buffer, tree: Tree, budget: Budget): void {
  let p = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  while (p + 512 <= data.length) {
    const header = data.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    const field = (offset: number, length: number) => {
      const text = header.toString('utf8', offset, offset + length);
      const nul = text.indexOf('\0');
      return nul < 0 ? text : text.slice(0, nul);
    };
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const body = p + 512;
    if (!Number.isFinite(size) || size < 0 || body + size > data.length) throw new ImportError(DAMAGED);
    const content = data.subarray(body, body + size);
    p = body + Math.ceil(size / 512) * 512;

    const text = () => {
      const value = content.toString('utf8');
      const nul = value.indexOf('\0');
      return nul < 0 ? value : value.slice(0, nul);
    };
    if (type === 'L') {
      longName = text();
      continue;
    }
    if (type === 'K') {
      longLink = text();
      continue;
    }
    if (type === 'x') {
      pax = parsePax(content);
      continue;
    }
    if (type === 'g') continue;

    const prefix = header.toString('latin1', 257, 262) === 'ustar' ? field(345, 155) : '';
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const link = pax.linkpath ?? longLink ?? field(157, 100);
    longName = null;
    longLink = null;
    pax = {};

    const clean = cleanPath(name);
    if (!clean) continue;
    if (type === '0' || type === '7') {
      budget(size);
      tree.set(clean, { data: content });
    } else if (type === '2') {
      budget(0);
      tree.set(clean, { link });
    } else if (type === '1') {
      const target = cleanPath(link);
      const node = target ? tree.get(target) : undefined;
      if (node) tree.set(clean, node);
    }
  }
}

/** Decompress with a system tool, which Node lacks for these formats. */
async function decompressWith(tool: 'xz' | 'bzip2', file: string): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'din-cursor-'));
  const out = path.join(dir, 'out');
  try {
    await runCommand(
      'sh',
      ['-c', '"$0" -dc -- "$1" | head -c "$2" > "$3"', tool, file, String(MAX_EXPANDED_BYTES + 1), out],
      { timeout: 120_000 },
    );
    const result = await fs.readFile(out);
    if (result.length > MAX_EXPANDED_BYTES) throw new ImportError(TOO_BIG);
    return result;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Read `data` as an archive into the tree; false if it isn't one. */
async function readArchive(data: Buffer, file: string | null, tree: Tree, budget: Budget): Promise<boolean> {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06)) {
    await readZip(data, tree, budget);
    return true;
  }
  if (starts(0x1f, 0x8b)) {
    let inner: Buffer;
    try {
      inner = await gunzip(data, { maxOutputLength: MAX_EXPANDED_BYTES });
    } catch (error) {
      throw new ImportError(error instanceof RangeError ? TOO_BIG : DAMAGED);
    }
    return readArchive(inner, null, tree, budget);
  }
  if (file && starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) {
    return readArchive(await decompressWith('xz', file), null, tree, budget);
  }
  if (file && starts(0x42, 0x5a, 0x68)) {
    return readArchive(await decompressWith('bzip2', file), null, tree, budget);
  }
  if (data.length >= 512 && data.toString('latin1', 257, 262) === 'ustar') {
    readTar(data, tree, budget);
    return true;
  }
  return false;
}

async function readDirectory(root: string, tree: Tree, budget: Budget): Promise<void> {
  const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const inside = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, inside, depth + 1);
      } else if (entry.isSymbolicLink()) {
        budget(0);
        tree.set(inside, { link: await fs.readlink(full) });
      } else if (entry.isFile()) {
        budget((await fs.stat(full)).size);
        tree.set(inside, { data: await fs.readFile(full) });
      }
    }
  };
  await walk(root, '', 0);
}

// ---------------------------------------------------------------------------
// XCursor themes
// ---------------------------------------------------------------------------

/** An index.theme's Name= and Inherits=. */
function parseIndexTheme(data: Buffer | undefined): { name: string | null; inherits: string[] } {
  const text = data?.toString('utf8') ?? '';
  const name = /^Name\s*=\s*(.+)$/m.exec(text)?.[1].trim() || null;
  const inherits = (/^Inherits\s*=\s*(.+)$/m.exec(text)?.[1] ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { name, inherits };
}

/** Every XCursor theme in the tree: each directory with a cursors/ directory in it. */
function xcursorThemes(tree: Tree, fallbackName: string): ImportedTheme[] {
  const roots = new Set<string>();
  for (const key of tree.keys()) {
    const parts = key.split('/');
    if (parts.length >= 2 && parts[parts.length - 2] === 'cursors') roots.add(parts.slice(0, -2).join('/'));
  }

  const themes: ImportedTheme[] = [];
  for (const root of roots) {
    const prefix = root ? `${root}/cursors/` : 'cursors/';
    const files = new Map<string, Buffer>();
    const links = new Map<string, string>();
    for (const key of tree.keys()) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (name.includes('/') || !CURSOR_NAME.test(name)) continue;
      const resolved = resolve(tree, key);
      if (!resolved || !isXcursor(resolved.data)) continue;
      const target = resolved.path.slice(prefix.length);
      if (resolved.path !== key && resolved.path.startsWith(prefix) && CURSOR_NAME.test(target) && !target.includes('/')) {
        links.set(name, target);
      } else {
        files.set(name, resolved.data);
      }
    }
    if (!files.has('left_ptr') && !links.has('left_ptr')) {
      const arrow = ['default', 'arrow', 'top_left_arrow'].find((n) => files.has(n) || links.has(n));
      if (!arrow) continue;
      links.set('left_ptr', links.get(arrow) ?? arrow);
    }

    const index = tree.get(root ? `${root}/index.theme` : 'index.theme');
    const { name, inherits } = parseIndexTheme(index && 'data' in index ? index.data : undefined);
    themes.push({
      name: name ?? (root ? path.posix.basename(root) : fallbackName),
      inherits,
      files,
      links,
    });
  }
  return themes;
}

// ---------------------------------------------------------------------------
// CursorXP (.CurXPTheme)
// ---------------------------------------------------------------------------
//
// A ZIP of Scheme.ini, which describes each cursor (frame count, interval,
// hotspot, animation style), and one PNG per cursor holding its frames side
// by side.

/** Each CursorXP role's XCursor name, and the other names it answers to. */
const CURXP_ROLES: { role: string; name: string; aliases: string[] }[] = [
  { role: 'Arrow', name: 'left_ptr', aliases: ['default', 'arrow', 'top_left_arrow', 'left_arrow'] },
  { role: 'Help', name: 'help', aliases: ['question_arrow', 'whats_this', 'left_ptr_help'] },
  { role: 'AppStarting', name: 'progress', aliases: ['left_ptr_watch', 'half-busy'] },
  { role: 'Wait', name: 'wait', aliases: ['watch'] },
  { role: 'Cross', name: 'crosshair', aliases: ['cross', 'tcross', 'cross_reverse', 'diamond_cross'] },
  { role: 'IBeam', name: 'text', aliases: ['xterm', 'ibeam'] },
  { role: 'Handwriting', name: 'pencil', aliases: [] },
  { role: 'NO', name: 'not-allowed', aliases: ['crossed_circle', 'forbidden', 'circle', 'no-drop', 'dnd-no-drop'] },
  {
    role: 'SizeNS',
    name: 'ns-resize',
    aliases: ['size_ver', 'sb_v_double_arrow', 'v_double_arrow', 'double_arrow', 'n-resize', 's-resize', 'top_side', 'bottom_side', 'row-resize', 'split_v'],
  },
  {
    role: 'SizeWE',
    name: 'ew-resize',
    aliases: ['size_hor', 'sb_h_double_arrow', 'h_double_arrow', 'e-resize', 'w-resize', 'left_side', 'right_side', 'col-resize', 'split_h'],
  },
  {
    role: 'SizeNWSE',
    name: 'nwse-resize',
    aliases: ['size_fdiag', 'bd_double_arrow', 'nw-resize', 'se-resize', 'top_left_corner', 'bottom_right_corner'],
  },
  {
    role: 'SizeNESW',
    name: 'nesw-resize',
    aliases: ['size_bdiag', 'fd_double_arrow', 'ne-resize', 'sw-resize', 'top_right_corner', 'bottom_left_corner'],
  },
  { role: 'SizeAll', name: 'move', aliases: ['fleur', 'size_all', 'all-scroll'] },
  { role: 'UpArrow', name: 'up_arrow', aliases: ['center_ptr', 'sb_up_arrow'] },
  { role: 'Hand', name: 'pointer', aliases: ['hand2', 'hand1', 'hand', 'pointing_hand'] },
];

type IniData = Map<string, Map<string, string>>;

/** INI sections and keys, both by lower-case name. */
function parseIni(text: string): IniData {
  const result: IniData = new Map();
  let section = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const key = header[1].trim().toLowerCase();
      section = result.get(key) ?? new Map();
      result.set(key, section);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) section.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return result;
}

function toInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The play order of `count` frames for a CursorXP animation style: 0 loops,
 * 1 goes back and forth, 2 plays once and holds the last frame.
 */
function frameOrder(count: number, style: number): number[] {
  const forward = Array.from({ length: count }, (_, i) => i);
  if (style === 1 && count > 2) return [...forward, ...forward.slice(1, -1).reverse()];
  return forward;
}

/** Frames as XCursor images, with the delays for `style`. */
function animate(frames: Omit<XcursorFrame, 'delay'>[], intervalMs: number, style: number): XcursorFrame[] {
  if (frames.length === 1) return [{ ...frames[0], delay: 0 }];
  const order = frameOrder(frames.length, style);
  return order.map((index, i) => ({
    ...frames[index],
    delay: style === 2 && i === order.length - 1 ? HOLD_MS : intervalMs,
  }));
}

function curxpTheme(tree: Tree, schemePath: string, fallbackName: string): ImportedTheme | null {
  const dir = path.posix.dirname(schemePath);
  const prefix = dir === '.' ? '' : `${dir}/`;
  const byLowerName = new Map<string, string>();
  for (const key of tree.keys()) {
    if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
      byLowerName.set(key.slice(prefix.length).toLowerCase(), key);
    }
  }
  const scheme = resolve(tree, schemePath);
  if (!scheme) return null;
  const ini = parseIni(scheme.data.toString('utf8'));

  const files = new Map<string, Buffer>();
  const links = new Map<string, string>();
  for (const { role, name, aliases } of CURXP_ROLES) {
    const section = ini.get(role.toLowerCase());
    const pngPath = byLowerName.get(`${role.toLowerCase()}.png`);
    const png = pngPath ? resolve(tree, pngPath) : null;
    if (!section || !png) continue;

    const count = Math.min(MAX_FRAMES, Math.max(1, toInt(section.get('frames'), 1)));
    const interval = Math.max(1, toInt(section.get('interval'), 60));
    const style = toInt(section.get('animation style'), 0);
    const image = nativeImage.createFromBuffer(png.data);
    if (image.isEmpty()) continue;
    const { width, height } = image.getSize();
    const frameWidth = Math.floor(width / count);
    if (frameWidth < 1 || frameWidth > MAX_FRAME_DIMENSION || height > MAX_FRAME_DIMENSION) continue;
    const hotX = Math.min(Math.max(0, toInt(section.get('hot spot x'), 0)), frameWidth - 1);
    const hotY = Math.min(Math.max(0, toInt(section.get('hot spot y'), 0)), height - 1);
    // The nominal size is the image's own: CursorXP cursors have one size.
    const size = Math.max(frameWidth, height);

    const frames: Omit<XcursorFrame, 'delay'>[] = [];
    for (let i = 0; i < count; i++) {
      const pixels = image.crop({ x: i * frameWidth, y: 0, width: frameWidth, height }).toBitmap();
      if (pixels.length !== frameWidth * height * 4) break;
      frames.push({ size, width: frameWidth, height, hotX, hotY, pixels });
    }
    if (frames.length === 0) continue;

    files.set(name, encodeXcursor(animate(frames, interval, style)));
    for (const alias of aliases) links.set(alias, name);
  }
  if (!files.has('left_ptr')) return null;
  return { name: fallbackName, inherits: [], files, links };
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

function findThemes(tree: Tree, fallbackName: string): ImportedTheme[] {
  const themes: ImportedTheme[] = [];
  for (const key of tree.keys()) {
    if (path.posix.basename(key).toLowerCase() !== 'scheme.ini') continue;
    const theme = curxpTheme(tree, key, fallbackName);
    if (theme) themes.push(theme);
  }
  themes.push(...xcursorThemes(tree, fallbackName));
  return themes;
}

/** A name that's safe in index.theme. */
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80) || 'Imported cursors';
}

/** A theme directory name made from its display name. */
function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_.+-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 48) || 'cursors'
  );
}

async function install(theme: ImportedTheme, base: string, id: string): Promise<void> {
  await fs.mkdir(base, { recursive: true });
  const staging = await fs.mkdtemp(path.join(base, '.din-cursor-'));
  try {
    const cursors = path.join(staging, 'cursors');
    await fs.mkdir(cursors);
    for (const [name, data] of theme.files) await fs.writeFile(path.join(cursors, name), data);
    for (const [alias, target] of theme.links) {
      if (!theme.files.has(alias) && theme.files.has(target)) await fs.symlink(target, path.join(cursors, alias));
    }
    const inherits = [...new Set([...theme.inherits, FALLBACK_THEME])].filter(
      (name) => name !== id && INHERIT_NAME.test(name),
    );
    await fs.writeFile(
      path.join(staging, 'index.theme'),
      [
        '[Icon Theme]',
        `Name=${cleanName(theme.name)}`,
        'Comment=Imported by Din',
        `Inherits=${inherits.join(',')}`,
        `${IMPORTED_KEY}=true`,
        '',
      ].join('\n'),
    );
    await fs.chmod(staging, 0o755);
    const dest = path.join(base, id);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(staging, dest);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Import the cursor themes in `source` (a file or a folder) into `base`,
 * returning their ids. `taken` says whether an id belongs to a theme that
 * mustn't be replaced; Din's own earlier imports of the same name are.
 */
export async function importCursorThemes(
  source: string,
  options: { base: string; taken: (id: string) => Promise<boolean> },
): Promise<string[]> {
  const stat = await fs.stat(source);
  const fallbackName =
    path.basename(source).replace(/\.(curxptheme|zip|tar(\.(gz|xz|bz2))?|tgz|txz|tbz2?)$/i, '') || 'Imported cursors';
  const tree: Tree = new Map();
  const budget = newBudget();

  if (stat.isDirectory()) {
    await readDirectory(source, tree, budget);
  } else {
    if (stat.size > MAX_SOURCE_BYTES) throw new ImportError(TOO_BIG);
    const data = await fs.readFile(source);
    if (!(await readArchive(data, source, tree, budget))) {
      throw new ImportError('Din can’t read this kind of file as cursors.');
    }
  }

  const themes = findThemes(tree, fallbackName);
  if (themes.length === 0) throw new ImportError('No cursor themes were found in it.');

  const ids: string[] = [];
  for (const theme of themes) {
    const stem = slug(theme.name);
    let id = stem;
    for (let n = 2; ids.includes(id) || (await options.taken(id)); n++) id = `${stem}-${n}`;
    await install(theme, options.base, id);
    ids.push(id);
  }
  return ids;
}
