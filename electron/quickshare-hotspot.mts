// Quick Share's Wi-Fi hotspot (electron/quickshare.mts): a phone sharing
// over Bluetooth moves to a WPA2 network this computer hosts, and shares at
// Wi-Fi speed. Android phones leave their own Wi-Fi while Quick Share's share
// sheet is open (Pixels do, for AirDrop compatibility), so the network both
// are on can't be the one they share over.
//
// The Wi-Fi card hosts it alongside its own connection, on the same channel
// (one radio, one channel), or on channel 6 when it isn't connected. Adding
// the interface needs root, so DinOS's launcher names a helper that sudo runs
// without a password (DIN_HOTSPOT, os/din-hotspot.sh); NetworkManager runs
// the network itself, from a profile it doesn't save, with a new name and
// password each time. Elsewhere there's no hotspot and shares stay on
// Bluetooth.
//
// It's up while something holds it (holdHotspot: a phone's share sheet open
// nearby, a share over Bluetooth), and for LINGER_MS after. It's down while
// the computer joins another network (withoutHotspot, network.mts): the card
// can't move its own connection to another channel while it hosts one.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { CommandError, runCommand } from './system.mts';

/** The hotspot's interface, which os/din-hotspot.sh adds; Settings → Wi-Fi leaves it alone (network.mts). */
export const HOTSPOT_IFACE = 'dinqs0';
const HELPER = process.env.DIN_HOTSPOT;
const CONNECTION = 'Din Quick Share';
/** This computer's address on it; NetworkManager hands phones the rest of the /24. */
const GATEWAY = '10.42.0.1';
/** How long it stays up once nothing holds it. */
const LINGER_MS = 5_000;
/** How long after failing to start it isn't tried again. */
const FAILED_MS = 5 * 60_000;
const COMMAND_MS = 30_000;
/** Tries at activating it while NetworkManager takes up the new interface. */
const ACTIVATE_TRIES = 5;

export interface Hotspot {
  ssid: string;
  password: string;
  gateway: string;
  /** Its channel's frequency, in MHz. */
  frequency: number;
}

let holds = 0;
let current: Promise<Hotspot | null> | null = null;
let downTimer: NodeJS.Timeout | null = null;
/** Up and down one at a time, in order. */
let queue: Promise<unknown> = Promise.resolve();
let failedAt = 0;
/** Networks being joined (withoutHotspot), during which it stays down. */
let switching = 0;

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reason(error: unknown): string {
  if (error instanceof CommandError) return error.stderr.trim().split('\n').pop() || error.message;
  return error instanceof Error ? error.message : String(error);
}

/** The frequency (MHz) this computer's own Wi-Fi connection is on, or null when it isn't on one. */
async function stationFrequency(): Promise<number | null> {
  const { stdout } = await runCommand('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device', 'status'], { timeout: COMMAND_MS });
  const device = stdout
    .split('\n')
    .map((line) => line.split(':'))
    .find(([iface, type, state]) => iface !== HOTSPOT_IFACE && type === 'wifi' && state === 'connected')?.[0];
  if (!device) return null;
  const list = await runCommand('nmcli', ['-t', '-f', 'IN-USE,FREQ', 'device', 'wifi', 'list', 'ifname', device, '--rescan', 'no'], {
    timeout: COMMAND_MS,
  });
  const active = list.stdout.split('\n').find((line) => line.startsWith('*:'));
  const mhz = active ? parseInt(active.slice(2), 10) : NaN;
  return Number.isFinite(mhz) ? mhz : null;
}

function channelOf(mhz: number): { band: 'bg' | 'a'; channel: number } | null {
  if (mhz === 2484) return { band: 'bg', channel: 14 };
  if (mhz >= 2412 && mhz <= 2472) return { band: 'bg', channel: (mhz - 2407) / 5 };
  if (mhz >= 5160 && mhz <= 5885) return { band: 'a', channel: (mhz - 5000) / 5 };
  return null;
}

