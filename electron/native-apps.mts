// Ordinary Linux apps on the Din desktop.
//
// Native apps run on Din's embedded display (native-display.mts): a private
// X server whose windows Din composites into its own, so a Linux app gets a
// Din window like any other - chrome, Dock tile, Alt+Tab, wobbly and all.
//
// Two jobs live here:
//
//   1. Discovery - parse XDG desktop entries into launchable app records,
//      with icons resolved through the icon-theme spec and inlined as data
//      URLs (the shell's CSP allows `img-src data:`, and adding a custom
//      scheme for icons would mean widening it).
//   2. Launching - spawn a desktop entry's Exec line onto the embedded
//      display, detached from the shell, remembering the pid so its windows
//      can be matched back to the app that owns them.
//
// Windows programs ride on both: Wine's Start-menu shortcuts are desktop
// entries, and opening an .exe launches Wine (see windows-apps.mts).
//
// Everything degrades to "unavailable" where the embedded display can't run
// (no Xvfb installed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ipcMain, nativeImage } from 'electron';
import {
  embeddedDisplay,
  embeddedDisplayEnv,
  type EmbeddedDisplay,
} from './native-display.mts';
import {
  isWindowsProgram,
  isWineCommand,
  wineEnvironment,
  windowsProgramCommand,
} from './windows-apps.mts';

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
  /** Variables set by an `env NAME=value ...` Exec prefix (Wine's entries). */
  env: Record<string, string>;
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

  // Exec is a string value like any other: its escapes (\\ -> \) come off
  // before the quoting rules apply.
  let argv = parseExec(unescapeValue(exec));
  // `env NAME=value cmd` is how Wine's entries pick their prefix. Lifting
  // the assignments out keeps argv[0] the real program, for window matching
  // and for launch() to recognize Wine.
  const env: Record<string, string> = {};
  if (argv[0] === 'env') {
    let i = 1;
    for (; i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]); i += 1) {
      const eq = argv[i].indexOf('=');
      env[argv[i].slice(0, eq)] = argv[i].slice(eq + 1);
    }
    argv = argv.slice(i);
  }
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
    env,
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
  // Wine nests Start-menu folders as wine/Programs/<Vendor>/<Product>/, so
  // the walk goes several levels down.
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
  for (const dir of applicationDirs()) await walk(dir, '', 6);
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
// Launching and window matching
// ---------------------------------------------------------------------------

/** Registry id prefix, keeping native apps clear of Din's own app ids. */
const NATIVE_PREFIX = 'native:';

/** Re-scan installed apps no more often than this. */
const SCAN_TTL_MS = 30_000;

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
  // Every Windows program's command is "wine"; its WM_CLASS is the .exe name,
  // which Wine's entries carry as StartupWMClass.
  for (const entry of all) {
    if (!isWineCommand(entry.argv[0])) add(path.basename(entry.argv[0]), appIdOf(entry));
  }
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
    if (isUninstaller(entry)) continue;
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

/**
 * A Windows program's "Uninstall Foo" Start-menu shortcut. Windows keeps
 * these out of sight in Apps & Features; listed beside the app itself they
 * look like a second, destructive app.
 */
function isUninstaller(entry: DesktopEntry): boolean {
  return isWineCommand(entry.argv[0]) && /^uninstall\b/i.test(entry.name);
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
 * Launch an app by registry id onto Din's embedded display. Throws when the
 * id is unknown, so the shell can surface a real error instead of a silently
 * dead click.
 */
async function launch(appId: string): Promise<void> {
  const desktopId = appId.startsWith(NATIVE_PREFIX)
    ? `${appId.slice(NATIVE_PREFIX.length)}.desktop`
    : appId;
  const entry = (await entries()).get(desktopId);
  if (!entry) throw new Error(`Unknown application: ${appId}`);
  const display = await embeddedDisplay();
  if (!display) throw new Error('The embedded display is unavailable');

  let argv = entry.argv;
  if (entry.terminal) {
    const terminal = TERMINALS.find(([bin]) => which(bin));
    if (!terminal) throw new Error(`${entry.name} needs a terminal emulator`);
    argv = [...terminal, ...argv];
  }

  const env = await appEnvironment(display);
  if (isWineCommand(argv[0])) Object.assign(env, wineEnvironment());
  Object.assign(env, entry.env);

  const cwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : os.homedir();
  const pid = spawnDetached(argv, cwd, env);
  if (pid) launchedPids.set(pid, appId);
}

/**
 * The environment an app starts with: the embedded display's, minus
 * Electron's own Node/Chromium variables, which would otherwise leak into
 * every app the user starts (ELECTRON_RUN_AS_NODE in particular turns an
 * Electron-based app into a bare Node process).
 */
async function appEnvironment(display: EmbeddedDisplay): Promise<NodeJS.ProcessEnv> {
  const env = await embeddedDisplayEnv(display);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.CHROME_DESKTOP;
  return env;
}

/** Start a process detached from the shell, returning its pid. */
function spawnDetached(argv: string[], cwd: string, env: NodeJS.ProcessEnv): number | undefined {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: 'ignore' });
  // Detached and unreferenced: never holds the event loop open.
  child.unref();
  child.on('error', () => {
    if (child.pid) launchedPids.delete(child.pid);
  });
  return child.pid;
}

