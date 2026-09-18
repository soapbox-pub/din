// Ordinary Linux apps on the Din desktop.
//
// Din's own apps live inside its single Electron window. Native apps can't:
// they're separate X11 clients with their own toplevel windows. Rather than
// try to embed them (XEmbed reparenting is a well-known source of misery -
// broken menus, wrong sizes, crashed clients taking the shell's window tree
// with them), Din leaves them to the host window manager, which stacks them
// above the shell exactly as it would above any other window. Din then acts
// as their taskbar: it lists installed apps in the launcher and the Dock,
// starts them, and tracks/raises/minimizes/closes their windows over EWMH
// (see x11.mts).
//
// Three jobs live here:
//
//   1. Discovery - parse XDG desktop entries into launchable app records,
//      with icons resolved through the icon-theme spec and inlined as data
//      URLs (the shell's CSP allows `img-src data:`, and adding a custom
//      scheme for icons would mean widening it).
//   2. Launching - spawn a desktop entry's Exec line, detached from the
//      shell, remembering the pid so its windows can be matched back to it.
//   3. Window tracking - keep a live model of the session's toplevel
//      windows, matched to the app that owns them, pushed to the shell
//      renderer on every change.
//
// Everything degrades to "unavailable" off X11 (a Wayland-only session, or
// Aladdin's cage, which has no window manager at all and shows exactly one
// window by design).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ipcMain, nativeImage } from 'electron';
import { ICONIC_STATE, X11Client, type WindowId } from './x11.mts';

/** An installed native application, as the shell sees it. */
export interface NativeApp {
  /** Desktop-registry id, namespaced so it can't collide with a Din app. */
  id: string;
  /** Desktop file id, e.g. "org.gnome.Calculator.desktop". */
  desktopId: string;
  name: string;
  /** The entry's Comment, for tooltips. */
  comment: string | null;
  /** Icon as a data: URL, or null when none could be resolved. */
  icon: string | null;
  /** Freedesktop categories, e.g. ["Utility", "Calculator"]. */
  categories: string[];
  /** Extra search terms from the entry's Keywords. */
  keywords: string[];
}

/** One toplevel window of a native app. */
export interface NativeWindow {
  /** X11 window id; the handle for activate/minimize/close. */
  id: number;
  /** The owning app's registry id, when it could be matched. */
  appId: string | null;
  title: string;
  minimized: boolean;
  /** Whether this is the session's focused window. */
  active: boolean;
}

// ---------------------------------------------------------------------------
// Desktop entries
// ---------------------------------------------------------------------------

/** A parsed [Desktop Entry] group, with only the keys Din cares about. */
interface DesktopEntry {
  id: string;
  name: string;
  comment: string | null;
  iconName: string | null;
  /** Exec line, already split into argv with field codes removed. */
  argv: string[];
  terminal: boolean;
  categories: string[];
  keywords: string[];
  /** StartupWMClass, the entry's own hint for matching its windows. */
  startupWmClass: string | null;
  /** Working directory (Path=), when set. */
  cwd: string | null;
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

/**
 * Directories holding desktop entries, most specific first (a user entry
 * shadows a system one with the same id).
 *
 * Flatpak's export directories are appended explicitly: they're normally in
 * XDG_DATA_DIRS, but a shell started outside a full session (a bare X
 * session, a display manager with a minimal environment) may not inherit
 * that, and silently losing every Flatpak app is a confusing failure.
 */
function applicationDirs(): string[] {
  const dirs = [
    path.join(dataHome(), 'applications'),
    ...dataDirs().map((dir) => path.join(dir, 'applications')),
    path.join(dataHome(), 'flatpak/exports/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
  ];
  return [...new Set(dirs)];
}

/** The language codes to try for localized keys, most specific first. */
function localeKeys(): string[] {
  const locale =
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  // "en_US.UTF-8@mod" -> ["en_US", "en"]
  const base = locale.split('.')[0].split('@')[0];
  if (!base || base === 'C' || base === 'POSIX') return [];
  const language = base.split('_')[0];
  return base === language ? [base] : [base, language];
}

/** Unescape a desktop-entry value (\s \n \t \r \\). */
function unescapeValue(value: string): string {
  if (!value.includes('\\')) return value;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '\\' || i === value.length - 1) {
      out += value[i];
      continue;
    }
    i += 1;
    const c = value[i];
    out += c === 's' ? ' ' : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
  }
  return out;
}

