// The updater bridge (window.dinos.updater, for Settings): keeps DinOS current.
//
// DinOS builds its updates from Din's source, as root: din-update.service
// (configuration.nix) runs os/din-update.sh, which fetches the branch the
// system follows, builds it, and stages it for the next boot. It runs a few
// minutes after boot and every six hours, and when asked. DinOS's launcher
// names the script in DIN_UPDATER. The shell's user runs its `status`,
// `start` and `auto` commands through sudo without a password, and `source`
// (which repository and branch are built) only once sudo has asked. Where
// DIN_UPDATER isn't set (a dev machine, another distro) the bridge reports
// itself unavailable.
//
// The script trusts nothing it's given, so this side only relays: it reads
// the status again whenever the service's state file changes, and pushes it
// as `updater:progress`; `updater:state` reads it back after a reload. The
// restart that finishes an update is the user's.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import { ipcMain } from 'electron';
import { CommandError, runCommand } from './system.mts';

const HELPER = process.env.DIN_UPDATER;

/** Written by the script as a run goes (os/din-update.sh's STATE). */
const STATE_FILE = '/var/lib/dinos/state.json';
const WATCH_INTERVAL_MS = 2_000;
/** sudo may wait this long for the user to approve a new source. */
const APPROVAL_TIMEOUT_MS = 11 * 60_000;

type Step = 'fetch' | 'merge' | 'space' | 'build' | 'install';
/** Why an update failed, when it's the user's changes that stopped it (os/din-update.sh). */
type Reason = 'conflict' | 'dirty' | 'missing' | 'build';

const STEPS: readonly string[] = ['fetch', 'merge', 'space', 'build', 'install'];
const REASONS: readonly string[] = ['conflict', 'dirty', 'missing', 'build'];
const PHASES: readonly string[] = ['idle', 'checking', 'updating', 'failed'];

interface UpdateState {
  available: boolean;
  /** Running from a USB stick, which isn't updated. */
  live: boolean;
  /** The running system's release (os/version). */
  version: string | null;
  /** The commit the running system was built from. */
  current: string | null;
  /** The commit the next boot starts, when it isn't the running one. */
  staged: string | null;
  /** The repository updates are built from, and its branch. */
  url: string | null;
  branch: string | null;
  /** Whether the system updates by itself, rather than only when asked. */
  auto: boolean;
  /**
   * Whether the system has changes of the user's (from ~/DinOS), which
   * updates merge the branch into.
   */
  custom: boolean;
  /** How many commits of the user's it has, when known. */
  changes: number | null;
  phase: 'idle' | 'checking' | 'updating' | 'failed';
  /** The commit being built and staged. */
  updatingTo: string | null;
  step: Step | null;
  /** Percent of the build. */
  percent: number;
  /** When a check last finished, in ms since the epoch. */
  checkedAt: number | null;
  error: string | null;
  /** Set when the user's changes stopped the update, which the assistant can fix. */
  reason: Reason | null;
}

/** os/din-update.sh's `status`. */
interface HelperStatus {
  live: boolean;
  version: string | null;
  current: string | null;
  staged: string | null;
  url: string;
  branch: string;
  auto: boolean;
  phase: string;
  step: string | null;
  percent: number;
  target: string | null;
  error: string | null;
  reason: string | null;
  custom: boolean;
  changes: number | null;
  checkedAt: number | null;
}

let state: UpdateState = {
  available: false,
  live: false,
  version: null,
  current: null,
  staged: null,
  url: null,
  branch: null,
  auto: true,
  custom: false,
  changes: null,
  phase: 'idle',
  updatingTo: null,
  step: null,
  percent: 0,
  checkedAt: null,
  error: null,
  reason: null,
};

