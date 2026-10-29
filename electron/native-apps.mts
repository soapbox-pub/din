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
import { spawn } from 'node:child_process';
import { ipcMain } from 'electron';
import { forgetIconIndex, resolveIcon } from './icon-theme.mts';
import {
  embeddedDisplay,
  embeddedDisplayAvailable,
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
  if (isWineCommand(argv[0])) Object.assign(env, wineEnvironment());
  Object.assign(env, entry.env);

  const pid = spawnDetached(argv, entryCwd(entry), env);
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
  const display = await requireDisplay();
  const env = await appEnvironment(display);
  const command = await windowsProgramCommand(file, env);
  spawnDetached(command.argv, path.dirname(file), { ...env, ...command.env });
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

  ipcMain.handle('native-apps:run-windows-program', async (event, file) => {
    assertShellSender(event);
    if (typeof file !== 'string') throw new Error('A file path is required');
    await runWindowsProgram(file);
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
    return appIdForWindow(Number.isInteger(pid) ? pid : null, classes);
  });
}
