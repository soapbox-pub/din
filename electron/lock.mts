// The lock bridge (window.dinos.lock, for the shell's Lock menu item and
// Settings → Password).
//
// DinOS's lock screen is os/din-lock.py, which runs as root on a terminal of
// its own, beyond Din's reach; DinOS's launcher names it in DIN_LOCK, and
// Din asks it to lock through sudo. Only a computer with a password can be
// locked. Where DIN_LOCK isn't set (a dev machine, another distro), locking
// is the host's job and the bridge reports itself unavailable.
//
// The password itself - the disk's, sudo's, the lock screen's and nostrd's,
// all one - is changed by os/din-password.py (DIN_PASSWORD), which checks
// the old one before changing anything. Both go to it on stdin. It also says
// what sudo asks for - approval in Din, the password, or nothing - and
// changes it, given the password to loosen it.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import { ipcMain } from 'electron';
import { runCommand } from './system.mts';

const HELPER = process.env.DIN_LOCK;
const PASSWORD_HELPER = process.env.DIN_PASSWORD;

/** What the Installer accepts: printable ASCII, since it's typed at boot. */
function isUsablePassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512 &&
    /^[\x20-\x7e]+$/.test(value);
}

/** din-password with `args`, `input` on its stdin. */
function runPasswordHelper(helper: string, args: string[], input: string): Promise<void> {
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
      else reject(new Error(stderr.trim().split('\n').pop() || `din-password exited ${code}`));
    });
  });
}

export function registerLockHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('lock:available', async (event) => {
    assertShellSender(event);
    if (!HELPER) return false;
    try {
      const { stdout } = await runCommand('sudo', ['-n', HELPER, 'status'], { timeout: 10_000 });
      return stdout.trim() === 'available';
    } catch {
      return false;
    }
  });

  ipcMain.handle('lock:lock', async (event) => {
    assertShellSender(event);
    if (!HELPER) throw new Error('Locking is not available here');
    await runCommand('sudo', ['-n', HELPER, 'start'], { timeout: 10_000 });
  });

  ipcMain.handle('lock:change-password', async (event, old: unknown, next: unknown) => {
    assertShellSender(event);
    if (!PASSWORD_HELPER) throw new Error('The password can\'t be changed here');
    if (typeof old !== 'string' || old.includes('\n')) throw new Error('Not a password');
    if (!isUsablePassword(next)) throw new Error('Not a usable password');
    await runPasswordHelper(PASSWORD_HELPER, ['change'], `${old}\n${next}\n`);
  });

  ipcMain.handle('lock:sudo-mode', async (event) => {
    assertShellSender(event);
    if (!PASSWORD_HELPER) return 'password';
    const { stdout } = await runCommand('sudo', ['-n', PASSWORD_HELPER, 'sudo', 'status'], { timeout: 10_000 });
    const mode = stdout.trim();
    return mode === 'approve' || mode === 'skip' ? mode : 'password';
  });

  ipcMain.handle('lock:set-sudo-mode', async (event, mode: unknown, password: unknown) => {
    assertShellSender(event);
    if (!PASSWORD_HELPER) throw new Error('This is for DinOS');
    if (mode !== 'approve' && mode !== 'password' && mode !== 'skip') throw new Error('Not a choice');
    if (password !== undefined && (typeof password !== 'string' || password.includes('\n'))) {
      throw new Error('Not a password');
    }
    await runPasswordHelper(PASSWORD_HELPER, ['sudo', mode], password === undefined ? '' : `${password}\n`);
  });
}
