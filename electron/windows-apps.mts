// Windows programs on the Din desktop, through Wine.
//
// Wine draws through X11, so on Din's embedded display (native-display.mts)
// a Windows program is just another native app: it gets a Din window, the
// compositor's GPU path, the keyboard layout, the clipboard. What this
// module adds is everything that would otherwise make the user think about
// Wine:
//
//   - One Din-managed prefix (~/.local/share/din/windows), created silently
//     on first use - no "updating configuration" window, no Mono or Gecko
//     download prompts where the Wine build doesn't ship them.
//   - Windows-like drives: C: and the home folder as H:, without Wine's Z:
//     drive exposing the whole root filesystem in every file dialog.
//   - A crashed program just closes, as it would on Windows, instead of
//     raising winedbg's crash dialog.
//
// Installers need nothing extra: Wine writes ordinary XDG desktop entries
// and icons for the Start-menu shortcuts they create, and native-apps.mts
// picks those up like any other installed app.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** File extensions Din runs through Wine when opened. */
export const WINDOWS_PROGRAM_EXTENSIONS = ['.exe', '.msi', '.bat', '.cmd', '.lnk'];

/** Bump when configurePrefix() changes, to re-apply it to existing prefixes. */
const PREFIX_VERSION = '1';

/** Whether a file is something Din opens as a Windows program. */
export function isWindowsProgram(file: string): boolean {
  return WINDOWS_PROGRAM_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

/** Whether a desktop entry's command runs Wine. */
export function isWineCommand(command: string): boolean {
  const base = path.basename(command);
  return base === 'wine' || base === 'wine64';
}

/** Resolve a command on PATH, or null. */
function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/**
 * The Wine loader, or null where Wine isn't installed. `$DIN_WINE` overrides
 * it; wine64 covers distributions that still split the 64-bit loader out.
 */
export function wineBinary(): string | null {
  return process.env.DIN_WINE || which('wine') || which('wine64');
}

/** Why Windows programs can't open: on DinOS, Wine is an optional feature. */
const NO_WINE = process.env.DIN_FEATURES
  ? 'Windows programs need Windows apps, an optional feature: install it in Settings → Optional Features'
  : 'Windows programs need Wine, which isn’t installed';

/** The wineserver beside a Wine loader (it isn't always on PATH). */
function wineserverBinary(wine: string): string {
  const sibling = path.join(path.dirname(fs.realpathSync(wine)), 'wineserver');
  return fs.existsSync(sibling) ? sibling : 'wineserver';
}

/** Din's Wine prefix: the hidden "Windows installation" every program shares. */
export function winePrefix(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
  return path.join(dataHome, 'din/windows');
}

/**
 * Environment every Wine process Din starts gets: debug output off (it's
 * megabytes of noise nobody reads, and slows some programs down).
 */
export function wineEnvironment(): Record<string, string> {
  return { WINEDEBUG: '-all' };
}

/**
 * Whether this Wine build has its Mono and Gecko packages locally. Without
 * them, creating a prefix pops up "Wine Mono Installer" dialogs offering to
 * download each one - exactly the kind of Wine-ism Din hides.
 */
function hasMonoAndGecko(wine: string): boolean {
  const roots = [
    path.join(path.dirname(fs.realpathSync(wine)), '../share/wine'),
    '/usr/share/wine',
    '/opt/wine/share/wine',
  ];
  const has = (name: string) => roots.some((root) => fs.existsSync(path.join(root, name)));
  return has('mono') && has('gecko');
}

/** Run a Wine tool to completion, rejecting with its output on failure. */
function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 180_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout, cwd: os.homedir() }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });
}

/**
 * Settings Din applies to its prefix, as a regedit script.
 *
 * ShowCrashDialog=0 makes a crashing program exit quietly, like on Windows,
 * instead of opening winedbg's "program error" window.
 */
const PREFIX_REGISTRY = `REGEDIT4

[HKEY_CURRENT_USER\\Software\\Wine\\WineDbg]
"ShowCrashDialog"=dword:00000000
`;

/** The user-folder links Wine makes, Windows name -> home folder name. */
const USER_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'];

