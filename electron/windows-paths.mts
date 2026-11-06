// Paths between Windows and Din's desktop and apps.
//
// Din's own code, on the desktop and in every app, works in POSIX paths: it
// joins them with `/`, takes the name after the last `/`, and checks that a
// path is absolute by its leading `/`. Rather than teach a hundred places
// about drive letters and backslashes, on Windows the system side speaks
// that language to them: `C:\Users\Din\Desktop` crosses into the desktop as
// `/C:/Users/Din/Desktop` (the form a file: URL has), and comes back as
// `C:\Users\Din\Desktop`. `/` itself is the computer, whose folders are its
// drives (fs:readdir lists them). On Linux everything here is the identity.
//
// The translation is done where everything crosses: every ipcMain handler's
// arguments and result (electron/ipc-registry.mts), the bridge ports apps
// call the same handlers through (electron/din-apps.mts), and what main sends
// to any page. A string is translated only when the whole of it is a path of
// the other side's form, never a path in the middle of a sentence; channels
// that carry what the user wrote (passwords, mail, the clipboard, signers)
// are left alone entirely, as is the content of a file being written.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';

const isWindows = process.platform === 'win32';

/**
 * A Windows path on a drive: `C:\…` or `C:/…` (or just `C:`), all of the
 * string, with nothing in it a Windows file name can't hold.
 */
// eslint-disable-next-line no-control-regex
const NATIVE_DRIVE = /^([A-Za-z]):(?:[\\/][^<>:"|?*\x00-\x1f]*)?$/;
/** The same path as Din sees it: `/C:/…` (or `/C:`). */
// eslint-disable-next-line no-control-regex
const DIN_DRIVE = /^\/([A-Za-z]):(?:\/[^<>:"|?*\x00-\x1f]*)?$/;

/** A Windows path as Din's desktop and apps see it; anything else unchanged. */
export function dinPath(native: string): string {
  if (!isWindows) return native;
  const drive = NATIVE_DRIVE.exec(native);
  if (!drive) return native;
  // A drive's top is `/C:`, so a path's parent is its own form all the way up.
  const rest = native.slice(2).replace(/\\/g, '/').replace(/\/+$/, '');
  return `/${drive[1].toUpperCase()}:${rest}`;
}

/** A path from Din's desktop or an app as Windows names it; anything else unchanged. */
export function nativePath(din: string): string {
  if (!isWindows) return din;
  const drive = DIN_DRIVE.exec(din);
  if (!drive) return din;
  const rest = din.slice(3).replace(/\//g, '\\');
  return `${drive[1].toUpperCase()}:${rest || '\\'}`;
}

/** Whether a path from Din names the computer itself, whose folders are the drives. */
export function isComputerRoot(din: string): boolean {
  return isWindows && (din === '/' || din === '\\');
}

/** Channels whose values are what the user wrote, never translated. */
const UNTRANSLATED = /^(passwords|mail|clipboard|bunker|nostrd|napp-fetch|push|web-push|secret|askpass):/;

/** For channels whose arguments are partly content: the only ones that may be paths. */
const PATH_ARGS: Record<string, number[]> = {
  'fs:writeFile': [0],
  'pty:write': [],
};

type Convert = (value: string) => string;

/** A value with every string in it that is wholly a path converted, to a few levels deep. */
function deep(value: unknown, convert: Convert, depth = 0): unknown {
  if (typeof value === 'string') return convert(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = deep(item, convert, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let out: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(value)) {
    const next = deep(item, convert, depth + 1);
    if (next !== item) {
      out ??= { ...(value as Record<string, unknown>) };
      out[key] = next;
    }
  }
  return out ?? value;
}

/** Whether a channel's values are translated at all. */
function translated(channel: string): boolean {
  return isWindows && !UNTRANSLATED.test(channel);
}

/** A call's arguments from Din, with its paths in Windows' form. */
export function argsFromDin(channel: string, args: unknown[]): unknown[] {
  if (!translated(channel)) return args;
  const only = PATH_ARGS[channel];
  return args.map((arg, i) => (only && !only.includes(i) ? arg : deep(arg, nativePath)));
}

/** A result or message for Din, with its paths in Din's form. */
export function valueForDin(channel: string, value: unknown): unknown {
  if (!translated(channel)) return value;
  return deep(value, dinPath);
}

/** Every argument of a message main sends to a page, with its paths in Din's form. */
export function argsForDin(channel: string, args: unknown[]): unknown[] {
  // A terminal's output is whatever the program wrote.
  if (!translated(channel) || channel === 'pty:data') return args;
  return args.map((arg) => deep(arg, dinPath));
}

/**
 * Files Windows hides from its own file manager: the ones it marks hidden
 * and system in every folder, and what lies at a drive's or a profile's top.
 * Node can't read the attributes, so they go by name.
 */
const WINDOWS_HIDDEN = new Set([
  'desktop.ini', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'iconcache.db', '$recycle.bin',
  'system volume information', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log',
  'dumpstack.log.tmp', 'recovery', 'config.msi', '$windows.~bt', '$windows.~ws', '$winreagent',
  '$sysreset', 'msocache', 'documents and settings', 'programdata', 'bootmgr', 'bootnxt', 'boot',
  'appdata', 'application data', 'cookies', 'local settings', 'my documents', 'nethood', 'printhood',
  'recent', 'sendto', 'start menu', 'templates', 'intelgraphicsprofiles', 'onedrivetemp',
]);

/** Whether Windows hides a file or folder of this name. */
export function isWindowsHidden(name: string): boolean {
  if (!isWindows) return false;
  const lower = name.toLowerCase();
  return WINDOWS_HIDDEN.has(lower) || /^ntuser\.(dat|ini|pol)/.test(lower) || lower.startsWith('~$');
}

/** The computer's drives, as folders of `/`. */
export async function drives(): Promise<{ name: string; kind: 'directory'; symlink: false; size: null; mtimeMs: null }[]> {
  // A and B are floppy drives, which can stall a check for seconds.
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(
    letters.map((letter) =>
      fs.promises.stat(`${letter}:\\`).then(() => letter, () => null),
    ),
  );
  return found
    .filter((letter): letter is string => letter !== null)
    .map((letter) => ({ name: `${letter}:`, kind: 'directory', symlink: false, size: null, mtimeMs: null }));
}
