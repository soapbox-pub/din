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
// the old one before changing anything. Both go to it on stdin; Passwords'
// vault, which is `din`'s, follows here (passwords.mts). It also says
// what sudo asks for - approval in Din, the password, or nothing - and
// changes it, given the password to loosen it.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ipcMain } from 'electron';
import { computerPasswordChanged } from './passwords.mts';
import { runCommand } from './system.mts';

const HELPER = process.env.DIN_LOCK;
const PASSWORD_HELPER = process.env.DIN_PASSWORD;
const FINGER = /^(left|right)-(thumb|(index|middle|ring|little)-finger)$/;
let fingerprintOperation: { id?: string; cancel?: () => void } | undefined;

function fingerprintChange(operation: NonNullable<typeof fingerprintOperation>, run: () => Promise<void>) {
  if (fingerprintOperation) throw new Error('Another fingerprint change is in progress.');
  fingerprintOperation = operation;
  return Promise.resolve().then(run).finally(() => { fingerprintOperation = undefined; });
}

function fingerprintPassword(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\n\0]/.test(value)) {
    throw new Error('Enter your computer password.');
  }
  return `${value}\n`;
}

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

  ipcMain.handle('lock:fingerprint-status', async (event) => {
    assertShellSender(event);
    if (!HELPER) return { reader: null, fingers: [], enabled: false };
    const { stdout } = await runCommand('sudo', ['-n', HELPER, 'fingerprint-status'], { timeout: 10_000 });
    return JSON.parse(stdout);
  });

  ipcMain.handle('lock:fingerprint-enable', async (event, enabled: unknown, password: unknown) => {
    assertShellSender(event);
    if (!HELPER || typeof enabled !== 'boolean') throw new Error('Fingerprint unlock is not available here.');
    const input = enabled ? fingerprintPassword(password) : '';
    return fingerprintChange({}, () => runPasswordHelper(HELPER, [enabled ? 'fingerprint-enable' : 'fingerprint-disable'], input));
  });

  ipcMain.handle('lock:fingerprint-remove', async (event, finger: unknown) => {
    assertShellSender(event);
    if (!HELPER || typeof finger !== 'string' || !FINGER.test(finger)) throw new Error('Choose a valid finger.');
    return fingerprintChange({}, () => runPasswordHelper(HELPER, ['fingerprint-remove', finger], ''));
  });

  ipcMain.handle('lock:fingerprint-enroll', async (event, id: unknown, finger: unknown, password: unknown) => {
    assertShellSender(event);
    if (!HELPER || typeof id !== 'string' || id.length > 80 || typeof finger !== 'string' || !FINGER.test(finger)) {
      throw new Error('Invalid fingerprint setup request.');
    }
    const input = fingerprintPassword(password);
    const helper = HELPER;
    const operation: NonNullable<typeof fingerprintOperation> = { id };
    return fingerprintChange(operation, () => new Promise<void>((resolve, reject) => {
      const child = spawn('sudo', ['-n', helper, 'fingerprint-enroll', finger], { stdio: ['pipe', 'pipe', 'pipe'] });
      const cancel = () => child.stdin.end();
      operation.cancel = cancel;
      event.sender.once('destroyed', cancel);
      child.stdin.on('error', () => { /* The helper's stderr has the error. */ });
      child.stdin.write(input);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        if (event.sender.isDestroyed()) return;
        try {
          event.sender.send('lock:fingerprint-progress', id, JSON.parse(line));
        } catch {
          // The desktop may have gone away.
        }
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => {
        event.sender.removeListener('destroyed', cancel);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').pop() || 'The fingerprint couldn’t be saved.'));
      });
    }));
  });

  ipcMain.handle('lock:fingerprint-cancel', (event, id: unknown) => {
    assertShellSender(event);
    const operation = fingerprintOperation;
    if (operation && operation.id === id) operation.cancel?.();
  });

  ipcMain.handle('lock:change-password', async (event, old: unknown, next: unknown) => {
    assertShellSender(event);
    if (!PASSWORD_HELPER) throw new Error('The password can\'t be changed here');
    if (typeof old !== 'string' || old.includes('\n')) throw new Error('Not a password');
    if (!isUsablePassword(next)) throw new Error('Not a usable password');
    await runPasswordHelper(PASSWORD_HELPER, ['change'], `${old}\n${next}\n`);
    // Passwords' vault, if it shared the old one, isn't root's to re-key.
    await computerPasswordChanged(old, next);
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
