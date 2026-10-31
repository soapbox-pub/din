// The AirPlay bridge (window.dinos.airplay, for the menu bar and Settings →
// Display): sharing the screen with Apple TVs, AirPlay TVs, Rokus and other
// receivers on the network.
//
// The sending is deckmon's (https://git.shakespeare.diy, `deckmon`), a daemon
// that owns every session and answers one JSON object per line on
// $XDG_RUNTIME_DIR/deckmon.sock. DinOS runs it as a user service and names
// its binary in DIN_DECKMON; elsewhere a `deckmon` on PATH is used, and its
// daemon started on first use. Without either, the bridge reports itself
// unavailable and the menu bar's panel says deckmon is missing.
//
// Two ways to share:
//   - mirror: deckmon captures the primary display (wlroots screencopy, by
//     output name) and sends it, scaled into the receiver's screen.
//   - extend: deckmon asks din-shell for a display with no screen, named
//     after the receiver, which din-shell adds beside the others like any
//     monitor, and sends that. It shows up in Settings → Display, where it's
//     arranged like the rest.
// Either way the receiver also gets a sound output, made the default while
// it lasts, so sound plays there and the volume keys reach it.
//
// Connecting to a receiver uses the way it was last shared, extending by
// default, as a monitor keeps its place when it's plugged back in. A receiver
// that refuses or drops the connection while it wakes up is tried again for
// a while by deckmon, the session staying `connecting`, as a Mac does; only
// when that gives up is it said, in a sentence (explainFailure), never in
// deckmon's own words, which go to the log. Switching
// a receiver that's streaming moves the session over without reconnecting
// (deckmon's `switch`; an older deckmon reconnects it, keeping the pairing,
// so no PIN again), and is remembered for next time.
//
// The display-switch key does the same switch (switchAirPlayMode).
//
// Receivers are found over mDNS: a scan every half minute, one whenever the
// shell asks (the menu or Settings opening), and one as soon as the computer
// joins a network (airplayNetworkChanged), then every few seconds for a
// minute while none has answered. deckmon's event stream keeps the sessions
// current, including a receiver asking for the PIN it shows on screen.
//
// The receivers found are remembered for the network they were found on
// (NetworkManager's connection, by UUID, so two networks that share a name
// aren't confused), and listed again as soon as the computer is back on it,
// until a scan there answers; from then on only what scans find is listed,
// so one that's gone drops off the list (and one tapped before the scan fails
// to connect, said as much). One not seen on its network for a month is
// forgotten. A receiver on this computer itself (a test one, on 127.0.0.1)
// or at a link-local address is never remembered.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { app, ipcMain } from 'electron';
import { runCommand } from './system.mts';

const SCAN_INTERVAL_MS = 30_000;
const SCAN_TIMEOUT_MS = 3_000;
/** How many scans in a row may miss a receiver before it's dropped. */
const SCAN_MISSES = 2;
/** While nothing has answered since joining a network, scans come this often... */
const SCAN_SOON_MS = 5_000;
/** ...for this long. */
const SCAN_SOON_FOR_MS = 60_000;
/** A remembered receiver not seen on its network for this long is forgotten. */
const REMEMBER_FOR_MS = 30 * 24 * 60 * 60_000;
/** When a receiver was last seen is written down at most this often. */
const SEEN_SAVE_MS = 60 * 60_000;
/** Connecting waits on the receiver, and on the user typing its PIN. */
const CONNECT_TIMEOUT_MS = 6 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const WATCH_RETRY_MS = 10_000;

export type AirPlayMode = 'mirror' | 'extend';

export interface AirPlayReceiver {
  /** The receiver's name, which deckmon connects to it by. */
  name: string;
  host: string;
  model: string;
}

export interface AirPlaySession {
  /** What the session was asked to connect to: the receiver's name. */
  target: string;
  name: string;
  state: 'connecting' | 'waiting_for_code' | 'streaming';
  /** What the receiver asks for while waiting for a code. */
  prompt: 'pin' | 'password' | 'code' | null;
  /** The receiver is a display of its own (extend), not a mirror. */
  extend: boolean;
  /** The display the receiver shows (the virtual one when extending). */
  output: string | null;
  audio: boolean;
}