/**
 * Make the prefix's drives and user folders look like Windows.
 *
 * Idempotent and cheap, so it runs every session: Wine re-creates its Z:
 * drive when it upgrades a prefix after a Wine update.
 */
function arrangeDrives(prefix: string): void {
  const devices = path.join(prefix, 'dosdevices');
  const home = os.homedir();

  // Z: maps the whole root filesystem; H: (home) is what a user expects to
  // browse to. Programs outside home still run - Wine reaches them with
  // \\?\unix paths.
  fs.rmSync(path.join(devices, 'z:'), { force: true });
  const homeDrive = path.join(devices, 'h:');
  if (!fs.existsSync(homeDrive)) {
    fs.rmSync(homeDrive, { force: true });
    fs.symlinkSync(home, homeDrive);
  }

  // Wine links Documents, Downloads, ... to the home folders that existed
  // when the prefix was made. Link any that have appeared since, as long as
  // the Windows side is still an empty placeholder.
  const user = path.join(prefix, 'drive_c/users', os.userInfo().username);
  for (const name of USER_FOLDERS) {
    const target = path.join(home, name);
    const link = path.join(user, name);
    try {
      if (!fs.statSync(target).isDirectory()) continue;
      const stat = fs.lstatSync(link);
      if (stat.isSymbolicLink() || fs.readdirSync(link).length > 0) continue;
      fs.rmdirSync(link);
      fs.symlinkSync(target, link);
    } catch {
      // Missing on either side; leave it as Wine made it.
    }
  }
}

/** Create and configure the prefix, once per session. */
let prefixReady: Promise<void> | null = null;

/**
 * Make sure Din's prefix exists and is configured, creating it if needed.
 * The first time takes half a minute or so (Wine builds a whole Windows
 * directory tree); afterwards it's a few filesystem checks.
 */
export function ensurePrefix(baseEnv: NodeJS.ProcessEnv): Promise<void> {
  prefixReady ??= setUpPrefix(baseEnv).catch((error: unknown) => {
    prefixReady = null;
    throw error;
  });
  return prefixReady;
}

async function setUpPrefix(baseEnv: NodeJS.ProcessEnv): Promise<void> {
  const wine = wineBinary();
  if (!wine) throw new Error(NO_WINE);
  const prefix = winePrefix();
  const marker = path.join(prefix, '.din-version');

  const current = (() => {
    try {
      return fs.readFileSync(marker, 'utf8').trim();
    } catch {
      return null;
    }
  })();

  if (current !== PREFIX_VERSION) {
    fs.mkdirSync(path.dirname(prefix), { recursive: true });
    // No display: wineboot otherwise shows a progress window while it
    // builds the prefix. It works headless, and nothing here needs a screen.
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...wineEnvironment(),
      WINEPREFIX: prefix,
    };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    if (!hasMonoAndGecko(wine)) env.WINEDLLOVERRIDES = 'mscoree=;mshtml=';

    if (!fs.existsSync(path.join(prefix, 'system.reg'))) {
      await run(wine, ['wineboot', '--init'], env);
    }
    const script = path.join(prefix, 'din.reg');
    fs.writeFileSync(script, PREFIX_REGISTRY);
    await run(wine, ['regedit', '/S', script], env);
    // Registry writes land when the wineserver flushes; wait for it so the
    // first program starts with the settings in place.
    await run(wineserverBinary(wine), ['-w'], env);
    fs.writeFileSync(marker, `${PREFIX_VERSION}\n`);
  }

  arrangeDrives(prefix);
}

/**
 * The command and extra environment that open a Windows program file
 * (.exe, .msi, .bat, .lnk) in Din's prefix.
 *
 * `start /unix` hands the file to Windows' own ShellExecute, so each type
 * opens the way Explorer would open it: programs run, installers go to
 * msiexec, batch files to cmd, shortcuts to their target.
 */
export async function windowsProgramCommand(
  file: string,
  baseEnv: NodeJS.ProcessEnv,
): Promise<{ argv: string[]; env: Record<string, string> }> {
  await ensurePrefix(baseEnv);
  const wine = wineBinary();
  if (!wine) throw new Error(NO_WINE);
  return {
    argv: [wine, 'start', '/unix', file],
    env: { ...wineEnvironment(), WINEPREFIX: winePrefix() },
  };
}
