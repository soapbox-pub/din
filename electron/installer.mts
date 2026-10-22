// The Installer bridge (window.installer, for the Installer app): puts
// DinOS on a computer's own disk from a live USB boot.
//
// The disk work is done as root by os/din-install.sh, which DinOS's
// launcher names in DIN_INSTALLER and the shell's user runs through sudo
// without a password. It decides for itself what may be installed where
// (only from a live boot, never onto the boot disk), so this side only
// relays: status in, progress out, and an encryption passphrase over the
// helper's stdin. Where DIN_INSTALLER isn't set (a dev machine, another
// distro) the bridge reports itself unavailable and the app never appears.
//
// An install runs for minutes, so it's tracked here rather than in the
// renderer: progress is pushed as `installer:progress` and can be read back
// with `installer:state` after a reload. The passphrase is held here too,
// only until the install succeeds, so a failed one can be retried.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ipcMain } from 'electron';
import { runCommand, CommandError } from './system.mts';

const HELPER = process.env.DIN_INSTALLER;

type Step = 'partition' | 'format' | 'copy' | 'boot';

/** Erase the disk, use its free space, or replace the DinOS on it but keep its files. */
type Mode = 'wipe' | 'free' | 'keep';

const MODES: readonly string[] = ['wipe', 'free', 'keep'];

interface InstallState {
  phase: 'idle' | 'running' | 'done' | 'failed';
  disk: string | null;
  mode: Mode | null;
  encrypted: boolean;
  step: Step | null;
  /** Percent of the copy step, the long one. */
  percent: number;
  error: string | null;
}

const STEPS: readonly string[] = ['partition', 'format', 'copy', 'boot'];

let state: InstallState = {
  phase: 'idle',
  disk: null,
  mode: null,
  encrypted: false,
  step: null,
  percent: 0,
  error: null,
};

/** The last install's passphrase, kept for a retry until one succeeds. */
let passphrase: string | null = null;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Printable ASCII only: it's typed at boot on a console with a US keymap,
 * before Din (and any other layout) is running.
 */
function isValidPassphrase(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512 &&
    /^[\x20-\x7e]+$/.test(value);
}

/** Whether an install is writing to a disk, which a restart would cut short. */
export function isInstalling(): boolean {
  return state.phase === 'running';
}

export function registerInstallerHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender, sendToShell } = options;

  const update = (next: Partial<InstallState>) => {
    state = { ...state, ...next };
    sendToShell('installer:progress', state);
  };

  ipcMain.handle('installer:status', async (event) => {
    assertShellSender(event);
    if (!HELPER) return { available: false };
    try {
      const { stdout } = await runCommand('sudo', ['-n', HELPER, 'status'], { timeout: 30_000 });
      return { available: true, ...JSON.parse(stdout) };
    } catch (error) {
      if (error instanceof CommandError && error.code === 'ENOENT') return { available: false };
      const stderr = error instanceof CommandError ? error.stderr.trim() : '';
      throw new Error(stderr.split('\n')[0] || messageOf(error), { cause: error });
    }
  });

  ipcMain.handle('installer:state', (event) => {
    assertShellSender(event);
    return state;
  });

  const start = (helper: string, disk: string, mode: Mode) => {
    const encrypted = passphrase !== null;
    update({ phase: 'running', disk, mode, encrypted, step: null, percent: 0, error: null });
    const args = ['-n', helper, 'install', disk, mode];
    if (encrypted) args.push('encrypt');
    const child = spawn('sudo', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {
      // The helper exited before reading it; its stderr says why.
    });
    child.stdin.end(passphrase ?? '');
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      const [kind, value] = line.split(' ');
      if (kind === 'step' && STEPS.includes(value)) {
        update({ step: value as Step });
      } else if (kind === 'progress') {
        const percent = Number.parseInt(value, 10);
        if (Number.isFinite(percent)) update({ percent: Math.max(0, Math.min(100, percent)) });
      }
    });
    child.on('error', (error) => {
      update({ phase: 'failed', error: messageOf(error) });
    });
    child.on('close', (code) => {
      if (state.phase !== 'running') return;
      if (code === 0) {
        passphrase = null;
        update({ phase: 'done', percent: 100 });
      } else {
        const reason = stderr.trim().split('\n').filter(Boolean).pop();
        update({ phase: 'failed', error: reason || `The installer stopped (exit ${code})` });
      }
    });
  };

  ipcMain.handle('installer:install', (event, disk, mode, newPassphrase) => {
    assertShellSender(event);
    if (!HELPER) throw new Error('Installing is not available here');
    if (state.phase === 'running') throw new Error('An install is already running');
    if (typeof disk !== 'string' || !/^\/dev\/[A-Za-z0-9/_-]+$/.test(disk)) {
      throw new Error('Not a disk');
    }
    if (typeof mode !== 'string' || !MODES.includes(mode)) throw new Error('Unknown install mode');
    if (newPassphrase !== null && !isValidPassphrase(newPassphrase)) {
      throw new Error('Not a usable passphrase');
    }
    passphrase = newPassphrase;
    start(HELPER, disk, mode as Mode);
  });

  ipcMain.handle('installer:retry', (event) => {
    assertShellSender(event);
    if (!HELPER) throw new Error('Installing is not available here');
    if (state.phase !== 'failed' || !state.disk || !state.mode) {
      throw new Error('There is no failed install to retry');
    }
    start(HELPER, state.disk, state.mode);
  });

  ipcMain.handle('installer:reboot', async (event) => {
    assertShellSender(event);
    if (state.phase === 'running') throw new Error('An install is running');
    await runCommand('systemctl', ['reboot'], { timeout: 15_000 });
  });
}
