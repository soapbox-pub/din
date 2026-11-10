// Installing what Din's features need from the host system's own package
// manager, on a system that isn't DinOS (which comes with everything, or
// has it as optional features of its own, electron/features.mts). Off DinOS
// these are Settings → Optional Features and `din features`
// (electron/features.mts asks here), and the button beside a message
// saying something's missing (window.dinos.packages: Xvfb, for Linux apps).
//
// CATALOG says, for each feature, what shows it's installed (programs on
// PATH, or files) and which packages give it on each distribution's package
// manager: apt (Debian, Ubuntu, Mint, Pop!_OS), dnf (Fedora, RHEL), pacman
// (Arch, Manjaro, EndeavourOS), zypper (openSUSE), xbps (Void) and apk
// (Alpine). One a distribution doesn't package isn't offered there.
// Nothing here removes packages: what else uses them is the system's to
// know, and its own tools' to say.
//
// It's the system's package manager, run with sudo. sudo has no terminal
// here, so it asks Din for the password (`sudo -A`, through din-askpass and
// electron/askpass.mts), and the desktop's dialog opens at once, since the
// user just asked for it. Where sudo.conf already names an askpass helper
// (DinOS), that one is used; elsewhere, Din's own from os/. runAsAdmin is
// that, for the other things Din does as root here (electron/firewall.mts).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { which } from './system.mts';

type ManagerId = 'apt' | 'dnf' | 'pacman' | 'zypper' | 'xbps' | 'apk';

interface Manager {
  id: ManagerId;
  /** The package manager's binary. */
  binary: string;
  /** Its arguments to install packages without asking. */
  install: string[];
  /** A script that runs first, as root, in the same password: apt's lists go stale. */
  before?: string;
}

/** Package managers, in the order they're looked for. */
const MANAGERS: Manager[] = [
  {
    id: 'apt',
    binary: 'apt-get',
    // Waiting out unattended-upgrades' hold on dpkg, rather than failing at once.
    install: ['-o', 'DPkg::Lock::Timeout=120', 'install', '-y'],
    // sudo's env_reset drops what Din sets, so debconf is told here not to ask.
    before: 'export DEBIAN_FRONTEND=noninteractive; apt-get update -q >/dev/null 2>&1 || true',
  },
  { id: 'dnf', binary: 'dnf', install: ['install', '-y'] },
  { id: 'pacman', binary: 'pacman', install: ['-S', '--needed', '--noconfirm'] },
  { id: 'zypper', binary: 'zypper', install: ['--non-interactive', 'install'] },
  { id: 'xbps', binary: 'xbps-install', install: ['-Sy'] },
  { id: 'apk', binary: 'apk', install: ['add'] },
];

/**
 * What shows a feature is there: a program on PATH, or an absolute path;
 * or any one of several, named as a person would know it.
 */
type Need = string | { label: string; any: string[] };

export interface SystemFeature {
  title: string;
  description: string;
  /** About what installing it takes, in bytes. */
  size: number;
  needs: Need[];
  packages: Partial<Record<ManagerId, string[]>>;
}

/** The same packages, by the same names, everywhere. */
function everywhere(...names: string[]): Record<ManagerId, string[]> {
  return { apt: names, dnf: names, pacman: names, zypper: names, xbps: names, apk: names };
}

const MB = 1000 * 1000;

/** WebKitGTK 4.1's library, where distributions put it. */
const WEBKIT_LIBRARIES = [
  '/usr/lib64/libwebkit2gtk-4.1.so.0',
  '/usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0',
  '/usr/lib/aarch64-linux-gnu/libwebkit2gtk-4.1.so.0',
  '/usr/lib/libwebkit2gtk-4.1.so.0',
];

/**
 * Din's features and what gives them, in the order Settings lists them.
 * The ids DinOS's optional features have (os/configuration.nix) are the same
 * here, so what asks about one (dictation, Windows apps) asks either.
 */