export interface AirPlayState {
  available: boolean;
  scanning: boolean;
  receivers: AirPlayReceiver[];
  sessions: AirPlaySession[];
  /**
   * The last session that ended with an error, for the shell to say so:
   * CONNECTING when it never streamed (it couldn't connect).
   */
  failure: { target: string; message: string; connecting: boolean; at: number } | null;
}

/** deckmon's SessionInfo, as far as it's used here. */
interface DeckmonSession {
  target?: unknown;
  name?: unknown;
  state?: unknown;
  prompt?: unknown;
  audio?: unknown;
  error?: unknown;
  options?: { source?: { kind?: unknown; name?: unknown } };
  extras?: { display?: unknown };
}

interface DeckmonResponse {
  ok?: boolean;
  error?: string;
  devices?: { name?: unknown; host?: unknown; model?: unknown }[];
  sessions?: DeckmonSession[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** deckmon's binary: DinOS's, else one on PATH, else null. */
function findDeckmon(): string | null {
  const named = process.env.DIN_DECKMON;
  if (named) return fs.existsSync(named) ? named : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'deckmon');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** Where deckmon's daemon listens (its paths::socket). */
function socketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `deckmon-${process.getuid?.() ?? 0}`);
  return path.join(runtime, 'deckmon.sock');
}

