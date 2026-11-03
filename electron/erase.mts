// The erase bridge (window.dinos.erase, for Settings → About's Erase All
// Data and the Setup screen after it).
//
// Erasing is os/din-erase.sh's (DIN_ERASE): it checks the password and that
// the computer will start official DinOS, then stops Din and erases the
// computer, and restarts it. An erased computer with an encrypted disk has no
// password until Setup, which Din shows in place of the desktop while
// /var/lib/din/setup is there, gives it one through din-password's `setup`
// (DIN_PASSWORD), which only works then. Both run through sudo without
// asking, as Settings → Password's do. Where DIN_ERASE isn't set (a dev
// machine, another distro), the bridge reports erasing unavailable.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ipcMain } from 'electron';
import { computerPasswordSet } from './passwords.mts';
import { runCommand } from './system.mts';

const HELPER = process.env.DIN_ERASE;
const PASSWORD_HELPER = process.env.DIN_PASSWORD;
const SETUP_MARK = '/var/lib/din/setup';

export interface EraseStatus {
  available: boolean;
  /** Why it isn't: a live USB stick, or a disk installed before Btrfs. */
  reason: 'live' | 'layout' | 'unsupported' | null;
  encrypted: boolean;
  /** Whether the computer has a password, which erasing takes. */
  password: boolean;
  /** Whether the system the next boot starts is official DinOS. */
  official: boolean;
}

const UNSUPPORTED: EraseStatus = {
  available: false,
  reason: 'unsupported',
  encrypted: false,
  password: false,
  official: false,
};

/** What the Installer accepts: printable ASCII, since it's typed at boot. */
function isUsablePassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512 &&
    /^[\x20-\x7e]+$/.test(value);
}

/** `sudo -n` the helper with `args`, `input` on its stdin. */
function runHelper(helper: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', helper, ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.on('error', () => {
      // The helper exited before reading it; its stderr says why.
    });
    child.stdin.end(input);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').pop() || `${args[0]} exited ${code}`));
    });
  });
}

export function registerEraseHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('erase:status', async (event): Promise<EraseStatus> => {
    assertShellSender(event);
    if (!HELPER) return UNSUPPORTED;
    const { stdout } = await runCommand('sudo', ['-n', HELPER, 'status'], { timeout: 30_000 });
    return JSON.parse(stdout) as EraseStatus;
  });

  // Resolves only if it fails: otherwise Din is stopping, for the erase.
  ipcMain.handle('erase:start', async (event, password: unknown) => {
    assertShellSender(event);
    if (!HELPER) throw new Error('Erasing is for DinOS');
    if (password !== undefined && (typeof password !== 'string' || password.includes('\n'))) {
      throw new Error('Not a password');
    }
    await runHelper(HELPER, ['start'], password === undefined ? '' : `${password}\n`);
  });

  ipcMain.handle('erase:setup-needed', (event) => {
    assertShellSender(event);
    return !!PASSWORD_HELPER && existsSync(SETUP_MARK);
  });

  ipcMain.handle('erase:set-up', async (event, password: unknown) => {
    assertShellSender(event);
    if (!PASSWORD_HELPER) throw new Error('Setup is for DinOS');
    if (!isUsablePassword(password)) throw new Error('Not a usable password');
    await runHelper(PASSWORD_HELPER, ['setup'], `${password}\n`);
    // Passwords' vault is `din`'s to make, with the same password.
    await computerPasswordSet(password);
  });
}
