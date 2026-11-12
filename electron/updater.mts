// The updater bridge (window.dinos.updater, for Settings): keeps DinOS current.
//
// DinOS builds its updates from Din's source, as root: din-update.service
// (configuration.nix) runs os/din-update.sh, which fetches the branch the
// system follows, builds it, and stages it for the next boot. It runs a few
// minutes after boot and every six hours, and when asked. DinOS's launcher
// names the script in DIN_UPDATER. The shell's user runs its `status`,
// `start`, `auto`, `apply` and `restart-din` commands through sudo without a
// password, and `source`
// (which repository and branch are built) only once sudo has asked. Where
// DIN_UPDATER isn't set (a dev machine, another distro) the bridge reports
// itself unavailable. It names the running system's updater through
// /run/current-system, which moves when the system is switched to while Din
// runs on; sudo allows only the store path it resolves to, so it's resolved
// on every call.
//
// The script trusts nothing it's given, so this side only relays: it reads
// the status again whenever the service's state file changes or the system is
// switched, and pushes it
// as `updater:progress`; `updater:state` reads it back after a reload. What
// finishes an update is the user's: applying it now (`apply`, a system
// switch), then restarting Din if Din changed, or restarting the computer if
// the kernel did.
//
// `buildLocal` builds the user's own commits instead, from ~/DinOS (the
// `din update local` command, for the assistant's `dinos` skill): it names
// the exact commit to `local`, which sudo asks the user to approve, in the
// Assistant's conversation when it ran the command. It answers what's left
// to restart, which the command leaves to the user (or to its `--restart`).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { CommandError, runCommand } from './system.mts';
import { saveBeforeStopping } from './session-save.mts';

const HELPER = process.env.DIN_UPDATER;

/** Written by the script as a run goes (os/din-update.sh's STATE). */
const STATE_FILE = '/var/lib/dinos/state.json';
/** The running system; stat follows the link, so a switch changes its inode. */
const CURRENT_SYSTEM = '/run/current-system';
const WATCH_INTERVAL_MS = 2_000;
/** sudo may wait this long for the user to approve a new source. */
const APPROVAL_TIMEOUT_MS = 11 * 60_000;

type Step = 'fetch' | 'merge' | 'space' | 'build' | 'install';
/** Why an update failed, when it's the user's changes that stopped it (os/din-update.sh). */
type Reason = 'conflict' | 'dirty' | 'missing' | 'build';
/** What a system takes beyond switching to it: Din restarting, or the computer. */
type Restart = 'din' | 'reboot';

const STEPS: readonly string[] = ['fetch', 'merge', 'space', 'build', 'install'];
const REASONS: readonly string[] = ['conflict', 'dirty', 'missing', 'build'];
const RESTARTS: readonly string[] = ['din', 'reboot'];
/** A system switch restarts what changed, which can take a while. */
const APPLY_TIMEOUT_MS = 10 * 60_000;
const PHASES: readonly string[] = ['idle', 'checking', 'updating', 'failed'];
/** The user's copy of Din, which `buildLocal` builds from. */
const FORK = path.join(os.homedir(), 'DinOS');
/** Approval, then a whole system's build. */
const BUILD_LOCAL_TIMEOUT_MS = 3 * 60 * 60_000;
/** An Assistant conversation's id, for sudo to ask there (electron/askpass.mts). */
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;

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
  /**
   * What the running system still needs to be all of itself, after a switch
   * to it: Din restarting (a new Din), or the computer (a new kernel).
   */
  restart: Restart | null;
  /** What the staged system takes beyond applying it; null if nothing. */
  stagedNeeds: Restart | null;
  /** The security fixes on the branch the newest system lacks, oldest first. */
  security: SecurityFix[];
}

type Severity = 'low' | 'medium' | 'high' | 'critical';
const SEVERITIES: readonly string[] = ['low', 'medium', 'high', 'critical'];

/** A commit on the branch that fixes a security issue (its `Security:` trailer, os/din-update.sh). */
interface SecurityFix {
  commit: string;
  subject: string;
  severity: Severity | null;
}

