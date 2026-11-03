// The pointer: its theme and size, which Settings → Cursors shows and
// changes, and the themes the user imports (electron/cursorImport.mts).
//
// Chromium on Wayland draws its own cursors (din-shell has no cursor-shape
// protocol), loading them from the XCursor theme GTK names. GTK takes the
// name and size from GSettings (org.gnome.desktop.interface cursor-theme and
// cursor-size), and tells Chromium when they change, so a new theme or size
// shows at once, without a restart. Chromium plays a theme's animated
// cursors itself. Native GTK and Qt apps read the same keys; X11 apps and
// anything else that only knows XCURSOR_THEME and XCURSOR_SIZE get those in
// their environment, from Din's.
//
// Din changes them where GSettings is what the desktop reads: DinOS, and
// GNOME and its kin, where that changes the desktop's pointer too
// (desktop-settings.mts). Elsewhere (KDE) it only shows them.
//
// The pointer grows with the interface zoom, as text does: where Din is the
// desktop, the size the user chose (kept in userData/cursor.json) times the
// zoom is what GSettings, XCURSOR_SIZE and din-shell get, worked out once
// here so Chromium's pointer and din-shell's (Shake to find's) match. Where
// GSettings is the host desktop's too, the zoom is Din's alone and the
// pointer stays the chosen size.
//
// Under din-shell, which draws the pointer on the screen, Din tells it the
// theme, size and whether Shake to find the pointer is on, in
// $XDG_RUNTIME_DIR/din-shell-pointer, which it watches
// (native/din-compositor/src/session/cursor.rs).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { listEffects, readEffects, removeEffects } from './cursorEffects.mts';
import { settingsOwner } from './desktop-settings.mts';
import {
  CURSOR_NAME,
  FALLBACK_THEME,
  IMPORTED_KEY,
  INHERIT_NAME,
  importCursorThemes,
  installCursorTheme,
} from './cursorImport.mts';
import { runCommand } from './system.mts';
import {
  PUBLISHED_KEY,
  SOURCE_KEY,
  checkPackageBase,
  fetchBlobs,
  installId,
  installedFromNostr,
  isSha256,
  PackageError,
  themeKey,
} from './themePackages.mts';
import { decodeXcursor, isXcursor, xcursorSizes } from './xcursor.mts';

/** A published cursor theme's kind (NIP.md). */
const CURSOR_THEME_KIND = 34628;

const SCHEMA = 'org.gnome.desktop.interface';

/** The sizes Settings offers, in XCursor nominal sizes (logical pixels). */
const SIZES = [24, 32, 40, 48, 64, 96];

/** A theme or directory name; it ends up as a gsettings argument and a path segment. */
const THEME_NAME = /^(?![-.])[A-Za-z0-9_ .+-]+$/;

interface CursorTheme {
  /** Directory name, which is what GTK and XCursor call it. */
  id: string;
  /** Human-readable name from index.theme, else the id. */
  name: string;
  /** Whether Din imported it, and so can remove it. */
  imported: boolean;
}

interface CursorStatus {
  theme: string;
  size: number;
  sizes: number[];
  /** Whether the theme has one size only, whatever size is asked for. */
  fixedSize: boolean;
  canChange: boolean;
  /** Whether a change is the desktop's too, Din not being the desktop. */
  shared: boolean;
  /** Whether din-shell draws the pointer, and so can make it big when the mouse is shaken. */
  shellPointer: boolean;
  /** Whether the pointer grows with the interface zoom (where Din is the desktop). */
  followsZoom: boolean;
}

/** One cursor of a theme, as straight (not premultiplied) RGBA. */
interface CursorPreview {
  role: string;
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  rgba: Uint8Array;
}

/** Where imported themes go: the user's own icon themes. */
function importBase(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
  return path.join(data, 'icons');
}

/** Where imported effect packages go: Din's own data, since nothing else plays them. */
function effectsBase(): string {
  return path.join(app.getPath('userData'), 'cursor-effects');
}

/** XCursor's search path, as libXcursor and libwayland-cursor walk it. */
function searchPath(): string[] {
  const home = os.homedir();
  const fromEnv = process.env.XCURSOR_PATH?.split(':').filter(Boolean);
  const dirs = fromEnv?.length
    ? fromEnv
    : [
        path.join(home, '.local/share/icons'),
        path.join(home, '.icons'),
        '/usr/share/icons',
        '/usr/share/pixmaps',
      ];
  return dirs.map((dir) => path.normalize(dir.replace(/^~(?=\/|$)/, home)));
}

