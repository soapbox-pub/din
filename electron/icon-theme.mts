// Icon themes, per the freedesktop Icon Theme spec: the session's theme,
// which native apps' icons, tray items and notifications come from, and
// which Settings → Appearance shows and changes.
//
// GTK takes the theme from GSettings (org.gnome.desktop.interface
// icon-theme), so that's where Din reads and writes it. Din's own icons
// (its apps in the Dock, the Files app's file types) follow it as well,
// except under the "Din" theme (os/configuration.nix), which stands for
// Din's own look: there Din keeps its bundled icons and native apps fall
// through to Adwaita.
//
// Din follows the theme wherever it runs, and changes it where GSettings
// is what the desktop reads: DinOS, and GNOME and its kin, where that
// changes the desktop's icons too (desktop-settings.mts). Elsewhere (KDE)
// it only reads it, from GTK's settings files, which KDE keeps in step with
// its own; GSettings there usually holds nothing but a default.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, nativeImage } from 'electron';
import { settingsOwner } from './desktop-settings.mts';
import { runCommand } from './system.mts';

const SCHEMA = 'org.gnome.desktop.interface';

/** The theme that stands for Din's own icons. */
const DIN_THEME = 'Din';

/** A theme's directory name; it ends up as a gsettings argument and a path segment. */
const THEME_NAME = /^(?![-.])[A-Za-z0-9_ .+-]+$/;

/** An icon name, as Din asks for them. */
const ICON_NAME = /^[A-Za-z0-9_.+-]{1,160}$/;

/** Icon size Din renders at, in the launcher and Dock (logical px, 2x). */
const TARGET_ICON_SIZE = 96;
/** Cap on an inlined icon; larger PNGs are downscaled before encoding. */
const MAX_ICON_BYTES = 128 * 1024;
/**
 * Cap on an inlined SVG, which can't be downscaled. Some apps' only icon is
 * a detailed SVG of most of a megabyte (HandBrake's); it's encoded once.
 */
const MAX_SVG_BYTES = 1024 * 1024;

/** Extensions Din can inline, best first (SVG scales; XPM can't be rendered). */
const ICON_EXTENSIONS = ['.svg', '.png'];

/** Contexts Din's lookups search, by what the icon is for. */
type IconKind = 'apps' | 'files';
const CONTEXTS: Record<IconKind, readonly string[]> = {
  apps: ['Applications', 'Apps'],
  files: ['MimeTypes', 'Places', 'Devices', 'Mimetypes'],
};

interface IconTheme {
  /** Directory name, which is what GTK calls it. */
  id: string;
  /** Human-readable name from index.theme, else the id. */
  name: string;
  /** A few of its icons as data URLs; empty for the Din theme, whose look is Din's bundled icons. */
  preview: string[];
}

interface IconThemeStatus {
  theme: string;
  /** Whether the theme is Din's own icons rather than a system theme's. */
  din: boolean;
  canChange: boolean;
  /** Whether a change is the desktop's too, Din not being the desktop. */
  shared: boolean;
}

/** `$XDG_DATA_HOME`, per the base-directory spec. */
function dataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
}

/** `$XDG_DATA_DIRS`, per the base-directory spec. */
function dataDirs(): string[] {
  const raw = process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share';
  return raw.split(':').filter(Boolean);
}

/** Roots that can contain icon themes, most specific first. */
function iconRoots(): string[] {
  return [
    ...new Set([
      path.join(dataHome(), 'icons'),
      path.join(os.homedir(), '.icons'),
      ...dataDirs().map((dir) => path.join(dir, 'icons')),
      path.join(dataHome(), 'flatpak/exports/share/icons'),
      '/var/lib/flatpak/exports/share/icons',
    ]),
  ];
}

/** Flat directories of loose icons, searched after the themes. */
function pixmapDirs(): string[] {
  return [...new Set(dataDirs().map((dir) => path.join(dir, 'pixmaps')))];
}

