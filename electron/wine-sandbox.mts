// Windows programs run in a sandbox.
//
// A Windows program is a stranger's code with the user's rights: on a
// Linux desktop, Wine alone lets it read every file of theirs (their SSH
// keys, browser profiles, Din's own data) and write anything it likes into
// ~/.config or ~/.local/share/applications. So every Wine process Din
// starts, its prefix's setup included, runs in a bubblewrap sandbox that
// sees what a Windows program has any business seeing:
//
//   - the system's programs and libraries (read-only), the GPU, sound,
//     controllers and the network;
//   - Din's Windows installation (the prefix), and the folders Windows has
//     too: Desktop, Documents, Downloads, Music, Pictures and Videos;
//   - the folder of a program or document opened from somewhere else (a
//     USB stick), when it's opened;
//   - nothing else of home: no dotfiles, no Din data, no session bus, no
//     `din` socket, no SSH or GPG agent.
//
// Its home is otherwise empty and thrown away, except where Wine writes the
// Start-menu shortcuts, icons and file types of what it installs: those go
// to a folder of their own (windowsShellDir), which Din reads (native-apps.mts)
// without trusting it: an entry from it runs a program in Din's prefix,
// in here, whatever its Exec line says.
//
// Every sandbox is set up the same, and they share one /tmp, where Wine
// keeps the socket of the wineserver every program in the prefix talks to.
// No pid namespace: the windows' pids are the ones Din sees, and Force Quit
// works. No IPC namespace either: X's shared-memory images need Xwayland's.
//
// Where bubblewrap is missing or can't make namespaces (a distribution
// that forbids them), programs run as they would under plain Wine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** The system: read-only, those that exist. */
const SYSTEM = [
  '/nix/store',
  '/run/current-system',
  '/run/opengl-driver',
  '/run/opengl-driver-32',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/opt',
  '/etc',
  '/sys',
  // Name lookups: NixOS's glibc asks nscd; systemd-resolved's stub.
  '/run/nscd',
  '/run/systemd/resolve',
];

/** Devices a program may use: the GPU, Wine's sync driver, sound, controllers. */
const DEVICES = ['/dev/dri', '/dev/ntsync', '/dev/snd', '/dev/input', '/dev/uinput'];

/** The home folders a program sees, the ones Windows has too. */
export const SHARED_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'];

/**
 * Variables a program doesn't get: ways out of the sandbox (the session
 * bus, Din's socket, agents holding keys), and Electron's.
 */
const WITHHELD = [
  'DBUS_SESSION_BUS_ADDRESS',
  'DIN_SOCKET',
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
  'GNOME_KEYRING_CONTROL',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
];

function home(): string {
  return os.homedir();
}

function dataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(home(), '.local/share');
}

function runtimeDir(): string {
  return process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `din-${os.userInfo().uid}`);
}

/**
 * Where Wine's Start-menu shortcuts, their icons and the file types
 * programs register land: `applications`, `icons`, `mime` and the rest, as
 * under ~/.local/share. Din lists what's here as installed Windows apps.
 */
export function windowsShellDir(): string {
  return path.join(dataHome(), 'din/windows-shell');
}

/** The sandbox's /tmp, shared by every Windows program (the wineserver's socket). */
function sharedTmp(): string {
  return path.join(runtimeDir(), 'din-windows/tmp');
}

/** The sandbox's /dev/shm, likewise shared. */
function sharedShm(): string {
  return path.join(runtimeDir(), 'din-windows/shm');
}

/** Where in the sandbox's home each of windowsShellDir's folders appears. */
function shellMounts(): [string, string][] {
  const shell = windowsShellDir();
  const share = path.join(home(), '.local/share');
  return [
    [path.join(shell, 'applications'), path.join(share, 'applications')],
    [path.join(shell, 'icons'), path.join(share, 'icons')],
    [path.join(shell, 'mime'), path.join(share, 'mime')],
    [path.join(shell, 'desktop-directories'), path.join(share, 'desktop-directories')],
    [path.join(shell, 'menus'), path.join(home(), '.config/menus')],
    [path.join(shell, 'desktop'), path.join(share, DESKTOP_LINKS)],
  ];
}

/**
 * Where Wine's copies of desktop shortcuts go: out of sight. A program's
 * shortcut on the desktop is its .lnk, in the Desktop folder (which is
 * the user's), and Din opens that; Wine's .desktop beside it would be the
 * same icon twice.
 */
const DESKTOP_LINKS = 'din-desktop-links';

/**
 * The sandbox's ~/.config/user-dirs.dirs: the user's folders where they
 * are, but the desktop Wine writes its .desktop copies to out of sight
 * (DESKTOP_LINKS). Wine links Windows' Desktop folder to the user's again
 * (windows-apps.mts, arrangeDrives).
 */
function userDirsFile(): string {
  const file = path.join(windowsShellDir(), 'user-dirs.dirs');
  const lines = [
    `XDG_DESKTOP_DIR="$HOME/.local/share/${DESKTOP_LINKS}"`,
    ...[['DOCUMENTS', 'Documents'], ['DOWNLOAD', 'Downloads'], ['MUSIC', 'Music'], ['PICTURES', 'Pictures'], ['VIDEOS', 'Videos']]
      .map(([key, name]) => `XDG_${key}_DIR="$HOME/${name}"`),
  ];
  const text = `${lines.join('\n')}\n`;
  if (fs.readFileSync(file, { encoding: 'utf8', flag: 'a+' }) !== text) fs.writeFileSync(file, text);
  return file;
}

/** Whether a path is a folder, following links. */
function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolve bubblewrap: `$DIN_BWRAP`, else on PATH. */
function bwrapBinary(): string | null {
  if (process.env.DIN_BWRAP) return process.env.DIN_BWRAP;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, 'bwrap');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