function securityOf(value: unknown): SecurityFix[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((fix: unknown) => {
    if (typeof fix !== 'object' || fix === null) return [];
    const { commit, subject, severity } = fix as Record<string, unknown>;
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return [];
    return [{
      commit,
      subject: typeof subject === 'string' ? subject.slice(0, 200) : '',
      severity: typeof severity === 'string' && SEVERITIES.includes(severity) ? severity as Severity : null,
    }];
  });
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
  restart: string | null;
  stagedNeeds: string | null;
  custom: boolean;
  changes: number | null;
  checkedAt: number | null;
  security?: unknown;
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
  restart: null,
  stagedNeeds: null,
  security: [],
};

function messageOf(error: unknown): string {
  if (error instanceof CommandError) {
    const reason = error.stderr.trim().split('\n').filter(Boolean).pop();
    if (reason) return reason;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The store path sudo knows the updater by. */
function resolve(helper: string): string {
  try {
    return fs.realpathSync(helper);
  } catch {
    return helper;
  }
}

function restartOf(value: string | null | undefined): Restart | null {
  return value && RESTARTS.includes(value) ? value as Restart : null;
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
    const { stdout } = await runCommand('sudo', ['-n', resolve(helper), 'status'], { timeout: 30_000 });
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
      restart: restartOf(status.restart),
      stagedNeeds: restartOf(status.stagedNeeds),
      security: securityOf(status.security),
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

  /**
   * Run one of the script's commands: `-n` never asks, `-A` asks in Din, in
   * the conversation `session` if one's named. Resolves its output.
   */
  const run = async (helper: string, sudo: '-n' | '-A', args: string[], timeout = 30_000, session?: string) => {
    const command = ['sudo', sudo, resolve(helper), ...args];
    try {
      const { stdout } = session
        ? await runCommand('env', [`OPENCODE_SESSION_ID=${session}`, ...command], { timeout })
        : await runCommand(command[0], command.slice(1), { timeout });
      return stdout;
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

  ipcMain.handle('updater:replace', async (event) => {
    assertShellSender(event);
    const helper = helperOf();
    if (state.live) throw new Error('A live system isn\'t updated. Install DinOS to get updates.');
    await run(helper, '-n', ['replace']);
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

  ipcMain.handle('updater:apply', async (event) => {
    assertShellSender(event);
    await run(helperOf(), '-n', ['apply'], APPLY_TIMEOUT_MS);
  });

  ipcMain.handle('updater:buildLocal', async (event, ref: unknown, session: unknown) => {
    assertShellSender(event);
    const helper = helperOf();
    if (state.live) throw new Error('A live system isn\'t updated. Install DinOS to get updates.');
    if (typeof ref !== 'string' || !ref.trim() || ref.trim().startsWith('-')) throw new Error('Expected a branch or commit');
    let commit: string;
    try {
      const { stdout } = await runCommand('git', ['-C', FORK, 'rev-parse', '--verify', '--end-of-options', `${ref.trim()}^{commit}`], { timeout: 15_000 });
      commit = stdout.trim();
    } catch {
      throw new Error(`There's no ${ref.trim()} in ~/DinOS`);
    }
    const asker = typeof session === 'string' && SESSION_ID.test(session) ? session : undefined;
    const out = await run(helper, '-A', ['local', commit], BUILD_LOCAL_TIMEOUT_MS, asker);
    return { commit, restart: restartOf(out.trim().split('\n').pop()) };
  });

  // Din's end: systemd restarts din-shell.service once this has asked.
  ipcMain.handle('updater:restartDin', async (event) => {
    assertShellSender(event);
    assertSafeToPowerOff();
    await saveBeforeStopping();
    await run(helperOf(), '-n', ['restart-din']);
  });

  ipcMain.handle('updater:reboot', async (event) => {
    assertShellSender(event);
    if (isUpdating()) throw new Error('An update is being installed');
    assertSafeToPowerOff();
    await saveBeforeStopping();
    await runCommand('systemctl', ['reboot'], { timeout: 15_000 });
  });

  if (!HELPER) return;
  const helper = HELPER;
  void refresh(helper);
  fs.watchFile(STATE_FILE, { interval: WATCH_INTERVAL_MS, persistent: false }, () => {
    void refresh(helper);
  });
  // A `nixos-rebuild switch` by hand moves the system without writing the
  // state file, and what it leaves to restart is read from the system.
  fs.watchFile(CURRENT_SYSTEM, { interval: WATCH_INTERVAL_MS, persistent: false }, () => {
    void refresh(helper);
  });
}
