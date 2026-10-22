// The AirPlay bridge (window.airplay, for the menu bar and Settings →
// Display): sharing the screen with Apple TVs, AirPlay TVs, Rokus and other
// receivers on the network.
//
// The sending is deckmon's (https://git.shakespeare.diy, `deckmon`), a daemon
// that owns every session and answers one JSON object per line on
// $XDG_RUNTIME_DIR/deckmon.sock. DinOS runs it as a user service and names
// its binary in DIN_DECKMON; elsewhere a `deckmon` on PATH is used, and its
// daemon started on first use. Without either, the bridge reports itself
// unavailable and the shell shows nothing.
//
// Two ways to share:
//   - mirror: deckmon captures the primary display (wlroots screencopy, by
//     output name) and sends it, scaled into the receiver's screen.
//   - extend: deckmon plugs in a virtual display named after the receiver,
//     which cage adds beside the others like any monitor, and sends that. It
//     shows up in Settings → Display, where it's arranged like the rest.
// Either way the receiver also gets a sound output, made the default while
// it lasts, so sound plays there and the volume keys reach it.
//
// Receivers are found over mDNS: a scan every half minute, and one whenever
// the shell asks (the menu or Settings opening). deckmon's event stream
// keeps the sessions current, including a receiver asking for the PIN it
// shows on screen.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ipcMain } from 'electron';
import { runCommand } from './system.mts';

const SCAN_INTERVAL_MS = 30_000;
const SCAN_TIMEOUT_MS = 3_000;
/** How many scans in a row may miss a receiver before it's dropped. */
const SCAN_MISSES = 2;
/** Connecting waits on the receiver, and on the user typing its PIN. */
const CONNECT_TIMEOUT_MS = 6 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const WATCH_RETRY_MS = 10_000;

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
  /** The last session that ended with an error, for the shell to say so. */
  failure: { target: string; message: string; at: number } | null;
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
    for (const channel of ['airplay:scan', 'airplay:connect', 'airplay:code', 'airplay:disconnect']) {
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
      .then(() => undefined)
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
      } else if (typeof raw.target === 'string') {
        sessions.delete(raw.target);
        if (raw.state === 'ended' && typeof raw.error === 'string' && raw.error) {
          state = { ...state, failure: { target: raw.target, message: raw.error, at: Date.now() } };
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

  let scanning: Promise<void> | null = null;
  const scan = () => {
    scanning ??= (async () => {
      update({ scanning: true });
      try {
        const { devices = [] } = await send({ cmd: 'discover', timeout_ms: SCAN_TIMEOUT_MS }, SCAN_TIMEOUT_MS + REQUEST_TIMEOUT_MS);
        const found = new Set<string>();
        for (const d of devices) {
          if (typeof d.name !== 'string' || !d.name) continue;
          found.add(d.name);
          seen.set(d.name, {
            receiver: {
              name: d.name,
              host: typeof d.host === 'string' ? d.host : '',
              model: typeof d.model === 'string' ? d.model : '',
            },
            misses: 0,
          });
        }
        for (const [name, entry] of seen) {
          if (found.has(name)) continue;
          // A busy receiver can sit out a scan; one streaming from here stays.
          entry.misses += 1;
          if (entry.misses > SCAN_MISSES && !sessions.has(name)) seen.delete(name);
        }
      } catch (error) {
        console.warn('airplay: scan failed:', messageOf(error));
      } finally {
        const receivers = [...seen.values()].map((e) => e.receiver).sort((a, b) => a.name.localeCompare(b.name));
        update({ scanning: false, receivers });
        scanning = null;
      }
    })();
    return scanning;
  };

  /** A receiver the shell names, which must be one Din found. */
  const knownReceiver = (raw: unknown): string => {
    if (typeof raw !== 'string' || !seen.has(raw)) throw new Error('Unknown AirPlay receiver');
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

  ipcMain.handle('airplay:connect', async (event, rawTarget, rawMode) => {
    assertShellSender(event);
    const target = knownReceiver(rawTarget);
    const extend = rawMode === 'extend';
    const output = extend ? null : await primaryOutput().catch(() => null);
    const range = portRange();
    state = { ...state, failure: null };
    await send(
      {
        cmd: 'connect',
        target,
        options: {
          source: output ? { kind: 'monitor', name: output } : { kind: 'screen' },
          ...(range ? { port_range: range } : {}),
        },
        extras: extend ? { display: true, extend: 'right-of' } : { display: false },
      },
      CONNECT_TIMEOUT_MS,
    );
  });

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
    // Taking the display away and putting the sound back can take a moment.
    await send({ cmd: 'disconnect', target }, 30_000);
  });

  void startDaemon()
    .catch((error: unknown) => console.warn('airplay: starting deckmon:', messageOf(error)))
    .finally(() => {
      watch();
      void scan();
      setInterval(() => void scan(), SCAN_INTERVAL_MS);
    });
}
