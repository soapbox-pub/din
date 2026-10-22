// The pointer: its theme and size, which Settings → Appearance shows and
// changes.
//
// Chromium on Wayland draws its own cursors (cage has no cursor-shape
// protocol), loading them from the XCursor theme GTK names. GTK takes the
// name and size from GSettings (org.gnome.desktop.interface cursor-theme and
// cursor-size), and tells Chromium when they change, so a new theme or size
// shows at once, without a restart. Native GTK and Qt apps read the same
// keys; X11 apps and anything else that only knows XCURSOR_THEME and
// XCURSOR_SIZE get those in their environment, from Din's.
//
// Din only changes them where it is the desktop (DinOS, DIN_DESKTOP_SESSION);
// on GNOME and the like they're the desktop's settings, not Din's.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { runCommand } from './system.mts';

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
}

interface CursorStatus {
  theme: string;
  size: number;
  sizes: number[];
  canChange: boolean;
}

/** One cursor of a theme, as straight (not premultiplied) RGBA. */
interface CursorPreview {
  role: string;
  width: number;
  height: number;
  rgba: Uint8Array;
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
  return dirs.map((dir) => dir.replace(/^~(?=\/|$)/, home));
}

/** The Name= of an icon theme's index.theme, if it has one. */
async function themeName(dir: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(dir, 'index.theme'), 'utf8');
    return /^Name\s*=\s*(.+)$/m.exec(text)?.[1].trim() || null;
  } catch {
    return null;
  }
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
      found.set(id, { id, name: (await themeName(dir)) ?? id.replace(/[-_]+/g, ' ') });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function gsettings(...args: string[]): Promise<string> {
  return (await runCommand('gsettings', args, { timeout: 3_000 })).stdout.trim();
}

/** The current theme and size, from GSettings, falling back to DinOS's defaults. */
async function current(): Promise<{ theme: string; size: number }> {
  let theme = 'capitaine-cursors';
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

function canChange(): boolean {
  return process.env.DIN_DESKTOP_SESSION === '1';
}

/** Tell what Din starts from now on (Terminal, native apps) about the cursor. */
function exportEnvironment(theme: string, size: number): void {
  process.env.XCURSOR_THEME = theme;
  process.env.XCURSOR_SIZE = String(size);
}

// ---------------------------------------------------------------------------
// Previews: XCursor files decoded to RGBA
// ---------------------------------------------------------------------------

const XCURSOR_IMAGE = 0xfffd0002;

/** The file names each previewed role goes by, newest naming first. */
const PREVIEW_ROLES: { role: string; names: string[] }[] = [
  { role: 'default', names: ['default', 'left_ptr'] },
  { role: 'pointer', names: ['pointer', 'hand2', 'pointing_hand', 'hand1'] },
  { role: 'text', names: ['text', 'xterm', 'ibeam'] },
  { role: 'nwse-resize', names: ['nwse-resize', 'size_fdiag', 'bottom_right_corner'] },
];

/** The first image of an XCursor file nearest `want` in nominal size. */
function decodeXcursor(data: Buffer, want: number): Omit<CursorPreview, 'role'> | null {
  if (data.length < 16 || data.toString('latin1', 0, 4) !== 'Xcur') return null;
  const headerSize = data.readUInt32LE(4);
  const count = data.readUInt32LE(12);
  let best: { size: number; position: number } | null = null;
  for (let i = 0; i < count; i++) {
    const entry = headerSize + i * 12;
    if (entry + 12 > data.length) break;
    if (data.readUInt32LE(entry) !== XCURSOR_IMAGE) continue;
    const size = data.readUInt32LE(entry + 4);
    const position = data.readUInt32LE(entry + 8);
    if (!best || Math.abs(size - want) < Math.abs(best.size - want)) best = { size, position };
  }
  if (!best || best.position + 36 > data.length) return null;
  const width = data.readUInt32LE(best.position + 16);
  const height = data.readUInt32LE(best.position + 20);
  const pixels = best.position + 36;
  if (width === 0 || height === 0 || width > 512 || height > 512) return null;
  if (pixels + width * height * 4 > data.length) return null;

  // Premultiplied ARGB, one little-endian word per pixel.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const argb = data.readUInt32LE(pixels + i * 4);
    const a = argb >>> 24;
    const unpremultiply = (c: number) => (a === 0 ? 0 : Math.min(255, Math.round((c * 255) / a)));
    rgba[i * 4] = unpremultiply((argb >>> 16) & 0xff);
    rgba[i * 4 + 1] = unpremultiply((argb >>> 8) & 0xff);
    rgba[i * 4 + 2] = unpremultiply(argb & 0xff);
    rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

async function previews(id: string, size: number): Promise<CursorPreview[]> {
  let dir: string | null = null;
  for (const base of searchPath()) {
    const candidate = path.join(base, id, 'cursors');
    try {
      await fs.access(path.join(candidate, 'left_ptr'));
      dir = candidate;
      break;
    } catch {
      // not on this part of the path
    }
  }
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
    return { ...(await current()), sizes: SIZES, canChange: canChange() };
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
    await gsettings('set', SCHEMA, 'cursor-theme', theme);
    await gsettings('set', SCHEMA, 'cursor-size', String(size));
    exportEnvironment(theme, size);
  });
}
