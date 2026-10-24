// The firmware bridge (window.firmware, for Settings): firmware updates
// through fwupd.
//
// fwupd knows which of the computer's devices it can update (its own UEFI
// firmware, docks, disks, fingerprint readers…), and fwupd-refresh's timer
// keeps LVFS's list of releases current. This runs fwupdmgr, whose path
// DinOS's launcher names in DIN_FWUPDMGR, as the shell's user; polkit lets it
// install firmware LVFS signed without a password (os/configuration.nix).
// Where DIN_FWUPDMGR isn't set (a dev machine, another distro) the bridge
// reports itself unavailable.
//
// Updates are looked for a little after Din starts and every six hours
// after, but never installed by themselves: firmware is riskier than the
// system, and fwupd wants the charger in for it. The user picks each one in
// Settings. The computer's own firmware is staged on /boot and applied by
// the next restart, which is the user's too. State is pushed as
// `firmware:progress`, and can be read back with `firmware:state`.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import { ipcMain } from 'electron';

const FWUPDMGR = process.env.DIN_FWUPDMGR;

// Every prompt fwupdmgr could stop at is either Din's to make or not worth
// making: reporting history to LVFS, refreshing old metadata (the timer
// does), enabling remotes, and restarting.
const FLAGS = ['--json', '--no-unreported-check', '--no-metadata-check', '--no-remote-check', '--no-reboot-check'];

const FIRST_CHECK_MS = 90_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const QUERY_TIMEOUT_MS = 2 * 60_000;

// fwupd's FwupdError for "nothing to do", e.g. no updates.
const EXIT_NOTHING_TO_DO = 2;
// FWUPD_UPDATE_STATE_NEEDS_REBOOT.
const UPDATE_STATE_NEEDS_REBOOT = 4;

interface FirmwareUpdate {
  deviceId: string;
  /** The device, e.g. "System Firmware" or "UEFI dbx". */
  name: string;
  vendor: string | null;
  /** The version the device has. */
  current: string | null;
  /** The newest release's. */
  version: string;
  summary: string | null;
  /** The release notes, as plain text. */
  description: string | null;
  /** Applied by the next restart rather than right away. */
  needsRestart: boolean;
}

interface FirmwareState {
  available: boolean;
  phase: 'idle' | 'checking' | 'installing' | 'failed';
  updates: FirmwareUpdate[];
  /** The device being updated. */
  installing: string | null;
  /** Devices whose new firmware the next restart applies. */
  pendingRestart: string[];
  /** When a check last finished, in ms since the epoch. */
  checkedAt: number | null;
  error: string | null;
}

interface FwupdRelease {
  Version?: string;
  Summary?: string;
  Description?: string;
}

interface FwupdDevice {
  DeviceId?: string;
  Name?: string;
  Vendor?: string;
  Version?: string;
  Flags?: string[];
  UpdateState?: number | string;
  Releases?: FwupdRelease[];
}

let state: FirmwareState = {
  available: !!FWUPDMGR,
  phase: 'idle',
  updates: [],
  installing: null,
  pendingRestart: [],
  checkedAt: null,
  error: null,
};

/** Whether firmware is being written, which a restart would cut short. */
export function isFlashing(): boolean {
  return state.phase === 'installing';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** fwupdmgr's exit code and output, and its error message (in JSON on stdout) when it fails. */
function fwupdmgr(args: string[], timeout?: number): Promise<{ code: number; stdout: string; message: string }> {
  return new Promise((resolve, reject) => {
    if (!FWUPDMGR) {
      reject(new Error('Firmware updates are not available here'));
      return;
    }
    const child = spawn(FWUPDMGR, [...args, ...FLAGS], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : null;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      let message = stderr.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        const parsed = JSON.parse(stdout) as { Error?: { Message?: string } };
        if (parsed.Error?.Message) message = parsed.Error.Message;
      } catch {
        // Not JSON; stderr has said what there was to say.
      }
      resolve({ code: code ?? 1, stdout, message });
    });
  });
}