function messageOf(error: unknown): string {
  if (error instanceof CommandError) {
    const reason = error.stderr.trim().split('\n').filter(Boolean).pop();
    if (reason) return reason;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Whether an update is being added to the boot menu, which a restart would cut short. */
export function isUpdating(): boolean {
  return state.phase === 'updating' && state.step === 'install';
}

export function registerUpdaterHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  /** Throws while something a restart would cut short is running. */
  assertSafeToPowerOff: () => void;
}): void {
  const { assertShellSender, sendToShell, assertSafeToPowerOff } = options;

  // One status read at a time, and one more queued if anything changed
  // while it ran.
  let reading: Promise<void> | null = null;
  let again = false;

  const read = async (helper: string) => {
    const { stdout } = await runCommand('sudo', ['-n', helper, 'status'], { timeout: 30_000 });
    const status = JSON.parse(stdout) as HelperStatus;
    const phase = PHASES.includes(status.phase) ? status.phase as UpdateState['phase'] : 'idle';
    const step = status.step && STEPS.includes(status.step) ? status.step as Step : null;
    state = {
      available: true,
      live: status.live,
      version: status.version,
      current: status.current,
      staged: status.staged,
      url: status.url,
      branch: status.branch,
      auto: status.auto,
      custom: status.custom === true,
      changes: typeof status.changes === 'number' ? status.changes : null,
      phase,
      updatingTo: phase === 'updating' ? status.target : null,
      step: phase === 'updating' ? step : null,
      percent: Math.max(0, Math.min(100, Number(status.percent) || 0)),
      checkedAt: status.checkedAt,
      error: status.error,
      reason: status.reason && REASONS.includes(status.reason) ? status.reason as Reason : null,
    };
    sendToShell('updater:progress', state);
  };

  const refresh = (helper: string): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        try {
          await read(helper);
        } catch (error) {
          console.error('updater: status failed:', messageOf(error));
        }
      } while (again);
      reading = null;
    })();
    return reading;
  };

  const helperOf = (): string => {
    if (!HELPER || !state.available) throw new Error('Updates are not available here');
    return HELPER;
  };

  /** Run one of the script's commands: `-n` never asks, `-A` asks in Din. */
  const run = async (helper: string, sudo: '-n' | '-A', args: string[], timeout = 30_000) => {
    try {
      await runCommand('sudo', [sudo, helper, ...args], { timeout });
    } catch (error) {
      throw new Error(messageOf(error), { cause: error });
    } finally {
      void refresh(helper);
    }
  };

  ipcMain.handle('updater:state', (event) => {
    assertShellSender(event);
    if (HELPER) void refresh(HELPER);
    return state;
  });

  ipcMain.handle('updater:check', async (event) => {
    assertShellSender(event);
    const helper = helperOf();
    if (state.live) throw new Error('A live system isn\'t updated. Install DinOS to get updates.');
    await run(helper, '-n', ['start']);
  });

  ipcMain.handle('updater:setAuto', async (event, auto: unknown) => {
    assertShellSender(event);
    if (typeof auto !== 'boolean') throw new Error('Expected true or false');
    await run(helperOf(), '-n', ['auto', auto ? 'on' : 'off']);
  });

  ipcMain.handle('updater:setSource', async (event, url: unknown, branch: unknown) => {
    assertShellSender(event);
    if (typeof url !== 'string' || typeof branch !== 'string') throw new Error('Expected a URL and a branch');
    // The script checks both. sudo asks the user first.
    await run(helperOf(), '-A', ['source', url.trim(), branch.trim()], APPROVAL_TIMEOUT_MS);
  });

  ipcMain.handle('updater:reboot', async (event) => {
    assertShellSender(event);
    if (isUpdating()) throw new Error('An update is being installed');
    assertSafeToPowerOff();
    await runCommand('systemctl', ['reboot'], { timeout: 15_000 });
  });

  if (!HELPER) return;
  const helper = HELPER;
  void refresh(helper);
  fs.watchFile(STATE_FILE, { interval: WATCH_INTERVAL_MS, persistent: false }, () => {
    void refresh(helper);
  });
}
