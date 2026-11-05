// Ordinary Linux apps on the Din desktop.
//
// Native apps run on Din's embedded display (native-display.mts): a private
// X server whose windows Din composites into its own, so a Linux app gets a
// Din window like any other - chrome, Dock tile, Alt+Tab, wobbly and all.
//
// Two jobs live here:
//
//   1. Discovery - parse XDG desktop entries into launchable app records,
//      with icons resolved through the icon theme (icon-theme.mts).
//   2. Launching - spawn a desktop entry's Exec line onto the embedded
//      display, detached from the shell, remembering the pid so its windows
//      can be matched back to the app that owns them.
//
// Windows programs ride on both: Wine's Start-menu shortcuts are desktop
// entries, and opening an .exe launches Wine (see windows-apps.mts).
//
// Where the embedded display can't run (no Xvfb installed), apps are still
// listed, and launching one fails with a message saying why.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ChildProcess, spawn } from 'node:child_process';
import { ipcMain } from 'electron';
import { forgetIconIndex, resolveAppIcon } from './icon-theme.mts';
import {
  embeddedDisplay,
  embeddedDisplayAvailable,
  embeddedDisplayEnv,
  type EmbeddedDisplay,
} from './native-display.mts';
import {
  ensurePrefix,
  isWindowsProgram,
  isWineCommand,
  wineBinary,
  wineEnvironment,
  windowsProgramCommand,
} from './windows-apps.mts';
import { programInfo } from './pe-icon.mts';

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
  /** Whether the icon is a monochrome theme's glyph, which Din draws on a tile. */
  iconGlyph: boolean;
  /** Freedesktop categories, e.g. ["Utility", "Calculator"]. */
  categories: string[];
  /** Extra search terms from the entry's Keywords. */
  keywords: string[];
  /** Whether it runs in a terminal (Terminal=true), i.e. in Din's Terminal. */
  terminal: boolean;
  /** URL schemes it opens (MimeType=x-scheme-handler/…), e.g. ["nostr"]. */
  schemes: string[];
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
  /** Where in argv a URL goes (Exec's %u or %U), or null when it takes none. */
  urlIndex: number | null;
  /** URL schemes it opens, from MimeType; empty unless it takes a URL. */
  schemes: string[];
}

/** Stands in argv for Exec's %u / %U until a URL is given. */
const URL_ARG = '\u0000url';

/** `$XDG_DATA_HOME`, per the base-directory spec. */
function dataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
}

/**
 * `$XDG_DATA_DIRS`, per the base-directory spec, plus the spec's defaults:
 * a session that sets the variable without them (to just Flatpak's
 * directories, say) would otherwise hide every system app.
 */
function dataDirs(): string[] {
  const raw = process.env.XDG_DATA_DIRS || '';
  return [...new Set([...raw.split(':').filter(Boolean), '/usr/local/share', '/usr/share'])];
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
 * files, so they're simply removed - except %% which is a literal '%', and
 * a %u or %U argument of its own, which becomes URL_ARG so a link can be
 * passed there.
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
    .map((arg) =>
      arg === '%u' || arg === '%U'
        ? URL_ARG
        : arg.replace(/%(.)/g, (_match, code: string) => (code === '%' ? '%' : '')),
    )
    .filter((arg, index) => arg.length > 0 || index === 0);
}

/**
 * Parse a .desktop file, or null when it isn't a launchable application.
 * `running` is for the entry of a program already running, which is there
 * whether or not its TryExec is on Din's PATH.
 */