/** The local UDP ports receivers send timing and sound control to, which a firewall must let in. */
function portRange(): [number, number] | null {
  const match = /^(\d+)-(\d+)$/.exec(process.env.DIN_AIRPLAY_PORTS ?? '');
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** Send one request to the daemon and read its one-line answer. */
function request(body: object, timeout = REQUEST_TIMEOUT_MS): Promise<DeckmonResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('AirPlay took too long to answer'));
    }, timeout);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`));
    createInterface({ input: socket }).once('line', (line) => {
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(line) as DeckmonResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** The daemon isn't there to talk to. */
function noDaemon(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

interface RememberedReceiver {
  host: string;
  model: string;
  /** When a scan last found it, in ms. */
  seen: number;
}

interface Config {
  /** How each receiver was last shared, by name. */
  modes: Record<string, AirPlayMode>;
  /** The receivers found on each network, by connection UUID, then name. */
  networks: Record<string, Record<string, RememberedReceiver>>;
}

/** The user's AirPlay config. */
function configPath(): string {
  return path.join(app.getPath('userData'), 'airplay.json');
}

let config: Config | null = null;

function readConfig(): Config {
  if (config) return config;
  config = { modes: {}, networks: {} };
  let data: { modes?: unknown; networks?: unknown } | null;
  try {
    data = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as typeof data;
  } catch {
    return config;
  }
  if (data?.modes && typeof data.modes === 'object') {
    for (const [name, mode] of Object.entries(data.modes)) {
      if (mode === 'mirror' || mode === 'extend') config.modes[name] = mode;
    }
  }
  if (data?.networks && typeof data.networks === 'object') {
    for (const [network, receivers] of Object.entries(data.networks)) {
      if (!receivers || typeof receivers !== 'object') continue;
      const kept: Record<string, RememberedReceiver> = {};
      for (const [name, r] of Object.entries(receivers as Record<string, Partial<RememberedReceiver> | null>)) {
        if (typeof r?.host === 'string' && typeof r.model === 'string' && typeof r.seen === 'number') {
          kept[name] = { host: r.host, model: r.model, seen: r.seen };
        }
      }
      config.networks[network] = kept;
    }
  }
  return config;
}

function writeConfig(): void {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(readConfig(), null, 2));
  } catch (error) {
    console.warn('airplay: could not save settings:', messageOf(error));
  }
}

function saveMode(target: string, mode: AirPlayMode): void {
  readConfig().modes[target] = mode;
  writeConfig();
}

/** Whether a host is this computer or link-local, so not a receiver to remember for a network. */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '' || h === 'localhost' || h === '::1' || /^127\./.test(h) || /^169\.254\./.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** The networks the computer is on: NetworkManager's active Wi-Fi and wired connections, by UUID. */
async function activeNetworks(): Promise<string[]> {
  try {
    const { stdout } = await runCommand('nmcli', ['-t', '-f', 'UUID,TYPE,STATE', 'connection', 'show', '--active'], {
      timeout: REQUEST_TIMEOUT_MS,
    });
    return stdout
      .split('\n')
      .map((line) => line.split(':'))
      .filter(([uuid, type, active]) => uuid && /^802-(11-wireless|3-ethernet)$/.test(type) && active === 'activated')
      .map(([uuid]) => uuid)
      .sort();
  } catch {
    return [];
  }
}

function toSession(raw: DeckmonSession): AirPlaySession | null {
  if (typeof raw.target !== 'string') return null;
  const state = raw.state;
  if (state !== 'connecting' && state !== 'waiting_for_code' && state !== 'streaming') return null;
  const prompt = raw.prompt === 'pin' || raw.prompt === 'password' || raw.prompt === 'code' ? raw.prompt : null;
  const source = raw.options?.source;
  return {
    target: raw.target,
    name: typeof raw.name === 'string' ? raw.name : raw.target,
    state,
    prompt: state === 'waiting_for_code' ? prompt ?? 'code' : null,
    extend: raw.extras?.display === true,
    output: source?.kind === 'monitor' && typeof source.name === 'string' ? source.name : null,
    audio: raw.audio === true,
  };
}

let state: AirPlayState = { available: false, scanning: false, receivers: [], sessions: [], failure: null };

/** Receivers by name, with how many scans in a row have missed them. */
const seen = new Map<string, { receiver: AirPlayReceiver; misses: number }>();

/**
 * Displays that are AirPlay receivers', by output name: the virtual ones
 * deckmon adds to extend the desktop. For Settings → Display.
 */
export function airplayDisplays(): Map<string, string> {
  return new Map(
    state.sessions.filter((s) => s.extend && s.output).map((s) => [s.output as string, s.name]),
  );
}

let switchMode: (() => void) | null = null;
let switching: Promise<void> | null = null;

/**
 * The display-switch key (F7 on ThinkPads): switch the receiver being shared
 * with between extending the desktop and mirroring it. Does nothing while
 * nothing is shared.
 */
export function switchAirPlayMode(): void {
  switchMode?.();
}

let networkChanged: (() => void) | null = null;

/** NetworkManager says something changed: the computer may be on another network. */
export function airplayNetworkChanged(): void {
  networkChanged?.();
}

export function registerAirPlayHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  /** The output Din shows its menu bar on, which mirroring sends. */
  primaryOutput: () => Promise<string | null>;
}): void {
  const { assertShellSender, sendToShell, primaryOutput } = options;
  const deckmon = findDeckmon();

  const update = (next: Partial<AirPlayState>) => {
    state = { ...state, ...next };
    sendToShell('airplay:changed', state);
  };

  ipcMain.handle('airplay:state', (event) => {
    assertShellSender(event);
    return state;
  });

  if (!deckmon) {
    for (const channel of ['airplay:scan', 'airplay:connect', 'airplay:mode', 'airplay:code', 'airplay:disconnect']) {
      ipcMain.handle(channel, (event) => {
        assertShellSender(event);
        throw new Error('AirPlay is not available here');
      });
    }
    return;
  }
  state = { ...state, available: true };

  /** Start the daemon if it isn't running: any deckmon command does. */
  let starting: Promise<void> | null = null;
  const startDaemon = () => {
    starting ??= runCommand(deckmon, ['status'], { timeout: REQUEST_TIMEOUT_MS })
      .then(
        () => undefined,
        (error: unknown) => {
          // `status` fails ("not connected") when nothing is shared; the daemon is up all the same.
          if (!fs.existsSync(socketPath())) throw error;
        },
      )
      .finally(() => {
        starting = null;
      });
    return starting;
  };

  /** A request, starting the daemon first if it isn't there. */
  const send = async (body: object, timeout?: number): Promise<DeckmonResponse> => {
    let response: DeckmonResponse;
    try {
      response = await request(body, timeout);
    } catch (error) {
      if (!noDaemon(error)) throw error;
      await startDaemon();
      response = await request(body, timeout);
    }
    if (!response.ok) throw new Error(response.error || 'AirPlay failed');
    return response;
  };

  // Sessions follow the daemon's event stream. When it goes away, so have
  // its sessions; it's watched again once it's back.
  const sessions = new Map<string, AirPlaySession>();
  const publishSessions = () => update({ sessions: [...sessions.values()] });

  /** Receivers that answered the connection being made to them (asked for a code, or streamed). */
  const answered = new Set<string>();
  /** Sessions that have streamed since they were last asked to connect. */
  const streamed = new Set<string>();
  /** Receivers the user stopped sharing with, whose session ending isn't a failure. */
  const cancelled = new Set<string>();
  /**
   * Why sharing with TARGET failed, in a sentence, from deckmon's MESSAGE.
   * deckmon has already tried again where that could help. A receiver the
   * last scan didn't find that never answered is most likely one remembered
   * from before that isn't there any more, or is off.
   */
  const explainFailure = (target: string, message: string): string => {
    if (!answered.has(target) && seen.get(target)?.misses !== 0) {
      return `${target} isn’t answering. Check that it’s on and on the same network as this computer.`;
    }
    if (/refused|reset|fill whole buffer|broken pipe|timed out|unreachable|no route|stopped answering|closed/i.test(message)) {
      return `${target} stopped answering. Check that it’s on, then try again.`;
    }
    if (/password|pairing|\bpin\b|authenticat|credential/i.test(message)) {
      return `${target} didn’t accept the code. Try again.`;
    }
    if (/already/i.test(message)) return message;
    return `Couldn’t share the screen with ${target}. Try again.`;
  };
  /** Say that sharing with TARGET failed, once, unless the user stopped it. */
  const reportFailure = (target: string, error: string) => {
    if (cancelled.has(target)) return;
    console.warn(`airplay: ${target}: ${error}`);
    const at = Date.now();
    const last = state.failure;
    if (last?.target === target && at - last.at < 5_000) return;
    const message = explainFailure(target, error);
    state = { ...state, failure: { target, message, connecting: !streamed.has(target), at } };
  };
  const watch = () => {
    const socket = net.createConnection(socketPath());
    socket.once('connect', () => socket.write('{"cmd":"watch"}\n'));
    createInterface({ input: socket }).on('line', (line) => {
      let event: { event?: string; session?: DeckmonSession };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        return;
      }
      if (event.event !== 'session' || !event.session) return;
      const raw = event.session;
      const session = toSession(raw);
      if (session) {
        sessions.set(session.target, session);
        if (session.state !== 'connecting') answered.add(session.target);
        if (session.state === 'streaming') streamed.add(session.target);
      } else if (typeof raw.target === 'string') {
        sessions.delete(raw.target);
        if (raw.state === 'ended' && typeof raw.error === 'string' && raw.error) {
          reportFailure(raw.target, raw.error);
        }
      }
      publishSessions();
    });
    socket.once('close', () => {
      if (sessions.size > 0) {
        sessions.clear();
        publishSessions();
      }
      setTimeout(watch, WATCH_RETRY_MS);
    });
    socket.once('error', (error) => {
      // A daemon that isn't running is started by the next scan.
      if (!noDaemon(error)) console.warn('airplay: watching deckmon:', messageOf(error));
    });
  };

  /** The networks the computer is on, as activeNetworks gives them. */
  let networks: string[] = [];
  /** A scan has answered on these networks, so what it found stands in for what's remembered. */
  let scannedHere = false;

  /** The receivers scans found, and until one answers, those remembered for these networks. */
  const listReceivers = (): AirPlayReceiver[] => {
    const receivers = new Map<string, AirPlayReceiver>();
    const { networks: remembered } = readConfig();
    for (const network of networks) {
      for (const [name, r] of Object.entries(remembered[network] ?? {})) {
        if (scannedHere && !sessions.has(name)) continue;
        if (Date.now() - r.seen < REMEMBER_FOR_MS) receivers.set(name, { name, host: r.host, model: r.model });
      }
    }
    for (const { receiver } of seen.values()) receivers.set(receiver.name, receiver);
    return [...receivers.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  /** Remember the receivers a scan found for the networks it ran on, and forget the old. */
  const remember = (found: AirPlayReceiver[], on: string[]) => {
    const { networks: remembered } = readConfig();
    const now = Date.now();
    let dirty = false;
    for (const network of on) {
      const saved = (remembered[network] ??= {});
      for (const r of found) {
        // A receiver on this computer (a test one) isn't the network's.
        if (isLocalHost(r.host)) continue;
        const old = saved[r.name];
        if (old && old.host === r.host && old.model === r.model && now - old.seen < SEEN_SAVE_MS) continue;
        saved[r.name] = { host: r.host, model: r.model, seen: now };
        dirty = true;
      }
    }
    for (const [network, saved] of Object.entries(remembered)) {
      for (const [name, r] of Object.entries(saved)) {
        if (now - r.seen < REMEMBER_FOR_MS) continue;
        delete saved[name];
        dirty = true;
      }
      if (Object.keys(saved).length === 0) {
        delete remembered[network];
        dirty = true;
      }
    }
    if (dirty) writeConfig();
  };

  let scanning: Promise<void> | null = null;
  /** Scans come quickly until this time, while nothing has answered. */
  let soonUntil = 0;
  let nextScan: NodeJS.Timeout | null = null;
  const scheduleScan = () => {
    if (nextScan) clearTimeout(nextScan);
    const soon = Date.now() < soonUntil && ![...seen.values()].some((e) => e.misses === 0);
    nextScan = setTimeout(() => void scan(), soon ? SCAN_SOON_MS : SCAN_INTERVAL_MS);
  };
  const scan = () => {
    scanning ??= (async () => {
      update({ scanning: true });
      const on = networks;
      try {
        const { devices = [] } = await send({ cmd: 'discover', timeout_ms: SCAN_TIMEOUT_MS }, SCAN_TIMEOUT_MS + REQUEST_TIMEOUT_MS);
        const found = new Map<string, AirPlayReceiver>();
        for (const d of devices) {
          if (typeof d.name !== 'string' || !d.name) continue;
          const receiver = {
            name: d.name,
            host: typeof d.host === 'string' ? d.host : '',
            model: typeof d.model === 'string' ? d.model : '',
          };
          found.set(d.name, receiver);
          seen.set(d.name, { receiver, misses: 0 });
        }
        for (const [name, entry] of seen) {
          if (found.has(name)) continue;
          // A busy receiver can sit out a scan; one streaming from here stays.
          entry.misses += 1;
          if (entry.misses > SCAN_MISSES && !sessions.has(name)) seen.delete(name);
        }
        // Not if the computer changed networks while it looked.
        if (on === networks) {
          scannedHere = true;
          remember([...found.values()], on);
        }
      } catch (error) {
        console.warn('airplay: scan failed:', messageOf(error));
      } finally {
        update({ scanning: false, receivers: listReceivers() });
        scanning = null;
        scheduleScan();
      }
    })();
    return scanning;
  };

  // On another network, what was found on the last one is gone (but what's
  // streaming stays), and this one's receivers are listed at once.
  let checkingNetworks: Promise<void> | null = null;
  /** A change came in while checking, which the check may have missed. */
  let checkAgain = false;
  const checkNetworks = (): Promise<void> => {
    if (checkingNetworks) {
      checkAgain = true;
      return checkingNetworks;
    }
    checkingNetworks = activeNetworks()
      .then((now) => {
        if (now.join() === networks.join()) return;
        networks = now;
        scannedHere = false;
        for (const name of seen.keys()) if (!sessions.has(name)) seen.delete(name);
        update({ receivers: listReceivers() });
        if (now.length === 0) return;
        soonUntil = Date.now() + SCAN_SOON_FOR_MS;
        if (scanning) void scanning.then(() => scan());
        else void scan();
      })
      .finally(() => {
        checkingNetworks = null;
        if (checkAgain) {
          checkAgain = false;
          void checkNetworks();
        }
      });
    return checkingNetworks;
  };
  networkChanged = () => void checkNetworks();

  /** A receiver the shell names, which must be one Din found or remembers here. */
  const knownReceiver = (raw: unknown): string => {
    if (typeof raw !== 'string' || !state.receivers.some((r) => r.name === raw)) {
      throw new Error('Unknown AirPlay receiver');
    }
    return raw;
  };
  const sessionTarget = (raw: unknown): string => {
    if (typeof raw !== 'string' || !sessions.has(raw)) throw new Error('Not sharing with that receiver');
    return raw;
  };

  ipcMain.handle('airplay:scan', async (event) => {
    assertShellSender(event);
    await scan();
  });

  /**
   * Share with a receiver as MODE. There's one spare connector, so while
   * another receiver is the external display this one mirrors. Extending
   * leaves deckmon to mirror instead where it can't add a display.
   */
  const start = async (target: string, mode: AirPlayMode) => {
    const extend =
      mode === 'extend' && ![...sessions.values()].some((s) => s.extend && s.target !== target);
    const output = extend ? null : await primaryOutput().catch(() => null);
    const range = portRange();
    state = { ...state, failure: null };
    answered.delete(target);
    streamed.delete(target);
    cancelled.delete(target);
    await send(
      {
        cmd: 'connect',
        target,
        options: {
          source: output ? { kind: 'monitor', name: output } : { kind: 'screen' },
          ...(range ? { port_range: range } : {}),
        },
        extras: extend ? { extend: 'right-of' } : { display: false },
      },
      CONNECT_TIMEOUT_MS,
    );
  };

  ipcMain.handle('airplay:connect', async (event, rawTarget) => {
    assertShellSender(event);
    const target = knownReceiver(rawTarget);
    // A failure is said the way a session that stops is (failure), so the
    // shell says it once even if it closed the menu meanwhile.
    try {
      await start(target, readConfig().modes[target] ?? 'extend');
    } catch (error) {
      reportFailure(target, messageOf(error));
      publishSessions();
    }
  });

  /** Remember MODE for a receiver, and switch it over if it's streaming. */
  const setMode = async (target: string, mode: AirPlayMode) => {
    saveMode(target, mode);
    const session = sessions.get(target);
    if (!session || session.state !== 'streaming' || session.extend === (mode === 'extend')) return;
    const extend = mode === 'extend' && ![...sessions.values()].some((s) => s.extend && s.target !== target);
    const output = extend ? null : await primaryOutput().catch(() => null);
    try {
      await send(
        {
          cmd: 'switch',
          target,
          source: output ? { kind: 'monitor', name: output } : { kind: 'screen' },
          extras: extend ? { display: true, extend: 'right-of' } : { display: false },
        },
        30_000,
      );
      return;
    } catch (error) {
      // A deckmon from before `switch` doesn't know it.
      if (!/unknown variant|bad request/i.test(messageOf(error))) throw error;
    }
    await send({ cmd: 'disconnect', target }, 30_000);
    await start(target, mode);
  };

  ipcMain.handle('airplay:mode', async (event, rawTarget, rawMode) => {
    assertShellSender(event);
    const target = knownReceiver(rawTarget);
    if (rawMode !== 'mirror' && rawMode !== 'extend') throw new Error('Invalid mode');
    await setMode(target, rawMode);
  });

  // The display-switch key flips the receiver being shared with: one that
  // extends goes back to mirroring, else a mirrored one becomes a display of
  // its own. Said on screen at once, as switching takes a few seconds.
  switchMode = () => {
    if (switching) return;
    const streaming = [...sessions.values()].filter((s) => s.state === 'streaming');
    const session = streaming.find((s) => s.extend) ?? streaming[0];
    if (!session) return;
    const mode: AirPlayMode = session.extend ? 'mirror' : 'extend';
    sendToShell('airplay:osd', { name: session.name, mode });
    switching = setMode(session.target, mode)
      .catch((error: unknown) => {
        reportFailure(session.target, messageOf(error));
        publishSessions();
      })
      .finally(() => {
        switching = null;
      });
  };

  ipcMain.handle('airplay:code', async (event, rawTarget, rawCode) => {
    assertShellSender(event);
    const target = sessionTarget(rawTarget);
    if (typeof rawCode !== 'string' || rawCode.length === 0 || rawCode.length > 64) {
      throw new Error('Invalid code');
    }
    await send({ cmd: 'code', target, code: rawCode });
  });

  ipcMain.handle('airplay:disconnect', async (event, rawTarget) => {
    assertShellSender(event);
    const target = sessionTarget(rawTarget);
    cancelled.add(target);
    // Taking the display away and putting the sound back can take a moment.
    await send({ cmd: 'disconnect', target }, 30_000);
  });

  // The receivers remembered for this network are listed before the daemon
  // is even up; joining it scans.
  void checkNetworks();
  void startDaemon()
    .catch((error: unknown) => console.warn('airplay: starting deckmon:', messageOf(error)))
    .finally(() => {
      watch();
      if (!scanning) void scan();
    });
}
