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
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { listEffects, readEffects, removeEffects } from './cursorEffects.mts';
import { settingsOwner } from './desktop-settings.mts';
import { FALLBACK_THEME, IMPORTED_KEY, importCursorThemes } from './cursorImport.mts';
import { runCommand } from './system.mts';
import { decodeXcursor, xcursorSizes } from './xcursor.mts';

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

/** The current theme and size, from GSettings, falling back to DinOS's defaults. */
async function current(): Promise<{ theme: string; size: number }> {
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

async function apply(theme: string, size: number): Promise<void> {
  await gsettings('set', SCHEMA, 'cursor-theme', theme);
  await gsettings('set', SCHEMA, 'cursor-size', String(size));
  exportEnvironment(theme, size);
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

export function registerCursorHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  if (canChange()) {
    void current().then(({ theme, size }) => exportEnvironment(theme, size));
  }

  ipcMain.handle('cursor:status', async (event): Promise<CursorStatus> => {
    assertShellSender(event);
    const { theme, size } = await current();
    return { theme, size, sizes: SIZES, fixedSize: await hasFixedSize(theme), canChange: canChange(), shared: settingsOwner() === 'shared' };
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
