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
//   - .NET is already installed: programs built on it (most C# ones since
//     2020) start, instead of Microsoft's "You must install .NET Desktop
//     Runtime" box. Wine Mono only stands in for the old .NET Framework.
//   - Windows' own look, in Din's light/dark mode and Windows' UI font
//     (wine-theme.mts).
//   - A sandbox (wine-sandbox.mts): programs see the prefix and the
//     folders Windows has too, never the rest of home.
//
// Installers need nothing extra: Wine writes ordinary XDG desktop entries
// and icons for the Start-menu shortcuts they create, into the sandbox's
// own folder for them (windowsShellDir), and native-apps.mts lists those
// like any other installed app's.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parsePalette } from './gtk-theme.mts';
import { LIGHT_STYLE, lookRegistry } from './wine-theme.mts';
import { sandboxed, windowsShellDir } from './wine-sandbox.mts';
import { closeSystemNotification, notifyFromSystem } from './notifications.mts';

export { windowsShellDir };

/** File extensions Din runs through Wine when opened. */
export const WINDOWS_PROGRAM_EXTENSIONS = ['.exe', '.msi', '.bat', '.cmd', '.lnk'];

/** Bump when configurePrefix() changes, to re-apply it to existing prefixes. */
const PREFIX_VERSION = '2';

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

/** Din's Wine prefix: the hidden "Windows installation" every program shares. */
export function winePrefix(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
  return path.join(dataHome, 'din/windows');
}

/**
 * Environment every Wine process Din starts gets: debug output off (it's
 * megabytes of noise nobody reads, and slows some programs down), and .NET
 * programs built for an older .NET than the one Din has run on it: .NET
 * otherwise only moves a program up to a newer minor version, never a major
 * one, and asks for the old runtime to be downloaded.
 */
