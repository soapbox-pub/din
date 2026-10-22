// The updater bridge (window.updater, for Settings): keeps DinOS current.
//
// Releases are found, checked and staged for the next boot as root by
// os/din-update.sh, which DinOS's launcher names in DIN_UPDATER and the
// shell's user runs through sudo without a password, like the Installer's
// helper. It trusts nothing it's given, so this side only schedules it and
// relays its progress. Where DIN_UPDATER isn't set (a dev machine, another
// distro) the bridge reports itself unavailable.
//
// Updates are looked for a minute after Din starts and every six hours after,
// and whatever's newer is downloaded and staged right away; the restart that
// finishes it is the user's. Progress is pushed as `updater:progress`, and
// can be read back with `updater:state` after a reload.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ipcMain } from 'electron';
import { runCommand } from './system.mts';

const HELPER = process.env.DIN_UPDATER;

const FIRST_CHECK_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

type Step = 'download' | 'fetch' | 'install';

const STEPS: readonly string[] = ['download', 'fetch', 'install'];

interface UpdateState {
  available: boolean;
  /** Running from a USB stick, which isn't updated. */
  live: boolean;
  /** The running system's version. */
  current: string | null;
  /** The version the next boot starts, when it isn't the running one. */
  staged: string | null;
  phase: 'idle' | 'checking' | 'updating' | 'failed';
  /** The newer release being staged. */
  updatingTo: string | null;
  step: Step | null;
  /** Percent of the current step. */
  percent: number;
  /** When a check last finished, in ms since the epoch. */
  checkedAt: number | null;
  error: string | null;
}

let state: UpdateState = {
  available: false,
  live: false,
  current: null,
  staged: null,
  phase: 'idle',
  updatingTo: null,
  step: null,
  percent: 0,
  checkedAt: null,
  error: null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerUpdaterHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender, sendToShell } = options;

  const update = (next: Partial<UpdateState>) => {
    state = { ...state, ...next };
    sendToShell('updater:progress', state);
  };

  const readStatus = async (helper: string) => {
    const { stdout } = await runCommand('sudo', ['-n', helper, 'status'], { timeout: 30_000 });
    const status = JSON.parse(stdout) as { live: boolean; current: string | null; staged: string | null };
    update({ available: true, live: status.live, current: status.current, staged: status.staged });
  };

  const check = (helper: string): Promise<void> => new Promise((resolve) => {
    update({ phase: 'checking', updatingTo: null, step: null, percent: 0, error: null });
    const child = spawn('sudo', ['-n', helper, 'update'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      const [kind, value] = line.split(' ');
      if (kind === 'available') {
        update({ phase: 'updating', updatingTo: value });
      } else if (kind === 'step' && STEPS.includes(value)) {
        update({ step: value as Step, percent: 0 });
      } else if (kind === 'progress') {
        const percent = Number.parseInt(value, 10);
        if (Number.isFinite(percent)) update({ percent: Math.max(0, Math.min(100, percent)) });
      } else if (kind === 'staged') {
        update({ staged: value });
      }
    });
    child.on('error', (error) => {
      update({ phase: 'failed', error: messageOf(error), checkedAt: Date.now() });
      resolve();
    });
    child.on('close', (code) => {
      if (code === 0) {
        update({ phase: 'idle', updatingTo: null, step: null, percent: 0, checkedAt: Date.now() });
      } else {
        const reason = stderr.trim().split('\n').filter(Boolean).pop();
        update({
          phase: 'failed',
          error: reason || `The updater stopped (exit ${code})`,
          checkedAt: Date.now(),
        });
      }
      resolve();
    });
  });

  const start = (helper: string) => {
    if (state.phase === 'checking' || state.phase === 'updating') return;
    if (state.live) return;
    void check(helper);
  };

  ipcMain.handle('updater:state', (event) => {
    assertShellSender(event);
    return state;
  });

  ipcMain.handle('updater:check', (event) => {
    assertShellSender(event);
    if (!HELPER || !state.available) throw new Error('Updates are not available here');
    if (state.live) throw new Error('A live system isn\'t updated. Install DinOS to get updates.');
    start(HELPER);
  });

  ipcMain.handle('updater:reboot', async (event) => {
    assertShellSender(event);
    if (state.phase === 'updating') throw new Error('An update is being installed');
    await runCommand('systemctl', ['reboot'], { timeout: 15_000 });
  });

  if (!HELPER) return;
  const helper = HELPER;
  readStatus(helper).then(() => {
    if (state.live) return;
    setTimeout(() => start(helper), FIRST_CHECK_MS);
    setInterval(() => start(helper), CHECK_INTERVAL_MS);
  }).catch((error: unknown) => {
    console.error('updater: status failed:', messageOf(error));
  });
}
