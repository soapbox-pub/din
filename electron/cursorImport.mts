// Importing cursor themes: whatever the user picked (a CursorXP
// .CurXPTheme, a CursorFX .CursorFX, a Mousecape .cape, a Hyprcursor theme,
// a Windows .cur/.ani pack, an XCursor theme; as a folder or an archive)
// becomes a plain XCursor theme in ~/.local/share/icons, which Settings lists
// and the pointer uses like any other (electron/cursor.mts).
//
// The main process never parses what it imports. It reads the files (capped
// in size and number, never following a link out of a picked folder),
// unpacks .xz and .bz2 with the system's tools (capped too), and hands the
// bytes to the converter, which runs in a sandboxed window
// (cursorConverter.mts, src/lib/cursorImport). What comes back is checked
// field by field: names against what a cursor file may be called, sizes and
// counts against limits, every frame's pixels against its size. Only then
// are the XCursor files written, by Din, into a staging directory that
// takes the theme's place in one rename, with an index.theme marking it as
// Din's so that it can be removed again.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { convertInSandbox } from './cursorConverter.mts';
import { runCommand } from './system.mts';
import { encodeXcursor, type XcursorFrame } from './xcursor.mts';

/** What fills in the cursors an imported theme lacks; DinOS's default. */
export const FALLBACK_THEME = 'capitaine-cursors';

/** The marker in index.theme that Din imported a theme. */
export const IMPORTED_KEY = 'X-Din-Imported';

const MiB = 1024 * 1024;
/** Bytes a picked file, a picked folder, or a decompressed .xz/.bz2 may have. */
const MAX_SOURCE_BYTES = 128 * MiB;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 8;

// Limits on what the converter sends back.
const MAX_THEMES = 16;
const MAX_CURSORS = 400;
const MAX_LINKS = 2_000;
const MAX_FRAMES = 4_096;
const MAX_FRAME_DIMENSION = 512;
const MAX_DELAY = 3_600_000;
const MAX_OUTPUT_BYTES = 256 * MiB;

/** A cursor's file name in a theme. */
const CURSOR_NAME = /^(?!\.)[A-Za-z0-9_.+-]{1,64}$/;
/** A theme name we'll write into Inherits=. */
const INHERIT_NAME = /^(?![-.])[A-Za-z0-9_ .+-]{1,64}$/;

/** What the converter may say went wrong; anything else reads as DAMAGED. */
const DAMAGED = 'The file is damaged or not in a format Din can read.';
const TOO_BIG = 'That is too big to be a cursor theme.';
const CONVERTER_MESSAGES = new Set([
  DAMAGED,
  TOO_BIG,
  'Encrypted archives can’t be imported.',
  'Binary .cape files can’t be imported yet. Export the cape from Mousecape again.',
  'No cursor themes were found in it.',
]);

/** A theme, checked and ready to write. */
interface ImportedTheme {
  name: string;
  inherits: string[];
  /** Cursor name → XCursor file. */
  files: Map<string, Buffer>;
  /** Alias → the cursor name it stands for. */
  links: Map<string, string>;
}

class ImportError extends Error {}

// ---------------------------------------------------------------------------
// Reading what was picked
// ---------------------------------------------------------------------------

interface SourceEntry {
  path: string;
  data?: Uint8Array;
  link?: string;
}

/** Decompress with a system tool, which Node lacks for these formats, stopping past the limit. */
async function decompressWith(tool: 'xz' | 'bzip2', file: string): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'din-cursor-'));
  const out = path.join(dir, 'out');
  try {
    await runCommand(
      'sh',
      ['-c', '"$0" -dc -- "$1" | head -c "$2" > "$3"', tool, file, String(MAX_SOURCE_BYTES + 1), out],
      { timeout: 120_000 },
    );
    const result = await fs.readFile(out);
    if (result.length > MAX_SOURCE_BYTES) throw new ImportError(TOO_BIG);
    return result;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A folder's files and symlinks (kept as links, never followed), within the limits. */
async function readFolder(root: string): Promise<SourceEntry[]> {
  const entries: SourceEntry[] = [];
  let bytes = 0;
  const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entries.length >= MAX_ENTRIES) throw new ImportError(TOO_BIG);
      const full = path.join(dir, entry.name);
      const inside = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, inside, depth + 1);
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: inside, link: await fs.readlink(full) });
      } else if (entry.isFile()) {
        const handle = await fs.open(full, 'r');
        try {
          const { size } = await handle.stat();
          bytes += size;
          if (bytes > MAX_SOURCE_BYTES) throw new ImportError(TOO_BIG);
          entries.push({ path: inside, data: await handle.readFile() });
        } finally {
          await handle.close();
        }
      }
    }
  };
  await walk(root, '', 0);
  return entries;
}