/** Yield to the event loop; the main process is also the shell's input router. */
function breathe(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function canChange(): boolean {
  return settingsOwner() !== 'other';
}

// ---------------------------------------------------------------------------
// The session's theme
// ---------------------------------------------------------------------------

async function gsettings(...args: string[]): Promise<string> {
  return (await runCommand('gsettings', args, { timeout: 3_000 })).stdout.trim();
}

/** The theme GTK's settings files name, for a session without gsettings. */
function settingsFileTheme(): string | null {
  const files = [
    path.join(os.homedir(), '.config/gtk-4.0/settings.ini'),
    path.join(os.homedir(), '.config/gtk-3.0/settings.ini'),
    path.join(os.homedir(), '.gtkrc-2.0'),
  ];
  for (const file of files) {
    try {
      const match = /^\s*gtk-icon-theme-name\s*=\s*"?([^"\n]+?)"?\s*$/m.exec(fs.readFileSync(file, 'utf8'));
      if (match) return match[1];
    } catch {
      // Not present; try the next one.
    }
  }
  return null;
}

let themeRead: Promise<string> | null = null;

/**
 * The session's icon theme: GSettings', else GTK's settings files', else
 * hicolor. On a desktop that doesn't keep it in GSettings, the files first.
 */
export function currentIconTheme(): Promise<string> {
  const fromFile = settingsOwner() === 'other' ? settingsFileTheme() : null;
  themeRead ??= fromFile
    ? Promise.resolve(fromFile)
    : gsettings('get', SCHEMA, 'icon-theme')
        .then((raw) => raw.replace(/^'(.*)'$/, '$1'))
        .catch(() => '')
        .then((theme) => theme || settingsFileTheme() || 'hicolor');
  return themeRead;
}

// ---------------------------------------------------------------------------
// Themes on disk
// ---------------------------------------------------------------------------

/** An index.theme's subdirectory, with what the spec needs to rank it. */
interface ThemeDir {
  name: string;
  size: number;
  scale: number;
  context: string;
  /** Scalable directories hold SVGs that look right at any size. */
  scalable: boolean;
}

interface ParsedTheme {
  name: string | null;
  hidden: boolean;
  dirs: ThemeDir[];
  inherits: string[];
}