/**
 * Split an Exec value into argv, honoring the spec's quoting and dropping
 * field codes (%f, %U, ...).
 *
 * Field codes stand for files or URLs to open; Din launches apps with no
 * arguments, so they're simply removed - except %% which is a literal '%'.
 */
function parseExec(exec: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < exec.length; i += 1) {
    const c = exec[i];
    if (quoted) {
      if (c === '\\' && i + 1 < exec.length) {
        // Inside quotes only these four are escapes; anything else is literal.
        const next = exec[i + 1];
        if (next === '"' || next === '\\' || next === '`' || next === '$') {
          current += next;
          i += 1;
          continue;
        }
        current += c;
        continue;
      }
      if (c === '"') {
        quoted = false;
        continue;
      }
      current += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += c;
    started = true;
  }
  if (started) argv.push(current);

  return argv
    .map((arg) => arg.replace(/%(.)/g, (_match, code: string) => (code === '%' ? '%' : '')))
    .filter((arg, index) => arg.length > 0 || index === 0);
}

/** Parse a .desktop file, or null when it isn't a launchable application. */
function parseDesktopFile(file: string, id: string): DesktopEntry | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  // Only the [Desktop Entry] group matters; action groups are ignored.
  const values = new Map<string, string>();
  let inEntry = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line.length === 0) continue;
    if (line.startsWith('[')) {
      if (inEntry) break;
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  /** A key's value, preferring the best localized variant. */
  const get = (key: string): string | null => {
    for (const locale of localeKeys()) {
      const localized = values.get(`${key}[${locale}]`);
      if (localized) return unescapeValue(localized);
    }
    const plain = values.get(key);
    return plain === undefined ? null : unescapeValue(plain);
  };
  const flag = (key: string): boolean => values.get(key) === 'true';

  if ((values.get('Type') ?? 'Application') !== 'Application') return null;
  if (flag('NoDisplay') || flag('Hidden')) return null;

  const name = get('Name');
  const exec = values.get('Exec');
  if (!name || !exec) return null;

  // TryExec names a binary whose absence means the app isn't really
  // installed (common for entries shipped by a meta-package).
  const tryExec = values.get('TryExec');
  if (tryExec && !which(tryExec)) return null;

  const argv = parseExec(exec);
  if (argv.length === 0 || !argv[0]) return null;

  const list = (key: string): string[] =>
    (get(key) ?? '')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    id,
    name,
    comment: get('Comment'),
    iconName: values.get('Icon') ?? null,
    argv,
    terminal: flag('Terminal'),
    categories: list('Categories'),
    keywords: list('Keywords'),
    startupWmClass: values.get('StartupWMClass') ?? null,
    cwd: values.get('Path') ?? null,
  };
}

/** Resolve a command against PATH (absolute paths are checked directly). */
function which(command: string): string | null {
  if (command.includes('/')) {
    return isExecutable(command) ? command : null;
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Yield to the event loop.
 *
 * Scanning a few hundred desktop entries and indexing an icon theme is
 * roughly a second of synchronous filesystem work. The main process is also
 * the shell's IPC peer and input router, so doing that in one go visibly
 * janks the desktop; every loop below breathes between batches instead.
 */
function breathe(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Files to process between yields. */
const BATCH = 24;

/**
 * Every visible desktop entry on the system, keyed by desktop file id.
 *
 * Directories are walked most-specific-first and the first entry for an id
 * wins, which is exactly the spec's shadowing rule: ~/.local/share overrides
 * /usr/share.
 */
async function scanDesktopEntries(): Promise<Map<string, DesktopEntry>> {
  const entries = new Map<string, DesktopEntry>();
  let sinceBreath = 0;
  // Entries may nest in subdirectories; the id then joins them with '-'.
  const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        if (depth > 0) {
          await walk(path.join(current, dirent.name), `${prefix}${dirent.name}-`, depth - 1);
        }
        continue;
      }
      if (!dirent.name.endsWith('.desktop')) continue;
      const id = `${prefix}${dirent.name}`;
      if (entries.has(id)) continue;
      const entry = parseDesktopFile(path.join(current, dirent.name), id);
      if (entry) entries.set(id, entry);
      sinceBreath += 1;
      if (sinceBreath >= BATCH) {
        sinceBreath = 0;
        await breathe();
      }
    }
  };
  for (const dir of applicationDirs()) await walk(dir, '', 3);
  return entries;
}