/**
 * Open a Windows program file (.exe, .msi, .bat, .lnk) onto the embedded
 * display, through Wine. Runs in the file's own folder, as double-clicking
 * it in Explorer would. Throws with a user-facing message when it can't.
 */
export async function runWindowsProgram(file: string): Promise<void> {
  if (!path.isAbsolute(file) || !isWindowsProgram(file) || !fs.statSync(file).isFile()) {
    throw new Error('Not a Windows program');
  }
  const display = await embeddedDisplay();
  if (!display) throw new Error('The embedded display is unavailable');
  const env = await appEnvironment(display);
  const command = await windowsProgramCommand(file, env);
  spawnDetached(command.argv, path.dirname(file), { ...env, ...command.env });
}

/**
 * Watch the user's applications folder, where installers - Wine's Start-menu
 * shortcuts above all - drop new entries, and report changes so the shell's
 * app list follows along without waiting out the scan cache.
 */
function watchUserApplications(onChange: () => void): void {
  const dir = path.join(dataHome(), 'applications');
  let timer: NodeJS.Timeout | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, { recursive: true }, () => {
      // An install writes a burst of files (entries, icons, MIME caches);
      // settle once it's over.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        entryCache = null;
        // New programs bring new icons, which the index hasn't seen.
        iconIndex = new Map();
        onChange();
      }, 1_000);
    });
    watcher.on('error', () => watcher.close());
    watcher.unref();
  } catch {
    // No watching; the scan cache's TTL still catches up eventually.
  }
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

/**
 * The installed app a window belongs to: by launched-pid ancestry first
 * (exact), then by WM_CLASS (a good guess for apps that re-exec or hand off
 * to an already-running instance).
 */
async function appIdForWindow(pid: number | null, wmClass: string[]): Promise<string | null> {
  const byPid = appIdForPid(pid);
  if (byPid) return byPid;
  await entries();
  for (const name of wmClass) {
    const appId = wmClassIndex.get(name.toLowerCase());
    if (appId) return appId;
  }
  return null;
}

/**
 * Register the native-app IPC surface (window.nativeApps in the preload).
 *
 * The embedded display starts on the shell's first call, so the cost isn't
 * paid during boot, and a machine without Xvfb never tries.
 */
export function registerNativeAppHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  shell: () => Electron.WebContents | null;
}): void {
  const { assertShellSender } = options;

  watchUserApplications(() => options.shell()?.send('native-apps:changed'));

  ipcMain.handle('native-apps:list', async (event) => {
    assertShellSender(event);
    const available = (await embeddedDisplay()) !== null;
    return { available, apps: available ? await listApps() : [] };
  });

  ipcMain.handle('native-apps:launch', async (event, appId) => {
    assertShellSender(event);
    if (typeof appId !== 'string') throw new Error('An app id is required');
    await launch(appId);
  });

  ipcMain.handle('native-apps:run-windows-program', async (event, file) => {
    assertShellSender(event);
    if (typeof file !== 'string') throw new Error('A file path is required');
    await runWindowsProgram(file);
  });

  ipcMain.handle('native-apps:resolve', async (event, pid, wmClass) => {
    assertShellSender(event);
    const classes = Array.isArray(wmClass)
      ? wmClass.filter((c): c is string => typeof c === 'string').slice(0, 4)
      : [];
    return appIdForWindow(Number.isInteger(pid) ? pid : null, classes);
  });
}