async function query(args: string[]): Promise<FwupdDevice[]> {
  const { code, stdout, message } = await fwupdmgr(args, QUERY_TIMEOUT_MS);
  if (code === EXIT_NOTHING_TO_DO) return [];
  if (code !== 0) throw new Error(message || `fwupdmgr stopped (exit ${code})`);
  const parsed = JSON.parse(stdout) as { Devices?: FwupdDevice[] };
  return parsed.Devices ?? [];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', '#39': '\'' };

/** Release notes are AppStream markup (<p>, <ul>, <li>); Settings shows them as text. */
function plainText(markup: string): string {
  return markup
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => ENTITIES[name])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function toUpdate(device: FwupdDevice): FirmwareUpdate | null {
  const release = device.Releases?.[0];
  if (!device.DeviceId || !release?.Version) return null;
  return {
    deviceId: device.DeviceId,
    name: device.Name ?? 'Unknown device',
    vendor: device.Vendor ?? null,
    current: device.Version ?? null,
    version: release.Version,
    summary: release.Summary ?? null,
    description: release.Description ? plainText(release.Description) || null : null,
    needsRestart: device.Flags?.includes('needs-reboot') ?? false,
  };
}

function awaitsRestart(device: FwupdDevice): boolean {
  return device.UpdateState === UPDATE_STATE_NEEDS_REBOOT || device.UpdateState === 'needs-reboot';
}

export function registerFirmwareHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  /** Throws while something a restart would cut short is running. */
  assertSafeToPowerOff: () => void;
}): void {
  const { assertShellSender, sendToShell, assertSafeToPowerOff } = options;

  const update = (next: Partial<FirmwareState>) => {
    state = { ...state, ...next };
    sendToShell('firmware:progress', state);
  };

  const busy = () => state.phase === 'checking' || state.phase === 'installing';

  /** Look for updates; with `refresh`, get LVFS's newest list first. */
  const check = async (refresh: boolean) => {
    update({ phase: 'checking', error: null });
    try {
      if (refresh) {
        const { code, message } = await fwupdmgr(['refresh', '--force'], QUERY_TIMEOUT_MS);
        if (code !== 0 && code !== EXIT_NOTHING_TO_DO) {
          throw new Error(message || `fwupdmgr stopped (exit ${code})`);
        }
      }
      const [devices, updates] = await Promise.all([query(['get-devices']), query(['get-updates'])]);
      update({
        phase: 'idle',
        updates: updates.map(toUpdate).filter((u) => u !== null),
        pendingRestart: devices.filter(awaitsRestart).map((d) => d.Name ?? 'Unknown device'),
        checkedAt: Date.now(),
      });
    } catch (error) {
      update({ phase: 'failed', error: messageOf(error), checkedAt: Date.now() });
    }
  };

  ipcMain.handle('firmware:state', (event) => {
    assertShellSender(event);
    return state;
  });

  ipcMain.handle('firmware:check', async (event) => {
    assertShellSender(event);
    if (!FWUPDMGR) throw new Error('Firmware updates are not available here');
    if (busy()) return;
    await check(true);
  });

  ipcMain.handle('firmware:install', async (event, deviceId: unknown) => {
    assertShellSender(event);
    if (!FWUPDMGR) throw new Error('Firmware updates are not available here');
    if (busy()) throw new Error('Firmware is already being checked or updated');
    const target = state.updates.find((u) => u.deviceId === deviceId);
    if (typeof deviceId !== 'string' || !target) throw new Error('There is no update for that device');
    update({ phase: 'installing', installing: deviceId, error: null });
    let failure: string | null = null;
    try {
      const { code, message } = await fwupdmgr(['update', deviceId]);
      if (code !== 0) failure = message || `fwupdmgr stopped (exit ${code})`;
    } catch (error) {
      failure = messageOf(error);
    }
    update({ installing: null });
    await check(false);
    if (failure) {
      update({ phase: 'failed', error: failure });
      throw new Error(failure);
    }
  });

  ipcMain.handle('firmware:reboot', async (event) => {
    assertShellSender(event);
    assertSafeToPowerOff();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('systemctl', ['reboot'], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`systemctl reboot failed (exit ${code})`))));
    });
  });

  if (!FWUPDMGR) return;
  setTimeout(() => {
    if (!busy()) void check(false);
  }, FIRST_CHECK_MS);
  setInterval(() => {
    if (!busy()) void check(false);
  }, CHECK_INTERVAL_MS);
}
