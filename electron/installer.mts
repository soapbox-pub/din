// The Installer bridge (window.installer, for the Installer app): puts
// Aladdin on a computer's own disk from a live USB boot.
//
// The disk work is done as root by os/din-install.sh, which Aladdin's
// launcher names in DIN_INSTALLER and lets the shell's user run through sudo
// without a password - that one program, nothing else. It decides for itself
// what may be installed where (only from a live boot, never onto the boot
// disk), so this side only relays: status in, progress out. Where
// DIN_INSTALLER isn't set (a dev machine, another distro) the bridge reports
// itself unavailable and the app never appears.
//
// An install runs for minutes, so it's tracked here rather than in the
// renderer: progress is pushed as `installer:progress` and can be read back
// with `installer:state` after a reload.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ipcMain } from 'electron';
import { runCommand, CommandError } from './system.mts';

const HELPER = process.env.DIN_INSTALLER;

type Step = 'partition' | 'format' | 'copy' | 'boot';

interface InstallState {
  phase: 'idle' | 'running' | 'done' | 'failed';
  disk: string | null;
  mode: 'wipe' | 'free' | null;
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
  step: null,
  percent: 0,
  error: null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  ipcMain.handle('installer:install', (event, disk, mode) => {
    assertShellSender(event);
    if (!HELPER) throw new Error('Installing is not available here');
    if (state.phase === 'running') throw new Error('An install is already running');
    if (typeof disk !== 'string' || !/^\/dev\/[A-Za-z0-9/_-]+$/.test(disk)) {
      throw new Error('Not a disk');
    }
    if (mode !== 'wipe' && mode !== 'free') throw new Error('Unknown install mode');

    update({ phase: 'running', disk, mode, step: null, percent: 0, error: null });
    const child = spawn('sudo', ['-n', HELPER, 'install', disk, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
        update({ phase: 'done', percent: 100 });
      } else {
        const reason = stderr.trim().split('\n').filter(Boolean).pop();
        update({ phase: 'failed', error: reason || `The installer stopped (exit ${code})` });
      }
    });
  });

  ipcMain.handle('installer:reboot', async (event) => {
    assertShellSender(event);
    if (state.phase === 'running') throw new Error('An install is running');
    await runCommand('systemctl', ['reboot'], { timeout: 15_000 });
  });
}