export function wineEnvironment(): Record<string, string> {
  return { WINEDEBUG: '-all', DOTNET_ROLL_FORWARD: 'Major' };
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

/** Run a Wine tool to completion in the sandbox, rejecting with its output on failure. */
async function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 180_000,
): Promise<string> {
  // In C: once there is one: Wine complains of a folder no drive has.
  const drive = path.join(winePrefix(), 'drive_c');
  const cwd = fs.existsSync(drive) ? drive : winePrefix();
  const command = await sandboxed([file, ...args], env, { prefix: winePrefix(), cwd });
  return new Promise((resolve, reject) => {
    execFile(command.argv[0], command.argv.slice(1), { env: command.env, timeout, cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

/**
 * The command that runs a Wine command line (`[wine, ...]`, from a desktop
 * entry or Din) in Din's prefix, in the sandbox: with Wine's environment,
 * and `share`, a file opened from elsewhere, shown to it.
 */
export async function wineCommand(
  argv: string[],
  baseEnv: NodeJS.ProcessEnv,
  options: { cwd?: string; share?: string[] } = {},
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  const prefix = winePrefix();
  const cwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : path.join(prefix, 'drive_c');
  return sandboxed(argv, { ...baseEnv, ...wineEnvironment(), WINEPREFIX: prefix }, { prefix, cwd, share: options.share });
}

/** The DLLs Direct3D on Vulkan replaces, which load Windows' first (PREFIX_REGISTRY, linkDirect3D). */
const DIRECT3D_DLLS = ['d3d8', 'd3d9', 'd3d10core', 'd3d11', 'dxgi', 'd3d12', 'd3d12core'];

/**
 * Settings Din applies to its prefix, as a regedit script.
 *
 * ShowCrashDialog=0 makes a crashing program exit quietly, like on Windows,
 * instead of opening winedbg's "program error" window.
 *
 * The Direct3D DLLs load Windows' first (DXVK's and vkd3d-proton's, which
 * linkDirect3D puts in the system folders), Wine's own where there are none.
 */
const PREFIX_REGISTRY = `REGEDIT4

[HKEY_CURRENT_USER\\Software\\Wine\\WineDbg]
"ShowCrashDialog"=dword:00000000

[HKEY_CURRENT_USER\\Software\\Wine\\DllOverrides]
${DIRECT3D_DLLS.map((name) => `"${name}"="native,builtin"`).join('\n')}
`;

// ---------------------------------------------------------------------------
// Windows' look (wine-theme.mts): Wine's own Light style and colors, the
// app mode following Din's light/dark mode, Windows' UI font. Wine reads
// them when a program starts, so they're written just before one does,
// when they've changed: open programs keep theirs until reopened.
// ---------------------------------------------------------------------------

/** Bump when wine-theme.mts writes something new for the same mode. */
const LOOK_VERSION = '4';

/** Where an older Din kept the visual style it generated, from drive_c. */
const OLD_STYLE_FOLDER = 'windows/resources/themes/din';

/** Din's light/dark mode, once the desktop has said. */
let darkMode: boolean | null = null;

/** Din's palette (gtk-theme.mts): Windows programs take its light/dark mode. */
export function setWindowsPalette(value: unknown): void {
  darkMode = parsePalette(value)?.dark ?? darkMode;
}

/** One write at a time, each after the last. */
let lookQueue: Promise<void> = Promise.resolve();

/**
 * Give the prefix Windows' look in Din's mode if it hasn't it already.
 * What was last written is kept beside the prefix, so a restart of Din
 * doesn't write the same again.
 */
function applyLook(baseEnv: NodeJS.ProcessEnv): Promise<void> {
  const task = lookQueue.then(async () => {
    const dark = darkMode;
    const wine = wineBinary();
    if (dark === null || !wine) return;
    const prefix = winePrefix();
    const drive = path.join(prefix, 'drive_c');
    // Without Wine's Light style (an older Wine), Windows' classic look.
    const style = fs.existsSync(path.join(drive, LIGHT_STYLE)) ? `C:\\${LIGHT_STYLE.replaceAll('/', '\\')}` : null;
    const script = lookRegistry(dark, style);
    const marker = path.join(prefix, '.din-look');
    const state = `${LOOK_VERSION}\n${script}`;
    try {
      if (fs.readFileSync(marker, 'utf8') === state) return;
    } catch {
      // Never written.
    }
    const file = path.join(prefix, 'din-look.reg');
    fs.writeFileSync(file, script);
    // With the program's own display: the first Wine process in a session
    // starts the desktop process every window shares, on its display.
    await run(wine, ['regedit', '/S', file], { ...baseEnv, ...wineEnvironment(), WINEPREFIX: prefix });
    fs.writeFileSync(marker, state);
    // What an older Din wrote for its own style.
    for (const old of ['.din-colors', 'din-colors.reg']) fs.rmSync(path.join(prefix, old), { force: true });
    fs.rmSync(path.join(drive, OLD_STYLE_FOLDER), { recursive: true, force: true });
  });
  lookQueue = task.catch(() => {});
  return task;
}

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

/**
 * Where .NET goes for each architecture, and the variable that lists its
 * parts there (os/configuration.nix): Program Files\dotnet is where a
 * program's launcher looks first after the registry, which needs nothing
 * then.
 */
const DOTNET_INSTALLS = [
  { variable: 'DIN_WINE_DOTNET_X64', folder: 'Program Files/dotnet' },
  { variable: 'DIN_WINE_DOTNET_X86', folder: 'Program Files (x86)/dotnet' },
];

/**
 * The trees a DIN_WINE_DOTNET_* variable merges into one folder, by name at
 * its top: `<path>` puts what's in the path there, `<sub>=<path>` puts the
 * path itself there as <sub> (the Desktop part, unpacked as
 * Microsoft.WindowsDesktop.App, goes in shared).
 */
function dotnetSources(list: string): Map<string, string[]> {
  const top = new Map<string, string[]>();
  const add = (name: string, source: string) => top.set(name, [...(top.get(name) ?? []), source]);
  for (const item of list.split(':').filter(Boolean)) {
    const at = item.indexOf('=');
    if (at > 0) {
      add(item.slice(0, at), item.slice(at + 1));
      continue;
    }
    let names: string[];
    try {
      names = fs.readdirSync(item);
    } catch {
      continue; // Not installed.
    }
    for (const name of names) add(name, path.join(item, name));
  }
  return top;
}

/** Whether a path is a folder, following links. */
function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Link each entry into a folder: one source is a link to it; several, all
 * folders, a folder of the merge of theirs. What's there already and real
 * (a .NET someone installed with Microsoft's installer) stays, and gets
 * Din's beside it; links left pointing at nothing (from a .NET since
 * updated, or removed) go.
 */
function linkTree(folder: string, entries: Map<string, string[]>): void {
  fs.mkdirSync(folder, { recursive: true });
  for (const name of fs.readdirSync(folder)) {
    const file = path.join(folder, name);
    if (fs.lstatSync(file).isSymbolicLink() && !fs.existsSync(file) && !entries.has(name)) fs.rmSync(file);
  }
  for (const [name, sources] of entries) {
    const file = path.join(folder, name);
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    const merge = sources.length > 1 || (existing !== undefined && !existing.isSymbolicLink());
    if (!merge) {
      if (existing?.isSymbolicLink() && fs.readlinkSync(file) === sources[0]) continue;
      fs.rmSync(file, { force: true });
      fs.symlinkSync(sources[0], file);
      continue;
    }
    // A real file is someone else's; only folders merge.
    if (existing && !existing.isSymbolicLink() && !existing.isDirectory()) continue;
    if (!sources.every(isDirectory)) continue;
    if (existing?.isSymbolicLink()) fs.rmSync(file);
    const children = new Map<string, string[]>();
    for (const source of sources) {
      for (const child of fs.readdirSync(source)) {
        children.set(child, [...(children.get(child) ?? []), path.join(source, child)]);
      }
    }
    linkTree(file, children);
  }
}

/**
 * Put .NET in the prefix, where DinOS has it (the Windows apps feature's
 * runtime parts). Links, not copies: they go through the feature's own
 * links, so an update or removal of the feature carries straight through.
 */
function linkDotnet(prefix: string): void {
  for (const { variable, folder } of DOTNET_INSTALLS) {
    const list = process.env[variable];
    if (!list) continue;
    try {
      linkTree(path.join(prefix, 'drive_c', folder), dotnetSources(list));
    } catch (error) {
      console.warn(`[windows-apps] couldn't link .NET into ${folder}:`, error);
    }
  }
}

/** The notification shown while the prefix is built. */
const SETUP_NOTICE = 'windows-setup';

/**
 * The line of a Wine tool's complaint worth showing: its last that isn't
 * one of Wine's own debug channels' ("0024:err:..."), else its message.
 */
function lastLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const useful = lines.filter((line) => !/^[0-9a-f]{4}:(err|fixme|warn|trace):/i.test(line));
  return (useful.at(-1) ?? lines.at(-1) ?? 'Wine failed').slice(0, 300);
}

/**
 * Direct3D on Vulkan: DXVK's 8 to 11 and vkd3d-proton's 12, each
 * architecture's DLLs (os/configuration.nix) for its system folder.
 * Wine's own, on OpenGL, is slow, and many games don't start on it.
 */
const DIRECT3D_INSTALLS = [
  { variables: ['DIN_WINE_DXVK_X64', 'DIN_WINE_VKD3D_X64'], folder: 'windows/system32' },
  { variables: ['DIN_WINE_DXVK_X86', 'DIN_WINE_VKD3D_X86'], folder: 'windows/syswow64' },
];

/**
 * Link DXVK and vkd3d-proton's DLLs over Wine's in the prefix, where DinOS
 * has them. Links, so an update of the feature carries through; Wine's
 * own, put back once they're gone (the feature removed), are what's loaded
 * then, since the registry asks for Windows' DLL first and Wine's after.
 */
function linkDirect3D(prefix: string): void {
  for (const { variables, folder } of DIRECT3D_INSTALLS) {
    const target = path.join(prefix, 'drive_c', folder);
    if (!isDirectory(target)) continue;
    for (const variable of variables) {
      const source = process.env[variable];
      if (!source || !isDirectory(source)) continue;
      for (const name of fs.readdirSync(source)) {
        if (!DIRECT3D_DLLS.includes(name.toLowerCase().replace(/\.dll$/, ''))) continue;
        const file = path.join(target, name);
        const link = path.join(source, name);
        try {
          if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() && fs.readlinkSync(file) === link) continue;
          fs.rmSync(file, { force: true });
          fs.symlinkSync(link, file);
        } catch (error) {
          console.warn(`[windows-apps] couldn't link ${name} into ${folder}:`, error);
        }
      }
    }
  }
}

/**
 * Take away links to a removed feature's Direct3D DLLs: with none in the
 * system folder, Wine loads its own from where it's installed.
 */
function forgetDirect3D(prefix: string): void {
  for (const { folder } of DIRECT3D_INSTALLS) {
    for (const name of DIRECT3D_DLLS) {
      const file = path.join(prefix, 'drive_c', folder, `${name}.dll`);
      if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() && !fs.existsSync(file)) fs.rmSync(file);
    }
  }
}

/** Create and configure the prefix, once per session. */
let prefixReady: Promise<void> | null = null;

/**
 * Make sure Din's prefix exists and is configured, creating it if needed,
 * and has Windows' look in Din's mode. The first time takes half a minute
 * or so (Wine builds a whole Windows directory tree); afterwards it's a few
 * filesystem checks, and a second or so when Din's mode has changed.
 */
export async function ensurePrefix(baseEnv: NodeJS.ProcessEnv): Promise<void> {
  prefixReady ??= setUpPrefix(baseEnv).catch((error: unknown) => {
    prefixReady = null;
    throw error;
  });
  await prefixReady;
  // Without it a program still opens, as Wine left the prefix.
  await applyLook(baseEnv).catch((error: unknown) => {
    console.warn('[windows-apps] couldn’t give Windows programs their look:', error);
  });
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

    // Building the prefix is half a minute of nothing on screen: say so,
    // or the first program looks like it didn't open.
    const fresh = !fs.existsSync(path.join(prefix, 'system.reg'));
    if (fresh) {
      notifyFromSystem(SETUP_NOTICE, 'Setting up Windows apps', 'The first Windows program takes about half a minute to open.');
    }
    try {
      if (fresh) await run(wine, ['wineboot', '--init'], env);
      const script = path.join(prefix, 'din.reg');
      fs.writeFileSync(script, PREFIX_REGISTRY);
      // The wineserver has them as soon as regedit returns, and every
      // program after asks it; it saves them when the last one exits. (Not
      // `wineserver -w`, which waits for programs already open to close.)
      await run(wine, ['regedit', '/S', script], env);
    } catch (error) {
      throw new Error(`Windows apps couldn’t be set up: ${lastLine(error)}`, { cause: error });
    } finally {
      if (fresh) closeSystemNotification(SETUP_NOTICE);
    }
    fs.writeFileSync(marker, `${PREFIX_VERSION}\n`);
  }

  arrangeDrives(prefix);
  linkDotnet(prefix);
  forgetDirect3D(prefix);
  linkDirect3D(prefix);
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
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  await ensurePrefix(baseEnv);
  const wine = wineBinary();
  if (!wine) throw new Error(NO_WINE);
  return wineCommand([wine, 'start', '/unix', file], baseEnv, { cwd: path.dirname(file), share: [file] });
}