let sandboxWorks: Promise<string | null> | null = null;

/**
 * bubblewrap, when it's here and may make namespaces (checked once), else
 * null: programs then run unsandboxed, as before Din had one.
 */
export function sandboxAvailable(): Promise<string | null> {
  sandboxWorks ??= new Promise((resolve) => {
    const bwrap = bwrapBinary();
    if (!bwrap) {
      console.warn('[wine-sandbox] bubblewrap is missing; Windows programs run unsandboxed');
      resolve(null);
      return;
    }
    execFile(bwrap, ['--ro-bind', '/', '/', '--', 'true'], { timeout: 10_000 }, (error) => {
      if (error) console.warn('[wine-sandbox] bubblewrap can’t make a sandbox; Windows programs run unsandboxed:', error.message);
      resolve(error ? null : bwrap);
    });
  });
  return sandboxWorks;
}

/** What else a sandbox shows besides the fixed part. */
export interface SandboxOptions {
  /** Din's prefix, which programs may change. */
  prefix: string;
  /** Folders (or files) opened from outside the shared folders, writable. */
  share?: string[];
  /** Where the program starts. */
  cwd?: string;
}

/**
 * The command that runs `argv` in the sandbox, with `env` (the display's,
 * Wine's) less what the sandbox withholds. Returns `argv` itself where
 * there's no sandbox to be had.
 */
export async function sandboxed(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: SandboxOptions,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of WITHHELD) delete clean[name];
  const bwrap = await sandboxAvailable();
  if (!bwrap) return { argv, env: clean };

  const homeDir = home();
  const runtime = runtimeDir();
  for (const dir of [sharedTmp(), sharedShm(), options.prefix, ...shellMounts().map(([from]) => from)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const args: string[] = [
    '--unshare-user-try',
    '--unshare-uts',
    '--unshare-cgroup-try',
    // No controlling terminal to push keystrokes into (TIOCSTI).
    '--new-session',
    ...SYSTEM.flatMap((dir) => ['--ro-bind-try', dir, dir]),
    '--proc', '/proc',
    '--dev', '/dev',
    ...DEVICES.flatMap((dir) => ['--dev-bind-try', dir, dir]),
    ...hidrawDevices().flatMap((dev) => ['--dev-bind-try', dev, dev]),
    '--bind', sharedShm(), '/dev/shm',
    '--bind', sharedTmp(), '/tmp',
    // The X server's socket (Xwayland, or the Xvfb fallback), under /tmp.
    '--ro-bind-try', '/tmp/.X11-unix', '/tmp/.X11-unix',
    '--tmpfs', homeDir,
    '--tmpfs', runtime,
    '--chmod', '0700', runtime,
  ];

  // Sound: PipeWire, and its PulseAudio server.
  for (const name of ['pipewire-0', 'pulse']) {
    const file = path.join(runtime, name);
    args.push('--ro-bind-try', file, file);
  }
  // The Xvfb fallback's cookie.
  if (clean.XAUTHORITY && path.isAbsolute(clean.XAUTHORITY)) {
    args.push('--ro-bind-try', clean.XAUTHORITY, clean.XAUTHORITY);
  }

  // Wine itself, .NET and the rest of the Windows apps feature come through
  // links in Din's state folder, as do the fonts the user installed.
  const state = process.env.XDG_STATE_HOME || path.join(homeDir, '.local/state');
  for (const dir of [
    path.join(state, 'din/features'),
    path.join(dataHome(), 'fonts'),
    path.join(homeDir, '.fonts'),
    path.join(homeDir, '.config/fontconfig'),
  ]) {
    args.push('--ro-bind-try', dir, dir);
  }

  for (const name of SHARED_FOLDERS) {
    const dir = path.join(homeDir, name);
    if (isDirectory(dir)) args.push('--bind', dir, dir);
  }
  args.push('--bind', options.prefix, options.prefix);
  for (const [from, to] of shellMounts()) args.push('--bind', from, to);
  args.push('--ro-bind', userDirsFile(), path.join(homeDir, '.config/user-dirs.dirs'));

  for (const file of options.share ?? []) {
    const shared = shareFor(file, options.prefix);
    if (shared) args.push('--bind', shared, shared);
  }

  if (options.cwd) args.push('--chdir', options.cwd);
  return { argv: [bwrap, ...args, '--', ...argv], env: clean };
}

/**
 * What to show of a file opened from outside what a sandbox always has: its
 * folder, so a program finds the files beside it (its DLLs, its settings,
 * an installer's other parts), or the file alone where its folder is home
 * itself, a hidden one, or a folder above home or above the system. Null
 * when it's shown already, or isn't there.
 */
function shareFor(file: string, prefix: string): string | null {
  if (!path.isAbsolute(file) || !fs.existsSync(file)) return null;
  const homeDir = home();
  const shown = [prefix, ...SHARED_FOLDERS.map((name) => path.join(homeDir, name))];
  if (shown.some((dir) => within(file, dir))) return null;
  const folder = isDirectory(file) ? file : path.dirname(file);
  const hidden = (dir: string) => within(dir, homeDir) && path.relative(homeDir, dir).split(path.sep).some((part) => part.startsWith('.'));
  const tooMuch = (dir: string) => dir === homeDir || within(homeDir, dir) || dir.split(path.sep).filter(Boolean).length < 2 || hidden(dir);
  if (!tooMuch(folder)) return folder;
  return file === folder || hidden(file) ? null : file;
}

/** Raw HID devices, which Wine reads controllers through (most of them). */
function hidrawDevices(): string[] {
  try {
    return fs.readdirSync('/dev').filter((name) => /^hidraw\d+$/.test(name)).map((name) => `/dev/${name}`);
  } catch {
    return [];
  }
}