/** Parse a theme's index.theme into its directory list and parent themes. */
function parseIndexTheme(file: string): ParsedTheme | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const groups = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line.length === 0) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = new Map();
      groups.set(line.slice(1, -1), current);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || !current) continue;
    current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  const head = groups.get('Icon Theme');
  if (!head) return null;
  const names = [head.get('Directories'), head.get('ScaledDirectories')]
    .filter((v): v is string => Boolean(v))
    .flatMap((v) => v.split(',').map((s) => s.trim()))
    .filter(Boolean);

  const dirs: ThemeDir[] = [];
  for (const name of names) {
    const group = groups.get(name);
    if (!group) continue;
    dirs.push({
      name,
      size: Number(group.get('Size') ?? 0) || 0,
      scale: Number(group.get('Scale') ?? 1) || 1,
      context: group.get('Context') ?? '',
      scalable: (group.get('Type') ?? 'Threshold') === 'Scalable',
    });
  }
  return {
    name: head.get('Name') ?? null,
    hidden: head.get('Hidden') === 'true',
    dirs,
    inherits: (head.get('Inherits') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/** A theme's index.theme, from the first root that has one. */
function themeIndex(theme: string): ParsedTheme | null {
  for (const root of iconRoots()) {
    const parsed = parseIndexTheme(path.join(root, theme, 'index.theme'));
    if (parsed) return parsed;
  }
  return null;
}

/**
 * A theme's directories, as every copy of its index.theme lists them (a
 * user override plus the system copy), each to be searched under every
 * root. A root needn't have an index.theme of its own: Nix profiles and
 * the like install apps' icons into a bare hicolor/<size>/apps.
 */
function themeDirs(theme: string): { dir: ThemeDir; roots: string[] }[] {
  const roots = iconRoots();
  const dirs: ThemeDir[] = [];
  for (const root of roots) {
    for (const dir of parseIndexTheme(path.join(root, theme, 'index.theme'))?.dirs ?? []) {
      if (!dirs.some((d) => d.name === dir.name)) dirs.push(dir);
    }
  }
  return dirs.map((dir) => ({ dir, roots }));
}

/**
 * Rank a theme directory: lower sorts first.
 *
 * Icons are wanted at roughly the size Din renders them, in the context
 * they're for. Scalable directories win outright (one SVG beats any raster
 * size), then unscaled raster directories by distance from the target, with
 * too-small icons penalized harder than too-large ones - upscaling a 16px
 * icon into a Dock tile looks far worse than downscaling a 256px one.
 */
function rankThemeDir(dir: ThemeDir, contexts: readonly string[]): number {
  const contextPenalty = contexts.includes(dir.context) ? 0 : 1000;
  const scalePenalty = (dir.scale - 1) * 500;
  if (dir.scalable) return contextPenalty + scalePenalty;
  const distance =
    dir.size >= TARGET_ICON_SIZE
      ? dir.size - TARGET_ICON_SIZE
      : (TARGET_ICON_SIZE - dir.size) * 4;
  return contextPenalty + scalePenalty + 1 + distance;
}

/** A theme and the themes it inherits from, depth-first. */
function themeChain(theme: string): string[] {
  const chain: string[] = [];
  const visit = (name: string, depth: number): void => {
    if (chain.includes(name) || depth > 8) return;
    chain.push(name);
    for (const parent of themeIndex(name)?.inherits ?? []) visit(parent, depth + 1);
  };
  visit(theme, 0);
  return chain;
}

/** Every installed icon theme a user would pick, first on the search path winning. */
function installedThemes(): { id: string; name: string }[] {
  const found = new Map<string, { id: string; name: string }>();
  for (const root of iconRoots()) {
    let ids: string[];
    try {
      ids = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (found.has(id) || id === 'default' || id === 'hicolor' || id === 'locolor' || !THEME_NAME.test(id)) continue;
      const parsed = parseIndexTheme(path.join(root, id, 'index.theme'));
      // Cursor themes have an index.theme too, but no icon directories.
      if (!parsed || parsed.hidden || parsed.dirs.length === 0) continue;
      found.set(id, { id, name: parsed.name || id.replace(/[-_]+/g, ' ') });
    }
  }
  return [...found.values()].sort((a, b) =>
    a.id === DIN_THEME ? -1 : b.id === DIN_THEME ? 1 : a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Data URLs
// ---------------------------------------------------------------------------

/** icon path -> data URL, so shared icons are encoded once. */
const iconDataUrls = new Map<string, string | null>();

/**
 * Inline an icon file as a data: URL. The shell's CSP allows `img-src
 * data:`, and a custom scheme for icons would mean widening it.
 *
 * Oversized PNGs are downscaled through nativeImage first - a handful of
 * apps ship 512px icons, and shipping those verbatim would put megabytes of
 * base64 through IPC for something rendered at 48px.
 */
function iconDataUrl(file: string): string | null {
  const cached = iconDataUrls.get(file);
  if (cached !== undefined) return cached;

  let url: string | null;
  try {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.svg') {
      const data = fs.readFileSync(file);
      url =
        data.length <= MAX_SVG_BYTES
          ? `data:image/svg+xml;base64,${data.toString('base64')}`
          : null;
    } else {
      let data: Uint8Array = fs.readFileSync(file);
      if (data.length > MAX_ICON_BYTES) {
        const image = nativeImage
          .createFromPath(file)
          .resize({ width: TARGET_ICON_SIZE, height: TARGET_ICON_SIZE, quality: 'good' });
        data = image.isEmpty() ? new Uint8Array(0) : image.toPNG();
      }
      url =
        data.length > 0 && data.length <= MAX_ICON_BYTES
          ? `data:image/png;base64,${Buffer.from(data).toString('base64')}`
          : null;
    }
  } catch {
    url = null;
  }
  iconDataUrls.set(file, url);
  return url;
}

// ---------------------------------------------------------------------------
// Native apps' icons
//
// The icon-theme spec's lookup is "find the file named <Icon> in the
// best-matching directory of the current theme, then its parents, then
// hicolor". For native apps Din does it once, in bulk: the ranked directory
// list is walked and indexed into a name -> path map, so 200 apps cost one
// pass over a few dozen directories instead of thousands of stat() probes.
// ---------------------------------------------------------------------------

/** name -> icon file path, built once per theme. */
let iconIndex: Map<string, string> = new Map();
/** In-flight index build, so concurrent callers share one pass. */
let iconIndexBuild: Promise<Map<string, string>> | null = null;
/** Bumped when the theme changes, so a build of the old one is dropped. */
let iconIndexGeneration = 0;

/** Drop the index, for new icons (an install) or a new theme. */
export function forgetIconIndex(): void {
  iconIndexGeneration += 1;
  iconIndex = new Map();
  iconIndexBuild = null;
}

/** Build (once) the icon-name index over the whole theme chain. */
function buildIconIndex(): Promise<Map<string, string>> {
  if (iconIndex.size > 0) return Promise.resolve(iconIndex);
  iconIndexBuild ??= indexIcons();
  return iconIndexBuild;
}

async function indexIcons(): Promise<Map<string, string>> {
  const generation = iconIndexGeneration;
  const index = new Map<string, string>();

  /** Record every usable icon in a directory, without overwriting a better hit. */
  const indexDir = (dir: string): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory()) continue;
      const ext = path.extname(dirent.name).toLowerCase();
      if (!ICON_EXTENSIONS.includes(ext)) continue;
      const name = dirent.name.slice(0, -ext.length);
      if (!index.has(name)) index.set(name, path.join(dir, dirent.name));
    }
  };

  // Every theme ends in hicolor, where apps install their own icons, with
  // Adwaita before it for the generic ones.
  const chain = [...new Set([...themeChain(await currentIconTheme()), 'Adwaita', 'hicolor'])];
  for (const theme of chain) {
    const dirs = themeDirs(theme).sort(
      (a, b) => rankThemeDir(a.dir, CONTEXTS.apps) - rankThemeDir(b.dir, CONTEXTS.apps),
    );
    for (const { dir, roots } of dirs) {
      for (const root of roots) indexDir(path.join(root, theme, dir.name));
      await breathe();
    }
  }
  for (const dir of pixmapDirs()) indexDir(dir);

  if (generation !== iconIndexGeneration) return index;
  iconIndex = index;
  iconIndexBuild = null;
  return index;
}