function parseDesktopFile(file: string, id: string, running = false): DesktopEntry | null {
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
  if (tryExec && !running && !which(tryExec)) return null;

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
  const urlAt = argv.indexOf(URL_ARG);
  argv = argv.filter((arg) => arg !== URL_ARG);
  if (argv.length === 0 || !argv[0]) return null;
  const urlIndex = urlAt > 0 ? urlAt : null;

  const list = (key: string): string[] =>
    (get(key) ?? '')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean);
  const schemes =
    urlIndex === null
      ? []
      : list('MimeType')
          .filter((type) => type.toLowerCase().startsWith('x-scheme-handler/'))
          .map((type) => type.slice('x-scheme-handler/'.length).toLowerCase())
          .filter((scheme) => /^[a-z][a-z0-9+.-]*$/.test(scheme));

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
    urlIndex,
    schemes,
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
/** pid -> the AppImage it runs, for every AppImage file Din has opened, until it exits. */
const launchedAppImages = new Map<number, string>();

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
    const { icon, glyph } = await resolveAppIcon(entry.iconName);
    apps.push({
      id: NATIVE_PREFIX + entry.id.replace(/\.desktop$/, ''),
      desktopId: entry.id,
      name: entry.name,
      comment: entry.comment,
      icon,
      iconGlyph: glyph,
      categories: entry.categories,
      keywords: entry.keywords,
      terminal: entry.terminal,
      schemes: entry.schemes,
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

/** The desktop entry behind a registry id, or a throw when there is none. */
async function entryFor(appId: string): Promise<DesktopEntry> {
  const unlisted = unlistedApps.get(appId);
  if (unlisted) {
    if (!unlisted.entry) throw new Error(`${unlisted.app.name} can’t be opened from here; it isn’t installed`);
    return unlisted.entry;
  }
  const desktopId = appId.startsWith(NATIVE_PREFIX)
    ? `${appId.slice(NATIVE_PREFIX.length)}.desktop`
    : appId;
  const entry = (await entries()).get(desktopId);
  if (!entry) throw new Error(`Unknown application: ${appId}`);
  return entry;
}

/**
 * The embedded display, or a throw saying why it can't run, for a user who
 * clicked an app and got nothing.
 */
async function requireDisplay(): Promise<EmbeddedDisplay> {
  if (!embeddedDisplayAvailable()) {
    throw new Error('Linux apps need Xvfb, which isn’t installed. Install it with your package manager, then try again.');
  }
  const display = await embeddedDisplay();
  if (!display) throw new Error('Din’s display for Linux apps didn’t start.');
  return display;
}

/** Where an entry's program runs: its Path=, else home. */
function entryCwd(entry: DesktopEntry): string {
  return entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : os.homedir();
}

/**
 * Launch an app by registry id onto Din's embedded display. Throws when the
 * id is unknown, so the shell can surface a real error instead of a silently
 * dead click. Terminal apps aren't launched here: the shell opens them in
 * its Terminal (see terminalAppCommand). A `uri` is passed where the entry's
 * Exec takes one, and only for a scheme the entry says it opens.
 */
async function launch(appId: string, uri?: string): Promise<void> {
  const entry = await entryFor(appId);
  if (entry.terminal) throw new Error(`${entry.name} runs in the Terminal`);
  const scheme = uri?.slice(0, uri.indexOf(':')).toLowerCase();
  if (uri !== undefined && (entry.urlIndex === null || !scheme || !entry.schemes.includes(scheme))) {
    throw new Error(`${entry.name} doesn't open ${scheme ?? ''}: links`);
  }
  const display = await requireDisplay();

  const argv =
    uri !== undefined && entry.urlIndex !== null
      ? [...entry.argv.slice(0, entry.urlIndex), uri, ...entry.argv.slice(entry.urlIndex)]
      : entry.argv;
  const env = await appEnvironment(display);
  if (isWineCommand(argv[0])) {
    // A program installed before the prefix had what it has now (.NET) gets
    // it all the same.
    await ensurePrefix(env).catch((error: unknown) => console.warn('[native-apps] Windows prefix:', error));
    Object.assign(env, wineEnvironment());
  }
  Object.assign(env, entry.env);

  const { pid } = spawnDetached(argv, entryCwd(entry), env);
  if (pid) launchedPids.set(pid, appId);
}

/**
 * What the Terminal runs for a Terminal=true app (htop, vim, ...) in place
 * of a shell: the entry's command, folder, and extra variables.
 */
export async function terminalAppCommand(
  appId: string,
): Promise<{ argv: string[]; cwd: string; env: Record<string, string> }> {
  const entry = await entryFor(appId);
  if (!entry.terminal) throw new Error(`${entry.name} doesn't run in a terminal`);
  return { argv: entry.argv, cwd: entryCwd(entry), env: entry.env };
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
  // Where the `din` command finds this Din (electron/din-launch.mts).
  if (process.env.DIN_SOCKET) env.DIN_SOCKET = process.env.DIN_SOCKET;
  return env;
}

/**
 * The environment for the Terminal's shells: the apps' own, so a program
 * started from a shell opens as a window in Din like any launched app, not
 * on the display Din itself is drawn to (under din-shell, that put it in Din's
 * place, fullscreen). Din's own environment where the embedded display
 * can't run.
 */
export async function terminalEnvironment(): Promise<NodeJS.ProcessEnv> {
  const display = await embeddedDisplay().catch(() => null);
  return display ? appEnvironment(display) : { ...process.env };
}

/** Start a process detached from the shell, returning its pid. */
function spawnDetached(argv: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: 'ignore' });
  // Detached and unreferenced: never holds the event loop open.
  child.unref();
  child.on('error', () => {
    if (child.pid) launchedPids.delete(child.pid);
  });
  return child;
}