export const CATALOG: Record<string, SystemFeature> = {
  windows: {
    title: 'Windows apps',
    description: 'Run Windows programs (Wine).',
    size: 900 * MB,
    needs: [{ label: 'Wine', any: ['wine', 'wine64'] }],
    packages: everywhere('wine'),
  },
  vms: {
    title: 'Virtual machines',
    description: 'Run Windows, macOS and Linux in a window (QEMU).',
    size: 450 * MB,
    needs: ['qemu-system-x86_64', 'qemu-img'],
    packages: {
      apt: ['qemu-system-x86', 'qemu-utils', 'swtpm', 'swtpm-tools', 'ovmf'],
      dnf: ['qemu-system-x86', 'qemu-img', 'swtpm', 'swtpm-tools', 'edk2-ovmf'],
      pacman: ['qemu-desktop', 'qemu-img', 'swtpm', 'edk2-ovmf'],
      zypper: ['qemu-x86', 'qemu-tools', 'swtpm', 'qemu-ovmf-x86_64'],
    },
  },
  containers: {
    title: 'Linux containers',
    description: 'Run software made for other Linux systems (Podman, distrobox).',
    size: 200 * MB,
    needs: ['podman', 'distrobox'],
    packages: everywhere('podman', 'distrobox'),
  },
  webkit: {
    title: 'Web view for Linux apps',
    description: 'Needed by some downloaded Linux apps (WebKitGTK).',
    size: 200 * MB,
    needs: [{ label: 'WebKitGTK', any: WEBKIT_LIBRARIES }],
    packages: {
      apt: ['libwebkit2gtk-4.1-0'],
      dnf: ['webkit2gtk4.1'],
      pacman: ['webkit2gtk-4.1'],
      zypper: ['libwebkit2gtk-4_1-0'],
      xbps: ['libwebkit2gtk41'],
      apk: ['webkit2gtk-4.1'],
    },
  },
  xvfb: {
    title: 'Linux apps',
    description: 'Lets more Linux apps open in Din (Xvfb).',
    size: 10 * MB,
    needs: ['Xvfb'],
    packages: {
      apt: ['xvfb'],
      dnf: ['xorg-x11-server-Xvfb'],
      pacman: ['xorg-server-xvfb'],
      zypper: ['xorg-x11-server-Xvfb'],
      xbps: ['xorg-server-xvfb'],
      apk: ['xvfb'],
    },
  },
  'screen-recording': {
    title: 'Screen recording',
    description: 'Record your screen in Screenshot and Studio.',
    size: 5 * MB,
    needs: ['wf-recorder'],
    packages: everywhere('wf-recorder'),
  },
  archives: {
    title: 'Archives',
    description: 'Open ZIP, 7z and RAR files in Files.',
    size: 15 * MB,
    needs: ['bsdtar', 'unar', { label: '7-Zip', any: ['7zz', '7z'] }],
    packages: {
      apt: ['libarchive-tools', 'unar', 'p7zip-full'],
      dnf: ['bsdtar', 'unar', 'p7zip', 'p7zip-plugins'],
      pacman: ['libarchive', 'unarchiver', '7zip'],
      zypper: ['bsdtar', 'unar', '7zip'],
      xbps: ['bsdtar', 'unar', '7zip'],
      apk: ['libarchive-tools', 'unar', '7zip'],
    },
  },
  phones: {
    title: 'Phones over USB',
    description: 'See your Android phone or iPhone in Files when it’s plugged in.',
    size: 5 * MB,
    needs: ['jmtpfs', 'ifuse'],
    packages: {
      apt: ['jmtpfs', 'ifuse', 'libimobiledevice-utils'],
      dnf: ['jmtpfs', 'ifuse', 'libimobiledevice-utils'],
    },
  },
  printing: {
    title: 'Print previews',
    description: 'Show page previews when you print.',
    size: 5 * MB,
    needs: ['pdftoppm', 'pdfinfo'],
    packages: {
      apt: ['poppler-utils'],
      dnf: ['poppler-utils'],
      pacman: ['poppler'],
      zypper: ['poppler-tools'],
      xbps: ['poppler-utils'],
      apk: ['poppler-utils'],
    },
  },
};

const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Din's askpass helper, for a sudo that hasn't been given one (os/din-askpass.py). */
const ASKPASS_SCRIPT = path.join(import.meta.dirname, '../os/din-askpass.py');

export interface PackageStatus {
  installed: boolean;
  /** The command that installs it, to show; null where Din doesn't know this system's package manager. */
  command: string | null;
}