/** An icon theme's index.theme, or '' without one. */
async function indexTheme(dir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(dir, 'index.theme'), 'utf8');
  } catch {
    return '';
  }
}

/** Whether `dir` holds a theme Din imported. */
async function isImported(dir: string): Promise<boolean> {
  if (path.dirname(dir) !== importBase()) return false;
  return new RegExp(`^${IMPORTED_KEY}\\s*=\\s*true\\s*$`, 'm').test(await indexTheme(dir));
}

/** Every installed theme with cursors in it, first on the search path winning. */
async function themes(): Promise<CursorTheme[]> {
  const found = new Map<string, CursorTheme>();
  for (const base of searchPath()) {
    let entries: string[];
    try {
      entries = await fs.readdir(base);
    } catch {
      continue;
    }
    for (const id of entries.sort()) {
      if (found.has(id) || id === 'default' || !THEME_NAME.test(id)) continue;
      const dir = path.join(base, id);
      try {
        await fs.access(path.join(dir, 'cursors', 'left_ptr'));
      } catch {
        continue;
      }
      const name = /^Name\s*=\s*(.+)$/m.exec(await indexTheme(dir))?.[1].trim();
      found.set(id, { id, name: name || id.replace(/[-_]+/g, ' '), imported: await isImported(dir) });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The cursors/ directory XCursor would use for a theme. */
async function cursorsDir(id: string): Promise<string | null> {
  for (const base of searchPath()) {
    const candidate = path.join(base, id, 'cursors');
    try {
      await fs.access(path.join(candidate, 'left_ptr'));
      return candidate;
    } catch {
      // not on this part of the path
    }
  }
  return null;
}

/** Whether a new import may not be called `id`: another theme by that name would clash. */
async function taken(id: string): Promise<boolean> {
  const own = path.join(importBase(), id);
  for (const base of new Set([...searchPath(), importBase()])) {
    const dir = path.join(base, id);
    try {
      await fs.lstat(dir);
    } catch {
      continue;
    }
    if (dir !== own || !(await isImported(dir))) return true;
  }
  return false;
}

async function gsettings(...args: string[]): Promise<string> {
  return (await runCommand('gsettings', args, { timeout: 3_000 })).stdout.trim();
}

/** The theme and size GSettings has now, falling back to DinOS's defaults. */
async function system(): Promise<{ theme: string; size: number }> {
  let theme = FALLBACK_THEME;
  let size = 40;
  try {
    const [rawTheme, rawSize] = await Promise.all([
      gsettings('get', SCHEMA, 'cursor-theme'),
      gsettings('get', SCHEMA, 'cursor-size'),
    ]);
    theme = rawTheme.replace(/^'(.*)'$/, '$1') || theme;
    size = Number.parseInt(rawSize.replace(/^\D+/, ''), 10) || size;
  } catch {
    // no gsettings here
  }
  return { theme, size };
}

/** The size the user chose and the zoom it's drawn at, as kept in userData. */
interface Chosen {
  size: number;
  scale: number;
}

function chosenPath(): string {
  return path.join(app.getPath('userData'), 'cursor.json');
}

let chosen: Chosen | null = null;

/** The size the user chose, and the zoom last applied; at first, GSettings' size at 1. */
async function readChosen(): Promise<Chosen> {
  if (chosen) return chosen;
  try {
    const data = JSON.parse(await fs.readFile(chosenPath(), 'utf8')) as Partial<Chosen>;
    if (typeof data.size === 'number' && data.size > 0) {
      chosen = { size: data.size, scale: typeof data.scale === 'number' && data.scale > 0 ? data.scale : 1 };
      return chosen;
    }
  } catch {
    // not yet kept
  }
  chosen = { size: (await system()).size, scale: 1 };
  return chosen;
}

async function writeChosen(next: Chosen): Promise<void> {
  chosen = next;
  try {
    await fs.writeFile(chosenPath(), JSON.stringify(next));
  } catch (error) {
    console.warn('Could not keep the cursor size:', error);
  }
}

/** The zoom the pointer's drawn at: Din's, where Din is the desktop. */
function effectiveScale(scale: number): number {
  return settingsOwner() === 'din' ? scale : 1;
}

/** The size drawn for SIZE at SCALE, the same for Chromium, apps and din-shell. */
function drawnSize(size: number, scale: number): number {
  return Math.max(1, Math.round(size * effectiveScale(scale)));
}

/** The theme, and the size the user chose (not the zoomed one GSettings has). */
async function current(): Promise<{ theme: string; size: number }> {
  const [{ theme }, { size }] = await Promise.all([system(), readChosen()]);
  return { theme, size };
}

/** The theme, and the size it's drawn at. */
async function drawn(): Promise<{ theme: string; size: number }> {
  const [{ theme }, { size, scale }] = await Promise.all([system(), readChosen()]);
  return { theme, size: drawnSize(size, scale) };
}

/** Whether a theme's arrow comes in one size only. */
async function hasFixedSize(id: string): Promise<boolean> {
  const dir = await cursorsDir(id);
  if (!dir) return false;
  try {
    return xcursorSizes(await fs.readFile(path.join(dir, 'left_ptr'))).length === 1;
  } catch {
    return false;
  }
}

function canChange(): boolean {
  return settingsOwner() !== 'other';
}

/** Tell what Din starts from now on (Terminal, native apps) about the cursor. */
function exportEnvironment(theme: string, size: number): void {
  process.env.XCURSOR_THEME = theme;
  process.env.XCURSOR_SIZE = String(size);
}

/** Make THEME the pointer's at the chosen SIZE, drawn at the zoom. */
async function apply(theme: string, size: number): Promise<void> {
  const { scale } = await readChosen();
  await writeChosen({ size, scale });
  const px = drawnSize(size, scale);
  await gsettings('set', SCHEMA, 'cursor-theme', theme);
  await gsettings('set', SCHEMA, 'cursor-size', String(px));
  exportEnvironment(theme, px);
  void tellShell();
}

/** Draw the pointer at a new zoom, if that changes its size. */
async function setScale(scale: number): Promise<void> {
  const { size, scale: before } = await readChosen();
  if (scale === before) return;
  await writeChosen({ size, scale });
  const px = drawnSize(size, scale);
  if (px === (await system()).size) return;
  await gsettings('set', SCHEMA, 'cursor-size', String(px));
  exportEnvironment((await system()).theme, px);
  void tellShell();
}

// ---------------------------------------------------------------------------
// din-shell
// ---------------------------------------------------------------------------

/** Whether Din is on din-shell, which names its Wayland socket so (session/mod.rs). */
const onShell = process.env.WAYLAND_DISPLAY === 'din-shell' && !!process.env.XDG_RUNTIME_DIR;

let shakeToFind = false;

/** Tell din-shell the pointer's theme and size and whether a shake makes it big. */
async function tellShell(): Promise<void> {
  if (!onShell) return;
  const { theme, size } = await drawn();
  const file = path.join(process.env.XDG_RUNTIME_DIR!, 'din-shell-pointer');
  const temp = `${file}.${process.pid}`;
  try {
    // Renamed into place, so din-shell never reads half of it.
    await fs.writeFile(temp, `theme=${theme}\nsize=${size}\nshake-to-find=${shakeToFind ? 1 : 0}\n`);
    await fs.rename(temp, file);
  } catch (error) {
    console.warn('Could not tell din-shell about the pointer:', error);
  }
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

/** The file names each previewed role goes by, newest naming first. */
const PREVIEW_ROLES: { role: string; names: string[] }[] = [
  { role: 'default', names: ['default', 'left_ptr'] },
  { role: 'pointer', names: ['pointer', 'hand2', 'pointing_hand', 'hand1'] },
  { role: 'text', names: ['text', 'xterm', 'ibeam'] },
  { role: 'nwse-resize', names: ['nwse-resize', 'size_fdiag', 'bottom_right_corner'] },
];

/**
 * The pointer's arrow as the theme draws it at the current size, and that
 * size (logical pixels), for Studio to draw into its picture.
 */
export async function pointerArrow(): Promise<(CursorPreview & { size: number }) | null> {
  const { theme, size } = await drawn();
  const arrow = (await previews(theme, size)).find((p) => p.role === 'default');
  return arrow ? { ...arrow, size } : null;
}

async function previews(id: string, size: number): Promise<CursorPreview[]> {
  const dir = await cursorsDir(id);
  if (!dir) return [];

  const result: CursorPreview[] = [];
  for (const { role, names } of PREVIEW_ROLES) {
    for (const name of names) {
      let data: Buffer;
      try {
        data = await fs.readFile(path.join(dir, name));
      } catch {
        continue;
      }
      const image = decodeXcursor(data, size);
      if (image) {
        result.push({ role, ...image });
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Publishing and installing from Nostr (themePackages.mts)
// ---------------------------------------------------------------------------

/** A theme's cursors as they're published: one XCursor file per cursor, the rest aliases. */
interface CursorExport {
  id: string;
  name: string;
  inherits: string[];
  files: { name: string; data: Uint8Array }[];
  links: [alias: string, target: string][];
}

async function exportTheme(id: string): Promise<CursorExport> {
  const dir = await cursorsDir(id);
  if (!dir) throw new Error('Not a cursor theme');
  const index = await indexTheme(path.dirname(dir));

  // Names that are the same file, whether by a link in the theme or into a
  // package store, are published once, the rest as aliases of it.
  const groups = new Map<string, { names: string[]; own: string | null }>();
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!CURSOR_NAME.test(name)) continue;
    const full = path.join(dir, name);
    let real: string;
    try {
      real = await fs.realpath(full);
      if (!(await fs.stat(real)).isFile()) continue;
    } catch {
      continue;
    }
    const group = groups.get(real) ?? { names: [], own: null };
    group.names.push(name);
    if (!group.own && !(await fs.lstat(full)).isSymbolicLink()) group.own = name;
    groups.set(real, group);
  }

  const files: CursorExport['files'] = [];
  const links: CursorExport['links'] = [];
  for (const [real, group] of groups) {
    const data = await fs.readFile(real);
    if (!isXcursor(data)) continue;
    const main = group.own ?? group.names[0];
    files.push({ name: main, data });
    for (const name of group.names) if (name !== main) links.push([name, main]);
  }
  if (!files.length) throw new Error('This theme has no cursors Din can read');

  const inherits = (themeKey(index, 'Inherits') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => INHERIT_NAME.test(name) && name !== id);
  return { id, name: themeKey(index, 'Name') || id, inherits, files, links };
}

/** Whether anything on the search path, or in the import directory, is called `id`. */
async function exists(id: string): Promise<boolean> {
  for (const base of new Set([...searchPath(), importBase()])) {
    try {
      await fs.lstat(path.join(base, id));
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/** Download a published theme's cursors and install it; resolves with its directory name. */
async function installPublished(manifest: unknown): Promise<string> {
  const pkg = checkPackageBase(manifest, CURSOR_THEME_KIND, INHERIT_NAME);
  const cursors = Array.isArray(pkg.cursors) ? pkg.cursors : [];
  const rawLinks = Array.isArray(pkg.links) ? pkg.links : [];
  const wanted = new Map<string, string>();
  for (const cursor of cursors) {
    const { name, sha256 } = (cursor ?? {}) as { name?: unknown; sha256?: unknown };
    if (typeof name !== 'string' || !CURSOR_NAME.test(name) || !isSha256(sha256) || wanted.has(name)) {
      throw new PackageError('Not a cursor theme');
    }
    wanted.set(name, sha256);
  }
  if (!wanted.size) throw new PackageError('Not a cursor theme');

  const links = new Map<string, string>();
  for (const link of rawLinks) {
    if (!Array.isArray(link)) continue;
    const [alias, target] = link as unknown[];
    if (typeof alias !== 'string' || typeof target !== 'string' || !CURSOR_NAME.test(alias)) continue;
    if (!wanted.has(target) || wanted.has(alias)) continue;
    links.set(alias, target);
  }
  if (!wanted.has('left_ptr') && !links.has('left_ptr')) throw new PackageError('This theme has no arrow cursor.');

  const blobs = await fetchBlobs([...wanted.values()], pkg.servers);
  const files = new Map<string, Buffer>();
  for (const [name, hash] of wanted) {
    const data = blobs.get(hash);
    if (!data || !isXcursor(data)) throw new PackageError(`The theme’s ${name} cursor is damaged.`);
    files.set(name, data);
  }

  const base = importBase();
  const id = await installId(base, CURSOR_THEME_KIND, pkg, THEME_NAME, exists);
  await installCursorTheme({ name: pkg.name, inherits: pkg.inherits, files, links }, base, id, {
    [SOURCE_KEY]: pkg.coordinate,
    [PUBLISHED_KEY]: String(pkg.publishedAt),
  });
  return id;
}

// ---------------------------------------------------------------------------

export function registerCursorHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  if (canChange()) {
    void drawn().then(({ theme, size }) => exportEnvironment(theme, size));
  }

  ipcMain.handle('cursor:status', async (event): Promise<CursorStatus> => {
    assertShellSender(event);
    const { theme, size } = await current();
    return {
      theme,
      size,
      followsZoom: settingsOwner() === 'din',
      sizes: SIZES,
      fixedSize: await hasFixedSize(theme),
      canChange: canChange(),
      shared: settingsOwner() === 'shared',
      shellPointer: onShell,
    };
  });

  ipcMain.handle('cursor:shake-to-find', async (event, on: unknown) => {
    assertShellSender(event);
    if (typeof on !== 'boolean') throw new Error('Not a boolean');
    if (on === shakeToFind) return;
    shakeToFind = on;
    await tellShell();
  });

  ipcMain.handle('cursor:scale', async (event, scale: unknown) => {
    assertShellSender(event);
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 2) throw new Error('Not a zoom');
    if (!canChange()) return;
    await setScale(scale);
  });

  ipcMain.handle('cursor:themes', async (event) => {
    assertShellSender(event);
    return themes();
  });

  ipcMain.handle('cursor:preview', async (event, id: unknown, size: unknown) => {
    assertShellSender(event);
    if (typeof id !== 'string' || !THEME_NAME.test(id)) throw new Error('Not a cursor theme');
    return previews(id, typeof size === 'number' && size > 0 && size <= 256 ? size : 48);
  });

  ipcMain.handle('cursor:set', async (event, choice: unknown) => {
    assertShellSender(event);
    if (!canChange()) throw new Error('Din can\'t change the cursor on this system');
    const { theme, size } = (choice ?? {}) as { theme?: unknown; size?: unknown };
    if (typeof theme !== 'string' || !(await themes()).some((t) => t.id === theme)) {
      throw new Error('Unknown cursor theme');
    }
    if (typeof size !== 'number' || !SIZES.includes(size)) throw new Error('Unsupported cursor size');
    await apply(theme, size);
  });

  // Import the themes and effect packages in a file or folder, and make the
  // first theme the pointer's.
  ipcMain.handle('cursor:import', async (event, source: unknown): Promise<{ themes: string[]; effects: string[] }> => {
    assertShellSender(event);
    if (!canChange()) throw new Error('Din can\'t change the cursor on this system');
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Choose a file to import');
    const ids = await importCursorThemes(path.normalize(source), { base: importBase(), effectsBase: effectsBase(), taken });
    if (ids.themes.length) {
      const { theme, size } = await current();
      // The same name again (a theme imported anew) isn't a change GTK passes
      // on, so the old cursors would stay; go through another theme first.
      if (theme === ids.themes[0]) await apply(FALLBACK_THEME, size);
      await apply(ids.themes[0], size);
    }
    return ids;
  });

  // A theme's cursor files and aliases, for publishing it.
  ipcMain.handle('cursor:export', async (event, id: unknown) => {
    assertShellSender(event);
    if (typeof id !== 'string' || !THEME_NAME.test(id)) throw new Error('Not a cursor theme');
    return exportTheme(id);
  });

  // The themes installed from Nostr, with where each was published.
  ipcMain.handle('cursor:published', async (event) => {
    assertShellSender(event);
    return installedFromNostr(importBase(), CURSOR_THEME_KIND);
  });

  // Install (or update) a theme someone published; resolves with its id.
  ipcMain.handle('cursor:install-published', async (event, manifest: unknown) => {
    assertShellSender(event);
    if (!canChange()) throw new Error('Din can\'t change the cursor on this system');
    const id = await installPublished(manifest);
    // A theme updated in place keeps its name, which GTK doesn't pass on as
    // a change; go through another theme so the new cursors show.
    const { theme, size } = await current();
    if (theme === id) {
      await apply(FALLBACK_THEME, size);
      await apply(id, size);
    }
    return id;
  });

  // Effect packages, for the cursor effects Din plays. Listing and playing
  // them works wherever Din runs; only importing needs DinOS.
  ipcMain.handle('cursor:effects', async (event) => {
    assertShellSender(event);
    return listEffects(effectsBase());
  });

  ipcMain.handle('cursor:effect', async (event, id: unknown) => {
    assertShellSender(event);
    if (typeof id !== 'string') throw new Error('Not a cursor effect');
    return readEffects(effectsBase(), id);
  });

  ipcMain.handle('cursor:remove-effect', async (event, id: unknown) => {
    assertShellSender(event);
    if (typeof id !== 'string') throw new Error('Not a cursor effect');
    await removeEffects(effectsBase(), id);
  });

  ipcMain.handle('cursor:remove', async (event, id: unknown) => {
    assertShellSender(event);
    if (!canChange()) throw new Error('Din can\'t change the cursor on this system');
    if (typeof id !== 'string' || !THEME_NAME.test(id)) throw new Error('Not a cursor theme');
    const dir = path.join(importBase(), id);
    if (!(await isImported(dir))) throw new Error('Only cursors imported into Din can be removed');
    const { theme, size } = await current();
    if (theme === id) {
      const others = (await themes()).filter((t) => t.id !== id);
      const next = others.find((t) => t.id === FALLBACK_THEME) ?? others[0];
      if (next) await apply(next.id, size);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
}