/**
 * Open a Windows program file (.exe, .msi, .bat, .lnk) onto the embedded
 * display, through Wine. Runs in the file's own folder, as double-clicking
 * it in Explorer would. Throws with a user-facing message when it can't.
 */
async function runWindowsProgram(file: string): Promise<void> {
  const display = await requireDisplay();
  const env = await appEnvironment(display);
  const command = await windowsProgramCommand(file, env);
  spawnDetached(command.argv, path.dirname(file), { ...env, ...command.env });
}

/** Whether a file is an AppImage, which Din runs when it's opened. */
export function isAppImage(file: string): boolean {
  return path.extname(file).toLowerCase() === '.appimage';
}

/** Whether a file is a program Din runs when it's opened: Windows's, or an AppImage. */
export function isProgram(file: string): boolean {
  return isWindowsProgram(file) || isAppImage(file);
}

/**
 * Run an AppImage, in its own folder. One just downloaded isn't executable
 * yet; opening it is the user saying to run it, so it's made executable
 * (for its owner) first, as it would have to be in a terminal.
 */
async function runAppImage(file: string): Promise<void> {
  const display = await requireDisplay();
  const env = await appEnvironment(display);
  if (!isExecutable(file)) {
    const { mode } = fs.statSync(file);
    fs.chmodSync(file, mode | 0o100);
  }
  const child = spawnDetached(appImageArgv(file), path.dirname(file), env);
  // Its windows' processes may not say which AppImage they run (see
  // programBundle), but they descend from this one, which does.
  const { pid } = child;
  if (!pid) return;
  launchedAppImages.set(pid, file);
  const forget = (): void => {
    launchedAppImages.delete(pid);
  };
  child.once('exit', forget);
  child.once('error', forget);
}

/**
 * Open a program file onto the embedded display: a Windows program (.exe,
 * .msi, .bat, .lnk) through Wine, running in the file's own folder as
 * double-clicking it in Explorer would; an AppImage as itself. Throws with a
 * user-facing message when it can't.
 */
export async function runProgram(file: string): Promise<void> {
  if (!path.isAbsolute(file) || !isProgram(file) || !fs.statSync(file).isFile()) {
    throw new Error('Not a program');
  }
  if (isAppImage(file)) await runAppImage(file);
  else await runWindowsProgram(file);
}

/**
 * Force quit the program behind a window that won't close.
 *
 * Only a process started onto Din's embedded display qualifies - its
 * environment names one of the display's servers - so the shell can't be
 * used to kill Din itself or anything else the user runs. Throws when the
 * pid doesn't qualify.
 */
async function forceQuit(pid: number): Promise<void> {
  const display = await embeddedDisplay();
  if (!display || pid <= 1 || pid === process.pid) throw new Error('Not an app on Din’s display');
  const servers = new Set([
    `DISPLAY=${display.display}`,
    display.xwayland && `DISPLAY=${display.xwayland}`,
    display.wayland && `WAYLAND_DISPLAY=${display.wayland}`,
  ]);
  let environ: string[];
  try {
    environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch {
    // Gone already, which is what was wanted.
    return;
  }
  if (!environ.some((entry) => servers.has(entry))) throw new Error('Not an app on Din’s display');
  process.kill(pid, 'SIGKILL');
}

/**
 * Watch where user installs land, and report changes so the shell's app list
 * follows along without waiting out the scan cache:
 *
 *   - the user's applications folder, where installers - Wine's Start-menu
 *     shortcuts above all - drop new entries;
 *   - the user's Nix profiles folder, where `nix profile add/remove/upgrade`
 *     repoints the `profile` symlink behind ~/.nix-profile. Nothing under
 *     ~/.nix-profile/share/applications changes in place (it's a store path),
 *     so this symlink flip is the only sign of an install.
 */
function watchUserApplications(onChange: () => void): void {
  const applications = path.join(dataHome(), 'applications');
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state');
  const nixProfiles = path.join(stateHome, 'nix/profiles');

  let timer: NodeJS.Timeout | null = null;
  const changed = (): void => {
    // An install writes a burst of files (entries, icons, MIME caches);
    // settle once it's over.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      entryCache = null;
      // New programs bring new icons, which the index hasn't seen.
      forgetIconIndex();
      onChange();
    }, 1_000);
  };
  const watch = (dir: string, recursive: boolean): void => {
    try {
      const watcher = fs.watch(dir, { recursive }, changed);
      watcher.on('error', () => watcher.close());
      watcher.unref();
    } catch {
      // No watching; the scan cache's TTL still catches up eventually.
    }
  };

  try {
    fs.mkdirSync(applications, { recursive: true });
  } catch {
    // Watching below fails too, and is handled there.
  }
  watch(applications, true);
  // Only where Nix has made it; non-Nix systems have nothing to watch.
  if (fs.existsSync(nixProfiles)) watch(nixProfiles, false);
}