/** A picked file, unpacked from .xz or .bz2 if it is one. */
async function readFile(file: string): Promise<SourceEntry[]> {
  const handle = await fs.open(file, 'r');
  let data: Buffer;
  try {
    if ((await handle.stat()).size > MAX_SOURCE_BYTES) throw new ImportError(TOO_BIG);
    data = await handle.readFile();
  } finally {
    await handle.close();
  }
  const name = path.basename(file);
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return [{ path: `${name}.tar`, data: await decompressWith('xz', file) }];
  if (starts(0x42, 0x5a, 0x68)) return [{ path: `${name}.tar`, data: await decompressWith('bzip2', file) }];
  return [{ path: name, data }];
}

// ---------------------------------------------------------------------------
// Checking what the converter made
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function checkFrame(value: unknown): XcursorFrame {
  if (!isRecord(value)) throw new ImportError(DAMAGED);
  const { size, width, height, hotX, hotY, delay, pixels } = value;
  if (
    !isInt(size, 1, MAX_FRAME_DIMENSION) ||
    !isInt(width, 1, MAX_FRAME_DIMENSION) ||
    !isInt(height, 1, MAX_FRAME_DIMENSION) ||
    !isInt(hotX, 0, width - 1) ||
    !isInt(hotY, 0, height - 1) ||
    !isInt(delay, 0, MAX_DELAY) ||
    !(pixels instanceof Uint8Array) ||
    pixels.length !== width * height * 4
  ) {
    throw new ImportError(DAMAGED);
  }
  return { size, width, height, hotX, hotY, delay, pixels: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length) };
}

/** The converter's answer, every field checked; throws its error, or DAMAGED for anything amiss. */
function checkOutcome(outcome: unknown): ImportedTheme[] {
  if (!isRecord(outcome)) throw new ImportError(DAMAGED);
  if (outcome.ok !== true) {
    const message = typeof outcome.error === 'string' && CONVERTER_MESSAGES.has(outcome.error) ? outcome.error : DAMAGED;
    throw new ImportError(message);
  }
  if (!Array.isArray(outcome.themes) || outcome.themes.length < 1 || outcome.themes.length > MAX_THEMES) {
    throw new ImportError(DAMAGED);
  }
  let total = 0;
  return outcome.themes.map((theme: unknown): ImportedTheme => {
    if (!isRecord(theme) || typeof theme.name !== 'string') throw new ImportError(DAMAGED);
    const { cursors, links, inherits } = theme;
    if (!Array.isArray(cursors) || cursors.length < 1 || cursors.length > MAX_CURSORS) throw new ImportError(DAMAGED);
    if (!Array.isArray(links) || links.length > MAX_LINKS) throw new ImportError(DAMAGED);
    if (!Array.isArray(inherits)) throw new ImportError(DAMAGED);

    const files = new Map<string, Buffer>();
    for (const cursor of cursors) {
      if (!isRecord(cursor) || typeof cursor.name !== 'string' || !CURSOR_NAME.test(cursor.name) || files.has(cursor.name)) {
        throw new ImportError(DAMAGED);
      }
      if (!Array.isArray(cursor.frames) || cursor.frames.length < 1 || cursor.frames.length > MAX_FRAMES) {
        throw new ImportError(DAMAGED);
      }
      const frames = cursor.frames.map(checkFrame);
      total += frames.reduce((sum, f) => sum + f.pixels.length, 0);
      if (total > MAX_OUTPUT_BYTES) throw new ImportError(TOO_BIG);
      files.set(cursor.name, encodeXcursor(frames));
    }

    const aliases = new Map<string, string>();
    for (const link of links) {
      if (!Array.isArray(link) || link.length !== 2) throw new ImportError(DAMAGED);
      const [alias, target] = link as unknown[];
      if (typeof alias !== 'string' || typeof target !== 'string' || !CURSOR_NAME.test(alias)) throw new ImportError(DAMAGED);
      if (!files.has(target) || files.has(alias)) throw new ImportError(DAMAGED);
      aliases.set(alias, target);
    }
    if (!files.has('left_ptr') && !aliases.has('left_ptr')) throw new ImportError(DAMAGED);

    return {
      name: theme.name,
      inherits: inherits.filter((name): name is string => typeof name === 'string' && INHERIT_NAME.test(name)).slice(0, 8),
      files,
      links: aliases,
    };
  });
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/** A name that's safe in index.theme. */
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, 80) || 'Imported cursors';
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
    for (const [name, data] of theme.files) await fs.writeFile(path.join(cursors, name), data, { flag: 'wx' });
    for (const [alias, target] of theme.links) await fs.symlink(target, path.join(cursors, alias));
    const inherits = [...new Set([...theme.inherits, FALLBACK_THEME])].filter((name) => name !== id);
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
  // A Windows pack's install.inf stands for its folder.
  if (/\.inf$/i.test(source)) source = path.dirname(source);
  const stat = await fs.stat(source);
  const entries = stat.isDirectory() ? await readFolder(source) : await readFile(source);

  let outcome: unknown;
  try {
    outcome = await convertInSandbox({ name: path.basename(source), entries });
  } catch (error) {
    throw new ImportError(error instanceof Error ? error.message : DAMAGED);
  }
  const themes = checkOutcome(outcome);

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