// ---------------------------------------------------------------------------
// Icons
//
// The icon-theme spec's lookup is "find the file named <Icon> in the
// best-matching directory of the current theme, then its parents, then
// hicolor". Din does it once, in bulk: the ranked directory list is walked
// and indexed into a name -> path map, so 200 apps cost one pass over a few
// dozen directories instead of thousands of stat() probes.
// ---------------------------------------------------------------------------

/** Icon size Din renders at, in the launcher and Dock (logical px, 2x). */
const TARGET_ICON_SIZE = 96;
/** Cap on an inlined icon; larger PNGs are downscaled before encoding. */
const MAX_ICON_BYTES = 128 * 1024;

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

/**
 * The session's icon theme name.
 *
 * Read from the GTK settings file rather than by shelling out to gsettings:
 * it's the same answer, costs no subprocess, and works in a session where
 * gsettings isn't installed. Falls back to hicolor, which every theme
 * inherits anyway.
 */
function currentIconTheme(): string {
  const files = [
    path.join(os.homedir(), '.config/gtk-4.0/settings.ini'),
    path.join(os.homedir(), '.config/gtk-3.0/settings.ini'),
    path.join(os.homedir(), '.gtkrc-2.0'),
  ];
  for (const file of files) {
    try {
      const match = /^\s*gtk-icon-theme-name\s*=\s*"?([^"\n]+?)"?\s*$/m.exec(
        fs.readFileSync(file, 'utf8'),
      );
      if (match) return match[1];
    } catch {
      // Not present; try the next one.
    }
  }
  return 'hicolor';
}

/** An index.theme's subdirectory, with what the spec needs to rank it. */
interface ThemeDir {
  name: string;
  size: number;
  scale: number;
  context: string;
  /** Scalable directories hold SVGs that look right at any size. */
  scalable: boolean;
}