async function up(): Promise<Hotspot | null> {
  if (!HELPER || Date.now() - failedAt < FAILED_MS) return null;
  try {
    const frequency = (await stationFrequency()) ?? 2437;
    const channel = channelOf(frequency);
    // 6 GHz needs WPA3, which phones' hotspot joining doesn't take.
    if (!channel) throw new Error(`the computer's Wi-Fi is on ${frequency} MHz, where it can't host a network`);
    await runCommand('sudo', ['-n', HELPER, 'up'], { timeout: COMMAND_MS });
    await runCommand('nmcli', ['connection', 'delete', CONNECTION], { timeout: COMMAND_MS }).catch(() => {});
    const ssid = `DIRECT-${crypto.randomBytes(2).toString('hex')}-Din`;
    const password = crypto.randomBytes(12).toString('base64url');
    // A profile NetworkManager doesn't save: it's gone when it's deleted, or NetworkManager stops.
    await runCommand(
      'nmcli',
      [
        'connection', 'add', 'save', 'no', 'type', 'wifi', 'ifname', HOTSPOT_IFACE, 'con-name', CONNECTION,
        'autoconnect', 'no', 'ssid', ssid,
        '802-11-wireless.mode', 'ap', '802-11-wireless.band', channel.band, '802-11-wireless.channel', String(channel.channel),
        'ipv4.method', 'shared', 'ipv4.addresses', `${GATEWAY}/24`, 'ipv6.method', 'disabled',
        'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', password,
        'wifi-sec.proto', 'rsn', 'wifi-sec.pairwise', 'ccmp', 'wifi-sec.group', 'ccmp',
      ],
      { timeout: COMMAND_MS },
    );
    // NetworkManager takes a moment to take up a new interface.
    for (let attempt = 1; ; attempt++) {
      try {
        await runCommand('nmcli', ['connection', 'up', CONNECTION], { timeout: COMMAND_MS });
        break;
      } catch (error) {
        if (attempt >= ACTIVATE_TRIES) throw error;
        await wait(1000);
      }
    }
    console.log(`quickshare: hotspot ${ssid} up on ${frequency} MHz`);
    return { ssid, password, gateway: GATEWAY, frequency };
  } catch (error) {
    console.warn(`quickshare: no hotspot, so shares over Bluetooth stay on Bluetooth: ${reason(error)}`);
    failedAt = Date.now();
    await down();
    return null;
  }
}

async function down(): Promise<void> {
  await runCommand('nmcli', ['connection', 'delete', CONNECTION], { timeout: COMMAND_MS }).catch(() => {});
  if (HELPER) await runCommand('sudo', ['-n', HELPER, 'down'], { timeout: COMMAND_MS }).catch(() => {});
}

/** Keep the hotspot up (starting it if it isn't) until the function this returns is called. */
export function holdHotspot(): () => void {
  holds++;
  clearTimeout(downTimer ?? undefined);
  downTimer = null;
  if (!switching) current ??= serial(up);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds > 0) return;
    downTimer = setTimeout(() => {
      downTimer = null;
      const was = current;
      current = null;
      if (was) void serial(async () => ((await was) ? down() : undefined));
    }, LINGER_MS);
  };
}

/** The hotspot once it's up, or null when there's none (nothing holds it, or it couldn't start). */
export function hotspot(): Promise<Hotspot | null> {
  return current ?? Promise.resolve(null);
}

/**
 * Join another network (`join`) with the hotspot down, even if something
 * holds it (a share waiting for it stays on Bluetooth): the card can't move
 * its own connection off the hotspot's channel. It comes back after, on the
 * new network's channel, if something still holds it; not after a failed
 * join, when the computer is on no network and a hotspot would keep it from
 * finding one (the next hold starts it).
 */
export async function withoutHotspot<T>(join: () => Promise<T>): Promise<T> {
  switching++;
  clearTimeout(downTimer ?? undefined);
  downTimer = null;
  const was = current;
  current = null;
  let joined = false;
  try {
    if (was) await serial(async () => ((await was) ? down() : undefined));
    const result = await join();
    joined = true;
    return result;
  } finally {
    if (--switching === 0 && joined && holds > 0) current ??= serial(up);
  }
}

/** Din is quitting: take the hotspot down without waiting. */
export function quitHotspot(): void {
  if (!current) return;
  current = null;
  const script = `nmcli connection delete "$1"; [ -z "$2" ] || sudo -n "$2" down`;
  spawn('sh', ['-c', script, 'sh', CONNECTION, HELPER ?? ''], { detached: true, stdio: 'ignore' }).unref();
}