/** Every app Din has launched this session, by the pid it started as. */
export function launchedApps(): ReadonlyMap<number, string> {
  return launchedPids;
}

/** Walk a pid's ancestry, looking for a process Din launched. */
export function appIdForPid(pid: number | null): string | null {
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

// ---------------------------------------------------------------------------
// Programs that aren't installed
//
// `nix run nixpkgs#foo` and an AppImage both run a program whose desktop
// entry sits beside it - in its store path's share/applications, in the
// AppImage's mount - rather than anywhere XDG looks. Its windows find that
// entry through the process, so they get the app's name and icon (and a
// Dock tile that can open it again) instead of the generic host's. A
// Windows program opened from its .exe has no entry either: its name and
// icon come from the .exe's resources (pe-icon.mts). A program with no
// entry at all gets a tile named for its WM_CLASS.
// ---------------------------------------------------------------------------

/** An app known only because it's running, with its record for the shell. */
interface UnlistedApp {
  app: NativeApp;
  /** How to open it again; null for one named only by its WM_CLASS. */
  entry: DesktopEntry | null;
}

/** Unlisted apps seen this session, by registry id. */
const unlistedApps = new Map<string, UnlistedApp>();

/** Registry id prefix of an unlisted app, after NATIVE_PREFIX. */
const UNLISTED_MARK = '+';

/** Where a running program came from: its desktop entries and icons. */
interface ProgramBundle {
  /** Folders holding its desktop entries. */
  entryDirs: string[];
  /** Folders to look for its icon in (icon-theme roots, or flat folders). */
  iconDirs: string[];
  /** Folders whose bin/ its entry's Exec names a program in. */
  binDirs: string[];
  /** The AppImage it runs from, which opens it again. */
  appImage: string | null;
  /** The AppImage's folder, mounted or extracted, when it runs from one. */
  appDir: string | null;
}

/** Folders above a binary looked through for the AppImage folder it's in. */
const MAX_APPDIR_DEPTH = 6;

/**
 * The AppImage folder a binary is in: the nearest folder above it with the
 * AppRun every AppImage starts from and a desktop entry beside it. Not the
 * Nix store, whose programs aren't AppImages.
 */
function appDirOf(exe: string): string | null {
  if (exe.startsWith('/nix/store/')) return null;
  let dir = path.dirname(exe);
  for (let depth = 0; depth < MAX_APPDIR_DEPTH && dir !== path.dirname(dir); depth++) {
    try {
      if (fs.statSync(path.join(dir, 'AppRun')).isFile() && fs.readdirSync(dir).some((n) => n.endsWith('.desktop'))) {
        return dir;
      }
    } catch {
      // Not this one.
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** The AppImage Din opened that a process descends from, if any. */
function launchedAppImageFor(pid: number): string | null {
  let current: number | null = pid;
  for (let depth = 0; current && current > 1 && depth < 12; depth += 1) {
    const file = launchedAppImages.get(current);
    if (file) return file;
    current = parentPid(current);
  }
  return null;
}

/** A process's environment variable, or null. */
function processEnv(pid: number, name: string): string | null {
  try {
    const prefix = `${name}=`;
    const found = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((v) => v.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The bundle a window's own process runs from. Only the process itself
 * counts, not its parents: a program started from Din's Terminal descends
 * from Din, whose own store path has a desktop entry.
 */
function programBundle(pid: number): ProgramBundle | null {
  let exe: string | null;
  try {
    exe = fs.realpathSync(`/proc/${pid}/exe`);
  } catch {
    exe = null;
  }
  // An AppImage's runtime says where it mounted (or extracted) itself. A
  // Chromium (Electron) program writes its process title over its
  // environment, though, leaving /proc's copy blank, so the folder is also
  // found from where its binary is.
  let appDir = processEnv(pid, 'APPDIR');
  if (!appDir || !path.isAbsolute(appDir) || !isDirectory(appDir)) appDir = exe && appDirOf(exe);
  if (appDir) {
    const usrShare = path.join(appDir, 'usr/share');
    const appImage = [processEnv(pid, 'APPIMAGE'), launchedAppImageFor(pid)].find(
      (file): file is string => !!file && path.isAbsolute(file) && fs.existsSync(file),
    );
    return {
      entryDirs: [appDir, path.join(usrShare, 'applications')],
      iconDirs: [appDir, path.join(usrShare, 'icons'), path.join(usrShare, 'pixmaps')],
      binDirs: [path.join(appDir, 'usr')],
      appImage: appImage ?? null,
      appDir,
    };
  }
  // A Nix package: the store path its binary is in.
  if (!exe) return null;
  const store = /^\/nix\/store\/[^/]+/.exec(exe)?.[0];
  if (!store) return null;
  const share = path.join(store, 'share');
  return {
    entryDirs: [path.join(share, 'applications')],
    iconDirs: [path.join(share, 'icons'), path.join(share, 'pixmaps')],
    binDirs: [store],
    appImage: null,
    appDir: null,
  };
}

/** Icon sizes to try, best first: big enough to look sharp, small to send. */
const BUNDLE_ICON_SIZES = ['256x256', '512x512', '192x192', '128x128', '96x96', '64x64', '48x48', '32x32'];

/** An icon file for `name` in a bundle's folders, or null. */
function bundleIconFile(name: string, bundle: ProgramBundle): string | null {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const ext = path.extname(name).toLowerCase();
  const bare = ext === '.png' || ext === '.svg' || ext === '.xpm' ? name.slice(0, -ext.length) : name;
  if (!bare || bare.includes('/')) return null;
  for (const dir of bundle.iconDirs) {
    const candidates = [
      path.join(dir, `${bare}.svg`),
      path.join(dir, `${bare}.png`),
      path.join(dir, 'hicolor/scalable/apps', `${bare}.svg`),
      ...BUNDLE_ICON_SIZES.map((size) => path.join(dir, 'hicolor', size, 'apps', `${bare}.png`)),
    ];
    const found = candidates.find((file) => fs.existsSync(file));
    if (found) return found;
  }
  return null;
}

/** The entry in a bundle that a window's WM_CLASS names, else its only one. */
function bundleEntry(bundle: ProgramBundle, wmClass: string[]): DesktopEntry | null {
  const found = new Map<string, DesktopEntry>();
  for (const dir of bundle.entryDirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.desktop'));
    } catch {
      continue;
    }
    for (const name of names) {
      // Its TryExec names a binary on the bundle's own PATH, not Din's.
      const entry = parseDesktopFile(path.join(dir, name), name, true);
      if (entry && !found.has(name)) found.set(name, entry);
    }
  }
  if (found.size === 0) return null;
  const index = buildWmClassIndex(found);
  for (const name of wmClass) {
    const appId = index.get(name.toLowerCase());
    if (appId) return found.get(`${appId.slice(NATIVE_PREFIX.length)}.desktop`) ?? null;
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

/** The command that runs an AppImage: appimage-run where there is one (NixOS). */
function appImageArgv(file: string): string[] {
  const runner = which('appimage-run');
  return runner ? [runner, file] : [file];
}

/**
 * The command that runs an AppImage appimage-run extracted, when which
 * AppImage it was isn't known (one started outside Din, whose environment
 * Chromium wrote over): appimage-run runs the folder it keeps, which, unlike
 * a runtime's mount, stays. Null for any other folder.
 */
function extractedAppDirArgv(appDir: string): string[] | null {
  const runner = which('appimage-run');
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'appimage-run');
  // <cache>/<sha256>, or <cache>/<sha256>/squashfs-root from older versions.
  const hashDir = path.basename(appDir) === 'squashfs-root' ? path.dirname(appDir) : appDir;
  if (!runner || path.dirname(hashDir) !== cache) return null;
  return [runner, '-w', appDir];
}

/** A registry id for an unlisted app, from a name that may be anything. */
function unlistedId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return `${NATIVE_PREFIX}${UNLISTED_MARK}${slug || 'app'}`;
}

/**
 * The .exe a Wine process runs. Wine writes the program's Windows path over
 * its command line (`H:\Downloads\PKHeX.exe`), and the prefix's dosdevices
 * say which folder each drive letter is. Windows paths ignore case, so a
 * name that isn't there as written is looked for in its folder.
 */
function windowsProgramFile(pid: number): { file: string; prefix: string } | null {
  let argv0: string;
  try {
    argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0];
  } catch {
    return null;
  }
  const match = /^([a-z]):\\(.+\.exe)$/i.exec(argv0);
  if (!match) return null;
  const prefix = processEnv(pid, 'WINEPREFIX') || path.join(os.homedir(), '.wine');
  if (!path.isAbsolute(prefix)) return null;
  let file: string;
  try {
    file = fs.realpathSync(path.join(prefix, 'dosdevices', `${match[1].toLowerCase()}:`));
  } catch {
    return null;
  }
  for (const part of match[2].split('\\')) {
    if (!part || part === '.' || part === '..') return null;
    let next = path.join(file, part);
    if (!fs.existsSync(next)) {
      const lower = part.toLowerCase();
      let found: string | undefined;
      try {
        found = fs.readdirSync(file).find((name) => name.toLowerCase() === lower);
      } catch {
        return null;
      }
      if (!found) return null;
      next = path.join(file, found);
    }
    file = next;
  }
  try {
    return fs.statSync(file).isFile() ? { file, prefix } : null;
  } catch {
    return null;
  }
}

/**
 * The unlisted app a Windows program's window belongs to: named and drawn
 * from the .exe's own resources, as Windows' taskbar would, and opened
 * again through Wine. Null for a process that isn't one.
 */
async function windowsProgramApp(pid: number): Promise<UnlistedApp | null> {
  const program = windowsProgramFile(pid);
  if (!program) return null;
  const { file, prefix } = program;
  const base = path.basename(file).replace(/\.exe$/i, '');
  const info = await programInfo(file);
  const name = info.name || base;
  const wine = wineBinary();
  const entry: DesktopEntry | null = wine
    ? {
        id: '',
        name,
        comment: null,
        iconName: null,
        argv: [wine, 'start', '/unix', file],
        terminal: false,
        categories: [],
        keywords: [],
        startupWmClass: null,
        cwd: path.dirname(file),
        env: { WINEPREFIX: prefix },
        urlIndex: null,
        schemes: [],
      }
    : null;
  return {
    entry,
    app: {
      id: unlistedId(`exe-${base}`),
      desktopId: '',
      name,
      comment: null,
      icon: info.icon ? `data:image/png;base64,${info.icon.toString('base64')}` : null,
      iconGlyph: false,
      categories: [],
      keywords: [],
      terminal: false,
      schemes: [],
    },
  };
}

/** The unlisted app a window's process belongs to, from its bundle. */
async function unlistedAppFor(pid: number, wmClass: string[]): Promise<UnlistedApp | null> {
  // Wine's own store path has a desktop entry too (the program loader's),
  // so a Windows program is told apart first.
  const windows = await windowsProgramApp(pid);
  if (windows) return windows;
  const bundle = programBundle(pid);
  const found = bundle && bundleEntry(bundle, wmClass);
  if (bundle && found) {
    // Its Exec names a program on the bundle's own PATH, which isn't Din's;
    // an AppImage opens again from the AppImage, since its mount goes away.
    let argv = found.argv;
    const extracted = !bundle.appImage && bundle.appDir ? extractedAppDirArgv(bundle.appDir) : null;
    if (bundle.appImage) argv = appImageArgv(bundle.appImage);
    else if (extracted) argv = extracted;
    else if (!path.isAbsolute(argv[0])) {
      const bin = bundle.binDirs.map((dir) => path.join(dir, 'bin', argv[0])).find(isExecutable);
      if (bin) argv = [bin, ...argv.slice(1)];
    }
    const entry: DesktopEntry = { ...found, argv, urlIndex: bundle.appImage || extracted ? null : found.urlIndex };
    const iconFile = found.iconName ? bundleIconFile(found.iconName, bundle) : null;
    const { icon, glyph } = iconFile
      ? { icon: (await resolveAppIcon(iconFile)).icon, glyph: false }
      : await resolveAppIcon(found.iconName);
    const id = unlistedId(found.id.replace(/\.desktop$/, ''));
    return {
      entry,
      app: {
        id,
        desktopId: found.id,
        name: found.name,
        comment: found.comment,
        icon,
        iconGlyph: glyph,
        categories: found.categories,
        keywords: found.keywords,
        terminal: false,
        schemes: entry.urlIndex === null ? [] : found.schemes,
      },
    };
  }
  // Nothing to go on but the window's class: "localsend_app", "Gimp".
  const name = wmClass[1] || wmClass[0];
  if (!name) return null;
  return {
    entry: null,
    app: {
      id: unlistedId(`class-${name}`),
      desktopId: '',
      name,
      comment: null,
      icon: null,
      iconGlyph: false,
      categories: [],
      keywords: [],
      terminal: false,
      schemes: [],
    },
  };
}

/** What a window belongs to: an app's registry id, and its record when it's unlisted. */
interface WindowApp {
  appId: string;
  app?: NativeApp;
}

/**
 * The app a window belongs to: by launched-pid ancestry first (exact), then
 * by WM_CLASS (a good guess for apps that re-exec or hand off to an
 * already-running instance), then by where its program came from.
 */
async function appForWindow(pid: number | null, wmClass: string[]): Promise<WindowApp | null> {
  const byPid = appIdForPid(pid);
  if (byPid) {
    const unlisted = unlistedApps.get(byPid);
    return unlisted ? { appId: byPid, app: unlisted.app } : { appId: byPid };
  }
  await entries();
  for (const name of wmClass) {
    const appId = wmClassIndex.get(name.toLowerCase());
    if (appId) return { appId };
  }
  if (pid === null) return null;
  const unlisted = await unlistedAppFor(pid, wmClass);
  if (!unlisted) return null;
  // A program seen before keeps the record it had, so it's one Dock tile.
  const known = unlistedApps.get(unlisted.app.id);
  if (!known || (unlisted.entry && !known.entry)) unlistedApps.set(unlisted.app.id, unlisted);
  const app = unlistedApps.get(unlisted.app.id)!.app;
  return { appId: app.id, app };
}

/**
 * Register the native-app IPC surface (window.dinos.nativeApps in the preload).
 *
 * The embedded display starts with the first app launched, so the cost isn't
 * paid during boot, and a machine without Xvfb never tries.
 */
export function registerNativeAppHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  shell: () => Electron.WebContents | null;
}): void {
  const { assertShellSender } = options;

  watchUserApplications(() => options.shell()?.send('native-apps:changed'));

  // Apps are listed even where the display can't run: terminal apps don't
  // need it, and launching any other says what's missing, where an empty
  // list would leave the user guessing.
  ipcMain.handle('native-apps:list', async (event) => {
    assertShellSender(event);
    return { available: embeddedDisplayAvailable(), apps: await listApps() };
  });

  ipcMain.handle('native-apps:launch', async (event, appId, uri) => {
    assertShellSender(event);
    if (typeof appId !== 'string') throw new Error('An app id is required');
    if (
      uri !== undefined &&
      (typeof uri !== 'string' || uri.length > 8192 || !/^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/i.test(uri))
    ) {
      throw new Error('Not a link');
    }
    await launch(appId, uri);
  });

  ipcMain.handle('native-apps:run-program', async (event, file) => {
    assertShellSender(event);
    if (typeof file !== 'string') throw new Error('A file path is required');
    await runProgram(file);
  });

  ipcMain.handle('native-apps:force-quit', async (event, pid) => {
    assertShellSender(event);
    if (!Number.isInteger(pid)) throw new Error('A pid is required');
    await forceQuit(pid);
  });

  ipcMain.handle('native-apps:resolve', async (event, pid, wmClass) => {
    assertShellSender(event);
    const classes = Array.isArray(wmClass)
      ? wmClass.filter((c): c is string => typeof c === 'string').slice(0, 4)
      : [];
    return appForWindow(Number.isInteger(pid) ? pid : null, classes);
  });
}
