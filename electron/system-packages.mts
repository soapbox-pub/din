// Installing what one of Din's features needs from the host system's own
// package manager (window.dinos.packages): Xvfb for Linux apps, on a system
// that isn't DinOS (which comes with everything). The shell offers it where
// the feature says what's missing, as a button.
//
// It's the system's package manager, run with sudo. sudo has no terminal
// here, so it asks Din for the password (`sudo -A`, through din-askpass and
// electron/askpass.mts), and the desktop's dialog opens at once, since the
// user just asked for it. Where sudo.conf already names an askpass helper
// (DinOS), that one is used; elsewhere, Din's own from os/.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';

/** What a feature needs, by name. */
export type PackageFeature = 'xvfb';

interface Manager {
  /** The package manager's binary. */
  binary: string;
  /** Its arguments to install packages without asking. */
  install: string[];
  /** The packages that give each feature. */
  packages: Record<PackageFeature, string[]>;
}

/** Package managers, by binary, with the packages they name things by. */
const MANAGERS: Manager[] = [
  { binary: 'xbps-install', install: ['-Sy'], packages: { xvfb: ['xorg-server-xvfb'] } },
  { binary: 'apt-get', install: ['install', '-y'], packages: { xvfb: ['xvfb'] } },
  { binary: 'dnf', install: ['install', '-y'], packages: { xvfb: ['xorg-x11-server-Xvfb'] } },
  { binary: 'pacman', install: ['-S', '--needed', '--noconfirm'], packages: { xvfb: ['xorg-server-xvfb'] } },
  { binary: 'zypper', install: ['--non-interactive', 'install'], packages: { xvfb: ['xorg-x11-server-Xvfb'] } },
  { binary: 'apk', install: ['add'], packages: { xvfb: ['xvfb'] } },
];

/** The program whose presence means a feature's packages are installed. */
const PROVIDES: Record<PackageFeature, string> = { xvfb: 'Xvfb' };

const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Din's askpass helper, for a sudo that hasn't been given one (os/din-askpass.py). */
const ASKPASS_SCRIPT = path.join(import.meta.dirname, '../os/din-askpass.py');

export interface PackageStatus {
  installed: boolean;
  /** The command that installs it, to show; null where Din doesn't know this system's package manager. */
  command: string | null;
}

function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
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

function isFeature(raw: unknown): raw is PackageFeature {
  return typeof raw === 'string' && Object.hasOwn(PROVIDES, raw);
}

/** The command (sudo first) that installs a feature's packages here, or null. */
function installCommand(feature: PackageFeature): string[] | null {
  // DinOS is configured, not installed into.
  if (fs.existsSync('/etc/NIXOS')) return null;
  const manager = MANAGERS.find((m) => which(m.binary));
  if (!manager || !which('sudo')) return null;
  return ['sudo', manager.binary, ...manager.install, ...manager.packages[feature]];
}

function status(feature: PackageFeature): PackageStatus {
  const command = installCommand(feature);
  return { installed: which(PROVIDES[feature]) !== null, command: command?.join(' ') ?? null };
}

/**
 * An askpass helper sudo can run: a script of Din's in the runtime folder
 * that runs os/din-askpass.py, which isn't executable itself. Null where
 * there's none, and sudo uses sudo.conf's.
 */
function askpassHelper(): string | null {
  if (!fs.existsSync(ASKPASS_SCRIPT)) return null;
  const dir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const file = path.join(dir, 'din-askpass-helper.sh');
  try {
    fs.writeFileSync(file, `#!/bin/sh\nexec python3 -I '${ASKPASS_SCRIPT.replace(/'/g, `'\\''`)}' "$@"\n`, { mode: 0o700 });
    return file;
  } catch {
    return null;
  }
}

let installing: Promise<void> | null = null;

function install(feature: PackageFeature): Promise<void> {
  if (installing) return Promise.reject(new Error('Something else is being installed. Try again once it’s done.'));
  const command = installCommand(feature);
  if (!command) return Promise.reject(new Error('Din doesn’t know how to install it on this system.'));
  const [, ...args] = command;
  const env: NodeJS.ProcessEnv = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  const helper = sudoAskpass();
  if (helper) env.SUDO_ASKPASS = helper;
  installing = new Promise<void>((resolve, reject) => {
    // -A: no terminal here, so the password is asked for in Din.
    const child = spawn('sudo', ['-A', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), INSTALL_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && which(PROVIDES[feature])) {
        resolve();
        return;
      }
      const last = tail.trim().split('\n').pop() ?? '';
      reject(
        new Error(
          /no password was provided|password is required|incorrect password/i.test(tail)
            ? 'It wasn’t installed: no administrator password was given.'
            : last || `The installer failed (${code})`,
        ),
      );
    });
  }).finally(() => {
    installing = null;
  });
  return installing;
}

/** sudo's askpass: Din's helper, unless sudo.conf names one already. */
export function sudoAskpass(): string | null {
  try {
    if (/^\s*Path\s+askpass\s/m.test(fs.readFileSync('/etc/sudo.conf', 'utf8'))) return null;
  } catch {
    // No sudo.conf: nothing named there.
  }
  return askpassHelper();
}

export function registerSystemPackageHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('packages:status', (event, feature: unknown) => {
    assertShellSender(event);
    if (!isFeature(feature)) throw new Error('Unknown feature');
    return status(feature);
  });

  ipcMain.handle('packages:install', async (event, feature: unknown) => {
    assertShellSender(event);
    if (!isFeature(feature)) throw new Error('Unknown feature');
    await install(feature);
  });
}