/**
 * Resolve an icon name (or absolute path), as desktop entries and tray items
 * give them, to a data URL, or null.
 */
export async function resolveIcon(iconName: string | null): Promise<string | null> {
  if (!iconName) return null;
  // An absolute path is used as-is, per the spec.
  if (iconName.startsWith('/')) {
    return fs.existsSync(iconName) ? iconDataUrl(iconName) : null;
  }
  // Some entries carry a filename ("foo.png") rather than an icon name.
  const bare = ICON_EXTENSIONS.includes(path.extname(iconName).toLowerCase())
    ? iconName.slice(0, -path.extname(iconName).length)
    : iconName;
  const file = (await buildIconIndex()).get(bare);
  return file ? iconDataUrl(file) : null;
}

// ---------------------------------------------------------------------------
// Din's own icons
//
// Din asks for a few dozen names (its apps' standard equivalents, file
// types) by probing a theme's directories for the context they belong to.
// Only the theme and the themes it names as parents count: falling through
// to hicolor would swap Din's icon for whatever app happens to be installed
// under that name, which isn't the theme's look.
// ---------------------------------------------------------------------------

/** Find the first of `names` a theme (or a parent) has, as a file path. */
function findIcon(chain: string[], names: string[], kind: IconKind): string | null {
  const contexts = CONTEXTS[kind];
  for (const theme of chain) {
    const dirs = themeDirs(theme)
      .filter(({ dir }) => contexts.includes(dir.context))
      .sort((a, b) => rankThemeDir(a.dir, contexts) - rankThemeDir(b.dir, contexts));
    for (const name of names) {
      for (const { dir, roots } of dirs) {
        for (const root of roots) {
          for (const ext of ICON_EXTENSIONS) {
            const file = path.join(root, theme, dir.name, name + ext);
            if (fs.existsSync(file)) return file;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Look icons up in the session's theme: each request's first name the theme
 * has, as a data URL, keyed by the request's first name. Nothing under the
 * Din theme.
 */
async function lookup(requests: { names: string[]; kind: IconKind }[]): Promise<Record<string, string>> {
  const theme = await currentIconTheme();
  const found: Record<string, string> = {};
  if (theme === DIN_THEME) return found;
  const chain = themeChain(theme);
  for (const { names, kind } of requests) {
    const file = findIcon(chain, names, kind);
    const url = file && iconDataUrl(file);
    if (url) found[names[0]] = url;
    await breathe();
  }
  return found;
}

/** Names whose icons show what a theme looks like, in Settings. */
const PREVIEW: { names: string[]; kind: IconKind }[] = [
  { names: ['folder'], kind: 'files' },
  { names: ['system-file-manager', 'org.gnome.Nautilus'], kind: 'apps' },
  { names: ['utilities-terminal', 'org.gnome.Terminal'], kind: 'apps' },
  { names: ['web-browser', 'internet-web-browser'], kind: 'apps' },
  { names: ['preferences-system', 'org.gnome.Settings'], kind: 'apps' },
  { names: ['image-x-generic'], kind: 'files' },
  { names: ['text-x-generic'], kind: 'files' },
];

const PREVIEW_COUNT = 4;

function preview(theme: string): string[] {
  if (theme === DIN_THEME) return [];
  const chain = themeChain(theme);
  const urls: string[] = [];
  for (const { names, kind } of PREVIEW) {
    const file = findIcon(chain, names, kind);
    const url = file && iconDataUrl(file);
    if (url) urls.push(url);
    if (urls.length === PREVIEW_COUNT) break;
  }
  return urls;
}

async function themes(): Promise<IconTheme[]> {
  const list: IconTheme[] = [];
  for (const theme of installedThemes()) {
    list.push({ ...theme, preview: preview(theme.id) });
    await breathe();
  }
  return list;
}

// ---------------------------------------------------------------------------

export function registerIconThemeHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  shell: () => Electron.WebContents | null;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('icon-theme:status', async (event): Promise<IconThemeStatus> => {
    assertShellSender(event);
    const theme = await currentIconTheme();
    const owner = settingsOwner();
    return { theme, din: theme === DIN_THEME, canChange: owner !== 'other', shared: owner === 'shared' };
  });

  ipcMain.handle('icon-theme:themes', async (event) => {
    assertShellSender(event);
    return themes();
  });

  ipcMain.handle('icon-theme:lookup', async (event, requests: unknown) => {
    assertShellSender(event);
    if (!Array.isArray(requests) || requests.length > 256) throw new Error('Not a list of icons');
    const valid = requests.flatMap((request: unknown): { names: string[]; kind: IconKind }[] => {
      const { names, kind } = (request ?? {}) as { names?: unknown; kind?: unknown };
      if (kind !== 'apps' && kind !== 'files') return [];
      if (!Array.isArray(names) || names.length === 0 || names.length > 8) return [];
      if (!names.every((name): name is string => typeof name === 'string' && ICON_NAME.test(name))) return [];
      return [{ names, kind }];
    });
    return lookup(valid);
  });

  ipcMain.handle('icon-theme:set', async (event, theme: unknown) => {
    assertShellSender(event);
    if (!canChange()) throw new Error('Din can\'t change the icons on this system');
    if (typeof theme !== 'string' || !installedThemes().some((t) => t.id === theme)) {
      throw new Error('Unknown icon theme');
    }
    await gsettings('set', SCHEMA, 'icon-theme', theme);
    themeRead = Promise.resolve(theme);
    forgetIconIndex();
    const shell = options.shell();
    shell?.send('icon-theme:changed');
    // Native apps' icons come from the theme too.
    shell?.send('native-apps:changed');
  });
}