function present(need: Need): boolean {
  return (typeof need === 'string' ? [need] : need.any).some((one) => (path.isAbsolute(one) ? fs.existsSync(one) : which(one) !== null));
}

export function isCatalogued(raw: unknown): raw is string {
  return typeof raw === 'string' && Object.hasOwn(CATALOG, raw);
}

/** Whether a feature's programs are all here. */
export function isInstalled(id: string): boolean {
  return CATALOG[id]?.needs.every(present) ?? false;
}

/**
 * What of a feature isn't here, by name ("unar", "7-Zip"), where some of it
 * is: empty when it's all here, or none of it.
 */
export function missingParts(id: string): string[] {
  const needs = CATALOG[id]?.needs ?? [];
  const missing = needs.filter((need) => !present(need));
  if (missing.length === needs.length) return [];
  return missing.map((need) => (typeof need === 'string' ? need : need.label));
}

let manager: Manager | null | undefined;

/**
 * This system's package manager, where Din installs things: not DinOS or
 * NixOS, which are configured, or an image-based system (Silverblue,
 * Kinoite, Bazzite), whose dnf can't install into it.
 */
export function packageManager(): Manager | null {
  if (manager !== undefined) return manager;
  manager = process.platform !== 'linux' || fs.existsSync('/etc/NIXOS') || fs.existsSync('/run/ostree-booted') || !which('sudo')
    ? null
    : MANAGERS.find((m) => which(m.binary)) ?? null;
  return manager;
}

/** The packages that give a feature here, or null where there are none. */
function packagesFor(id: string): string[] | null {
  const m = packageManager();
  return (m && CATALOG[id]?.packages[m.id]) || null;
}

/** Whether Din can install a feature here, from the system's packages. */
export function canInstall(id: string): boolean {
  return packagesFor(id) !== null;
}

/** The command (sudo first) that installs a feature's packages here, or null. */
export function installCommand(id: string): string[] | null {
  const m = packageManager();
  const packages = packagesFor(id);
  return m && packages ? ['sudo', m.binary, ...m.install, ...packages] : null;
}

function status(id: string): PackageStatus {
  return { installed: isInstalled(id), command: installCommand(id)?.join(' ') ?? null };
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

/**
 * Run a command as root through sudo, the password asked for in Din. Rejects
 * with what it said last, or that no password was given.
 */
export function runAsAdmin(args: string[], timeout = INSTALL_TIMEOUT_MS): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const helper = sudoAskpass();
  if (helper) env.SUDO_ASKPASS = helper;
  return new Promise<void>((resolve, reject) => {
    // -A: no terminal here, so the password is asked for in Din.
    const child = spawn('sudo', ['-A', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const last = tail.trim().split('\n').pop() ?? '';
      reject(
        new Error(
          /no password was provided|password is required|incorrect password/i.test(tail)
            ? 'No password was entered.'
            : /is not in the sudoers file|may not run sudo/i.test(tail)
              ? 'Your account can’t install software on this computer.'
              : last || `It stopped (${code})`,
        ),
      );
    });
  });
}

let installing: Promise<void> | null = null;

/** Install a feature's packages, asking for the administrator password in Din. */
export function install(id: string): Promise<void> {
  if (installing) return Promise.reject(new Error('Something else is installing. Try again in a moment.'));
  const m = packageManager();
  const packages = packagesFor(id);
  if (!m || !packages) return Promise.reject(new Error('Din can’t install this on your system.'));
  const command = [m.binary, ...m.install, ...packages];
  const args = m.before ? ['sh', '-c', `${m.before}; exec "$@"`, 'sh', ...command] : command;
  installing = runAsAdmin(args)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.startsWith('No password') ? 'Not installed: no password was entered.' : message);
    })
    .then(() => {
      if (!isInstalled(id)) {
        const missing = missingParts(id);
        throw new Error(`${CATALOG[id].title} didn’t install completely${missing.length > 0 ? `: ${missing.join(', ')} is still missing` : ''}.`);
      }
    })
    .finally(() => {
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
    if (!isCatalogued(feature)) throw new Error('Unknown feature');
    return status(feature);
  });

  ipcMain.handle('packages:install', async (event, feature: unknown) => {
    assertShellSender(event);
    if (!isCatalogued(feature)) throw new Error('Unknown feature');
    await install(feature);
  });
}