/** Parse a theme's index.theme into its directory list and parent themes. */
function parseIndexTheme(file: string): { dirs: ThemeDir[]; inherits: string[] } | null {
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
  return { dirs, inherits: (head.get('Inherits') ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
}

/**
 * Rank a theme directory: lower sorts first.
 *
 * Application icons are what a launcher wants, at roughly the size it
 * renders. Scalable directories win outright (one SVG beats any raster
 * size), then unscaled raster directories by distance from the target, with
 * too-small icons penalized harder than too-large ones - upscaling a 16px
 * icon into a Dock tile looks far worse than downscaling a 256px one.
 */
function rankThemeDir(dir: ThemeDir): number {
  const contextPenalty = dir.context === 'Applications' ? 0 : 1000;
  const scalePenalty = (dir.scale - 1) * 500;
  if (dir.scalable) return contextPenalty + scalePenalty;
  const distance =
    dir.size >= TARGET_ICON_SIZE
      ? dir.size - TARGET_ICON_SIZE
      : (TARGET_ICON_SIZE - dir.size) * 4;
  return contextPenalty + scalePenalty + 1 + distance;
}

/** The theme's inheritance chain, depth-first, always ending in hicolor. */
function themeChain(theme: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string, depth: number): void => {
    if (seen.has(name) || depth > 8) return;
    seen.add(name);
    chain.push(name);
    for (const root of iconRoots()) {
      const parsed = parseIndexTheme(path.join(root, name, 'index.theme'));
      if (!parsed) continue;
      for (const parent of parsed.inherits) visit(parent, depth + 1);
      break;
    }
  };
  visit(theme, 0);
  visit('Adwaita', 0);
  visit('hicolor', 0);
  return chain;
}

/** Extensions Din can inline, best first (SVG scales; XPM can't be rendered). */
const ICON_EXTENSIONS = ['.svg', '.png'];

/** name -> icon file path, built once per process. */
let iconIndex: Map<string, string> = new Map();
/** In-flight index build, so concurrent callers share one pass. */
let iconIndexBuild: Promise<Map<string, string>> | null = null;

/** Build (once) the icon-name index over the whole theme chain. */
function buildIconIndex(): Promise<Map<string, string>> {
  if (iconIndex.size > 0) return Promise.resolve(iconIndex);
  iconIndexBuild ??= indexIcons();
  return iconIndexBuild;
}

async function indexIcons(): Promise<Map<string, string>> {
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

  const roots = iconRoots();
  for (const theme of themeChain(currentIconTheme())) {
    // A theme can be split across roots (a user override plus the system
    // copy); merge every root's copy of it, best-ranked directories first.
    const dirs: ThemeDir[] = [];
    for (const root of roots) {
      const parsed = parseIndexTheme(path.join(root, theme, 'index.theme'));
      for (const dir of parsed?.dirs ?? []) {
        if (!dirs.some((d) => d.name === dir.name)) dirs.push(dir);
      }
    }
    for (const dir of [...dirs].sort((a, b) => rankThemeDir(a) - rankThemeDir(b))) {
      for (const root of roots) indexDir(path.join(root, theme, dir.name));
      await breathe();
    }
  }
  for (const dir of pixmapDirs()) indexDir(dir);

  iconIndex = index;
  iconIndexBuild = null;
  return index;
}

/** icon path -> data URL, so shared icons are encoded once. */
const iconDataUrls = new Map<string, string | null>();

/**
 * Inline an icon file as a data: URL.
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
        data.length <= MAX_ICON_BYTES
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

/** Resolve a desktop entry's Icon value to a data URL, or null. */
async function resolveIcon(iconName: string | null): Promise<string | null> {
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
// The live app + window model
// ---------------------------------------------------------------------------

/** Registry id prefix, keeping native apps clear of Din's own app ids. */
const NATIVE_PREFIX = 'native:';

/** How long to coalesce window changes before pushing to the renderer. */
const PUSH_DEBOUNCE_MS = 60;

/** Re-scan installed apps no more often than this. */
const SCAN_TTL_MS = 30_000;

/** Interned atoms, resolved once per connection. */
interface Atoms {
  clientList: number;
  activeWindow: number;
  netWmName: number;
  wmName: number;
  wmClass: number;
  netWmPid: number;
  netWmState: number;
  stateHidden: number;
  stateSkipTaskbar: number;
  windowType: number;
  typeNormal: number;
  typeDialog: number;
  utf8String: number;
  wmChangeState: number;
  closeWindow: number;
}

/** What Din tracks about one toplevel window. */
interface TrackedWindow {
  id: WindowId;
  title: string;
  wmClass: string[];
  pid: number | null;
  minimized: boolean;
  /** False for desktops, docks, panels and anything asking to be skipped. */
  taskbar: boolean;
}

let client: X11Client | null = null;
let atoms: Atoms | null = null;
let tracked = new Map<WindowId, TrackedWindow>();
let activeWindow: WindowId = 0;
let pushTimer: NodeJS.Timeout | null = null;
let pushWindows: (() => void) | null = null;

/** Desktop entries, cached with a TTL so newly installed apps show up. */
let entryCache: { at: number; entries: Map<string, DesktopEntry> } | null = null;
/** Lowercased WM_CLASS instance/class -> app id, rebuilt with the entries. */
let wmClassIndex = new Map<string, string>();
/** pid -> app id, for every app Din has launched this session. */
const launchedPids = new Map<number, string>();

/** In-flight scan, so concurrent callers share one pass over the disk. */
let entryScan: Promise<Map<string, DesktopEntry>> | null = null;

/**
 * The desktop entries, re-scanning when the cache has gone stale (apps get
 * installed while the desktop is running).
 */
function entries(): Promise<Map<string, DesktopEntry>> {
  if (entryCache && Date.now() - entryCache.at < SCAN_TTL_MS) {
    return Promise.resolve(entryCache.entries);
  }
  entryScan ??= scanDesktopEntries().then((scanned) => {
    entryCache = { at: Date.now(), entries: scanned };
    wmClassIndex = buildWmClassIndex(scanned);
    entryScan = null;
    // Windows read before the first scan landed have no app id yet; now that
    // the index exists they can be matched, so re-push.
    schedulePush();
    return scanned;
  });
  return entryScan;
}



/**
 * Index the hints that can tie a window's WM_CLASS back to a desktop entry,
 * weakest last so a strong hint is never overwritten:
 *
 *   1. StartupWMClass - the entry telling us outright.
 *   2. The desktop file id ("org.gnome.Calculator"), which GTK apps use as
 *      their application id and therefore as their WM_CLASS.
 *   3. The Exec binary's name, which is what most X11 apps report.
 *   4. The last dot-component of the id ("calculator"), a guess that saves
 *      the many apps whose WM_CLASS is just their short name.
 */
function buildWmClassIndex(scanned: Map<string, DesktopEntry>): Map<string, string> {
  const index = new Map<string, string>();
  const add = (key: string | null | undefined, appId: string): void => {
    const normalized = key?.trim().toLowerCase();
    if (!normalized || index.has(normalized)) return;
    index.set(normalized, appId);
  };
  const all = [...scanned.values()];
  const appIdOf = (entry: DesktopEntry) => NATIVE_PREFIX + entry.id.replace(/\.desktop$/, '');

  for (const entry of all) add(entry.startupWmClass, appIdOf(entry));
  for (const entry of all) add(entry.id.replace(/\.desktop$/, ''), appIdOf(entry));
  for (const entry of all) add(path.basename(entry.argv[0]), appIdOf(entry));
  for (const entry of all) {
    const base = entry.id.replace(/\.desktop$/, '');
    if (base.includes('.')) add(base.slice(base.lastIndexOf('.') + 1), appIdOf(entry));
  }
  return index;
}

/** Public app records for the shell, sorted by name. */
async function listApps(): Promise<NativeApp[]> {
  const scanned = [...(await entries()).values()];
  const apps: NativeApp[] = [];
  for (const entry of scanned) {
    apps.push({
      id: NATIVE_PREFIX + entry.id.replace(/\.desktop$/, ''),
      desktopId: entry.id,
      name: entry.name,
      comment: entry.comment,
      icon: await resolveIcon(entry.iconName),
      categories: entry.categories,
      keywords: entry.keywords,
    });
    if (apps.length % BATCH === 0) await breathe();
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/** Terminal emulators tried, in order, for Terminal=true entries. */
const TERMINALS = [
  ['x-terminal-emulator', '-e'],
  ['gnome-terminal', '--'],
  ['konsole', '-e'],
  ['xfce4-terminal', '-x'],
  ['alacritty', '-e'],
  ['foot', '-e'],
  ['xterm', '-e'],
];

/**
 * Launch an app by registry id. Throws when the id is unknown, so the shell
 * can surface a real error instead of a silently dead click.
 */
async function launch(appId: string): Promise<void> {
  const desktopId = appId.startsWith(NATIVE_PREFIX)
    ? `${appId.slice(NATIVE_PREFIX.length)}.desktop`
    : appId;
  const entry = (await entries()).get(desktopId);
  if (!entry) throw new Error(`Unknown application: ${appId}`);

  let argv = entry.argv;
  if (entry.terminal) {
    const terminal = TERMINALS.find(([bin]) => which(bin));
    if (!terminal) throw new Error(`${entry.name} needs a terminal emulator`);
    argv = [...terminal, ...argv];
  }

  // Hand the app a clean environment: Electron's own Node/Chromium variables
  // would otherwise leak into every app the user starts (ELECTRON_RUN_AS_NODE
  // in particular turns an Electron-based app into a bare Node process).
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.CHROME_DESKTOP;

  const child = spawn(argv[0], argv.slice(1), {
    cwd: entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : os.homedir(),
    env,
    detached: true,
    stdio: 'ignore',
  });
  // Detached and unreferenced: the app outlives Din's own lifetime and never
  // holds the event loop open.
  child.unref();
  child.on('error', () => {
    if (child.pid) launchedPids.delete(child.pid);
  });
  if (child.pid) launchedPids.set(child.pid, appId);
}

/** Walk a pid's ancestry, looking for a process Din launched. */
function appIdForPid(pid: number | null): string | null {
  let current = pid;
  for (let depth = 0; current && current > 1 && depth < 12; depth += 1) {
    const appId = launchedPids.get(current);
    if (appId) return appId;
    current = parentPid(current);
  }
  return null;
}

/** A process's parent pid, from /proc, or null. */
function parentPid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesized and may contain spaces; ppid is the
    // second field after it.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(fields[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** Whether a pid is Din itself (its window must never appear in its own Dock). */
function isOwnProcess(pid: number | null): boolean {
  let current = pid;
  for (let depth = 0; current && current > 1 && depth < 12; depth += 1) {
    if (current === process.pid) return true;
    current = parentPid(current);
  }
  return false;
}

/** Match a tracked window to an installed app. */
function appIdForWindow(window: TrackedWindow): string | null {
  const byPid = appIdForPid(window.pid);
  if (byPid) return byPid;
  for (const name of window.wmClass) {
    const appId = wmClassIndex.get(name.toLowerCase());
    if (appId) return appId;
  }
  return null;
}

/** The window list handed to the shell. */
function listWindows(): NativeWindow[] {
  const out: NativeWindow[] = [];
  for (const window of tracked.values()) {
    if (!window.taskbar) continue;
    out.push({
      id: window.id,
      appId: appIdForWindow(window),
      title: window.title,
      minimized: window.minimized,
      active: window.id === activeWindow,
    });
  }
  return out;
}

/** Read everything Din tracks about a window. */
async function readWindow(id: WindowId): Promise<TrackedWindow | null> {
  const x = client;
  const a = atoms;
  if (!x || !a) return null;
  try {
    const [netName, wmName, wmClass, pids, state, type] = await Promise.all([
      x.getText(id, a.netWmName, a.utf8String),
      x.getText(id, a.wmName, a.utf8String),
      x.getText(id, a.wmClass, a.utf8String),
      x.getCardinals(id, a.netWmPid, 1),
      x.getCardinals(id, a.netWmState, 64),
      x.getCardinals(id, a.windowType, 8),
    ]);
    const pid = pids[0] ?? null;
    // WM_CLASS is a pair of NUL-terminated strings: instance, then class.
    const classes = (wmClass ?? '').split('\0').filter(Boolean);
    // An absent type means "normal" per EWMH. Anything that isn't a normal
    // window or a dialog is chrome (desktop, dock, panel, splash) and has no
    // place in a taskbar.
    const taskbarType =
      type.length === 0 || type.some((t) => t === a.typeNormal || t === a.typeDialog);
    return {
      id,
      title: (netName ?? wmName ?? '').replace(/\0.*$/, ''),
      wmClass: classes,
      pid,
      minimized: state.includes(a.stateHidden),
      taskbar: taskbarType && !state.includes(a.stateSkipTaskbar) && !isOwnProcess(pid),
    };
  } catch {
    // The window died between being listed and being read.
    return null;
  }
}

/** Coalesce a burst of X events into one push to the renderer. */
function schedulePush(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushWindows?.();
  }, PUSH_DEBOUNCE_MS);
}

/** Reconcile the tracked set against _NET_CLIENT_LIST. */
async function refreshWindowList(): Promise<void> {
  const x = client;
  const a = atoms;
  if (!x || !a) return;
  const ids = await x.getCardinals(x.root, a.clientList, 4096);
  const live = new Set(ids);

  let changed = false;
  for (const id of tracked.keys()) {
    if (!live.has(id)) {
      tracked.delete(id);
      changed = true;
    }
  }
  for (const id of ids) {
    if (tracked.has(id)) continue;
    const window = await readWindow(id);
    if (!window) continue;
    // Watch it before recording it: title and minimize state change often,
    // and a missed early event would leave a stale tile in the Dock.
    x.watchProperties(id);
    tracked.set(id, window);
    changed = true;
  }
  if (changed) schedulePush();
}

/** Re-read one window's properties after a PropertyNotify. */
async function refreshWindow(id: WindowId): Promise<void> {
  if (!tracked.has(id)) return;
  const window = await readWindow(id);
  if (!window) {
    tracked.delete(id);
    schedulePush();
    return;
  }
  const previous = tracked.get(id);
  tracked.set(id, window);
  if (
    !previous ||
    previous.title !== window.title ||
    previous.minimized !== window.minimized ||
    previous.taskbar !== window.taskbar
  ) {
    schedulePush();
  }
}

/**
 * Whether an EWMH-speaking window manager is running.
 *
 * The spec's own handshake: the root window's _NET_SUPPORTING_WM_CHECK points
 * at a window the window manager owns, whose copy of the same property points
 * back at itself. Din's whole approach here rests on there being a window
 * manager to hand native windows to - production Din runs as the only window
 * on a bare X session, where there is none, and everything below (client
 * lists, iconifying, activation) would silently do nothing.
 */
async function hasWindowManager(x: X11Client): Promise<boolean> {
  try {
    const check = await x.atom('_NET_SUPPORTING_WM_CHECK');
    const [owner] = await x.getCardinals(x.root, check, 1);
    if (!owner) return false;
    const [confirm] = await x.getCardinals(owner, check, 1);
    return confirm === owner;
  } catch {
    return false;
  }
}

/** Connect to X11 and start tracking windows. Safe to call repeatedly. */
async function startTracking(): Promise<boolean> {
  if (client?.connected) return true;
  const x = await X11Client.connect();
  if (!x) return false;
  if (!(await hasWindowManager(x))) {
    // Leave the socket closed; a later call retries, so a window manager
    // started after Din (or a session Din is not itself the shell of) is
    // picked up on the next look.
    x.close();
    return false;
  }

  const name = (n: string) => x.atom(n);
  const [
    clientList, activeWin, netWmName, wmName, wmClass, netWmPid, netWmState,
    stateHidden, stateSkipTaskbar, windowType, typeNormal, typeDialog,
    utf8String, wmChangeState, closeWindow,
  ] = await Promise.all([
    name('_NET_CLIENT_LIST'), name('_NET_ACTIVE_WINDOW'), name('_NET_WM_NAME'),
    name('WM_NAME'), name('WM_CLASS'), name('_NET_WM_PID'), name('_NET_WM_STATE'),
    name('_NET_WM_STATE_HIDDEN'), name('_NET_WM_STATE_SKIP_TASKBAR'),
    name('_NET_WM_WINDOW_TYPE'), name('_NET_WM_WINDOW_TYPE_NORMAL'),
    name('_NET_WM_WINDOW_TYPE_DIALOG'), name('UTF8_STRING'),
    name('WM_CHANGE_STATE'), name('_NET_CLOSE_WINDOW'),
  ]);

  client = x;
  atoms = {
    clientList, activeWindow: activeWin, netWmName, wmName, wmClass, netWmPid,
    netWmState, stateHidden, stateSkipTaskbar, windowType, typeNormal,
    typeDialog, utf8String, wmChangeState, closeWindow,
  };

  x.onPropertyNotify = (event) => {
    const a = atoms;
    if (!a) return;
    if (event.window === x.root) {
      if (event.atom === a.clientList) void refreshWindowList();
      else if (event.atom === a.activeWindow) void refreshActive();
      return;
    }
    if (
      event.atom === a.netWmName ||
      event.atom === a.wmName ||
      event.atom === a.netWmState ||
      event.atom === a.windowType
    ) {
      void refreshWindow(event.window);
    }
  };
  x.onClose = () => {
    client = null;
    atoms = null;
    tracked = new Map();
    activeWindow = 0;
    schedulePush();
  };

  x.watchRoot();
  // Warm the desktop-entry scan: window -> app matching reads its index, and
  // the first windows arrive from the refresh below.
  void entries();
  await refreshWindowList();
  await refreshActive();
  return true;
}

/** Re-read which window the window manager considers focused. */
async function refreshActive(): Promise<void> {
  const x = client;
  const a = atoms;
  if (!x || !a) return;
  const [next] = await x.getCardinals(x.root, a.activeWindow, 1);
  const resolved = next ?? 0;
  if (resolved !== activeWindow) {
    activeWindow = resolved;
    schedulePush();
  }
}

/** Raise a window and give it the keyboard focus, un-minimizing it first. */
function activate(id: WindowId): void {
  const x = client;
  const a = atoms;
  if (!x || !a || !tracked.has(id)) return;
  // Source indication 2 = "pager", which is what Din is here: window managers
  // trust pager requests over an application's own focus grabs.
  x.sendClientMessage(id, a.activeWindow, [2, x.lastTimestamp, 0]);
}

/** Minimize (iconify) a window, ICCCM style. */
function minimize(id: WindowId): void {
  const x = client;
  const a = atoms;
  if (!x || !a || !tracked.has(id)) return;
  x.sendClientMessage(id, a.wmChangeState, [ICONIC_STATE]);
}

/** Ask a window to close (the app may still prompt to save). */
function closeWindow(id: WindowId): void {
  const x = client;
  const a = atoms;
  if (!x || !a || !tracked.has(id)) return;
  x.sendClientMessage(id, a.closeWindow, [x.lastTimestamp, 2]);
}

/** Validate a renderer-supplied window id against the tracked set. */
function requireWindow(id: unknown): WindowId {
  if (typeof id !== 'number' || !Number.isInteger(id) || !tracked.has(id)) {
    throw new Error('Unknown window');
  }
  return id;
}

/**
 * Register the native-app IPC surface (window.nativeApps in the preload).
 *
 * Tracking starts lazily, on the shell's first call, so a session with no X
 * server never opens a socket - and so the cost isn't paid during boot.
 */
export function registerNativeAppHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender, sendToShell } = options;

  pushWindows = () => sendToShell('native-apps:windows', listWindows());

  ipcMain.handle('native-apps:list', async (event) => {
    assertShellSender(event);
    const available = await startTracking();
    // Without a window manager Din can list apps but can't track or steer
    // their windows, which makes for a broken Dock - so the whole feature
    // reports unavailable rather than half-working.
    return { available, apps: available ? await listApps() : [] };
  });

  ipcMain.handle('native-apps:windows', async (event) => {
    assertShellSender(event);
    if (!(await startTracking())) return [];
    return listWindows();
  });

  ipcMain.handle('native-apps:launch', async (event, appId) => {
    assertShellSender(event);
    if (typeof appId !== 'string') throw new Error('An app id is required');
    await startTracking();
    await launch(appId);
  });

  ipcMain.handle('native-apps:activate', (event, id) => {
    assertShellSender(event);
    activate(requireWindow(id));
  });

  ipcMain.handle('native-apps:minimize', (event, id) => {
    assertShellSender(event);
    minimize(requireWindow(id));
  });

  ipcMain.handle('native-apps:close', (event, id) => {
    assertShellSender(event);
    closeWindow(requireWindow(id));
  });
}

/** Close the X connection (shutdown). */
export function stopNativeAppTracking(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  client?.close();
  client = null;
  atoms = null;
}
