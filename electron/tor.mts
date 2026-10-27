// Tor (window.tor - see preload.cjs, Settings → Wi-Fi and the Web
// Browser): finding it, how far it has got connecting, and the onion
// services websites point to.
//
// DinOS runs Tor from boot (os/configuration.nix). Elsewhere Din uses one
// that's running already: a system Tor on 9050, or Tor Browser's on 9150.
// Either way it's found by speaking SOCKS5 to it, and network.mts points the
// browser's Tor session at it. Browser tabs on .onion addresses, and only
// those, run in that session (keepTorSession). Tor's
// control socket, where Din may use it, says how far Tor has got
// connecting; without one, a Tor that answers counts as connected.
//
// Turning Tor on and off is DinOS's: os/din-tor.sh, which DinOS's launcher
// names in DIN_TOR and the shell's user runs through sudo without a
// password, like the time zone's helper.
//
// Onion-Location: an https site can name its onion service in a response
// header or a <meta http-equiv>, and the address bar offers to go there, as
// Tor Browser's does. The header reaches this module from whichever listener
// sees the session's responses (the ad blocker's extension in the persistent
// session, popups.mts's in the private one); the meta tag is read from an
// isolated world once the page's DOM is ready.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import net from 'node:net';
import { ipcMain } from 'electron';
import { setTorSocksPort } from './network.mts';
import { CommandError, runCommand } from './system.mts';

const HELPER = process.env.DIN_TOR;
/** Where DinOS keeps Tor turned off (os/din-tor.sh). */
const OFF_FILE = '/var/lib/din/tor-off';

/** A system Tor's SOCKS port, then Tor Browser's. */
const SOCKS_PORTS = [9050, 9150];
const CONTROL_TARGETS: net.NetConnectOpts[] = [
  { path: '/run/tor/control' },
  { path: '/var/run/tor/control' },
  { host: '127.0.0.1', port: 9051 },
];
const PROBE_TIMEOUT_MS = 2_000;

/** How often to look again: while Tor connects, while it should be starting, and otherwise. */
const CONNECTING_POLL_MS = 1_000;
const STARTING_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;

interface TorStatus {
  /** Whether Din can turn Tor on and off here (DinOS). */
  canToggle: boolean;
  /** Whether Tor is set to run; null where Din doesn't manage it. */
  enabled: boolean | null;
  /** The SOCKS port of the Tor Din found, or null. */
  port: number | null;
  /** How far Tor has got connecting, 0-100; null when it doesn't say. */
  progress: number | null;
  /** Tor's word for what it's doing, e.g. "Loading relay descriptors". */
  summary: string | null;
}

type AssertSender = (event: Electron.IpcMainInvokeEvent) => void;

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let status: TorStatus = { canToggle: Boolean(HELPER), enabled: null, port: null, progress: null, summary: null };

// ---------------------------------------------------------------------------
// Finding Tor
// ---------------------------------------------------------------------------

/** Whether a SOCKS5 proxy that needs no password answers on this port. */
function socksAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('error', () => done(false));
    // Version 5, one method: no authentication.
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.once('data', (data) => done(data.length >= 2 && data[0] === 5 && data[1] === 0));
  });
}

interface Bootstrap {
  progress: number;
  summary: string | null;
}

/** `KEY=value KEY="quoted value"` pairs of a control reply line. */
function replyValue(line: string, key: string): string | null {
  const match = new RegExp(`(?:^|\\s)${key}=("(?:[^"\\\\]|\\\\.)*"|\\S*)`).exec(line);
  if (!match) return null;
  const value = match[1];
  return value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
}

/** The AUTHENTICATE command PROTOCOLINFO's reply allows, or null if Din can't. */
function authenticateCommand(reply: string[]): string | null {
  const auth = reply.find((line) => line.startsWith('250-AUTH '));
  if (!auth) return null;
  const methods = (replyValue(auth, 'METHODS') ?? '').split(',');
  if (methods.includes('NULL')) return 'AUTHENTICATE';
  const cookieFile = replyValue(auth, 'COOKIEFILE');
  if (methods.includes('COOKIE') && cookieFile) {
    try {
      return `AUTHENTICATE ${fs.readFileSync(cookieFile).toString('hex')}`;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Ask one control port how far Tor has got connecting: PROTOCOLINFO,
 * AUTHENTICATE, GETINFO status/bootstrap-phase. Null when it can't be asked.
 */
function askBootstrap(target: net.NetConnectOpts): Promise<Bootstrap | null> {
  return new Promise((resolve) => {
    const socket = net.connect(target);
    let buffer = '';
    let lines: string[] = [];
    let step = 0;
    const done = (result: Bootstrap | null) => {
      socket.destroy();
      resolve(result);
    };
    const send = (command: string) => socket.write(`${command}\r\n`);
    const answered = (reply: string[]) => {
      if (step === 0) {
        const command = authenticateCommand(reply);
        if (!command) return done(null);
        step = 1;
        send(command);
      } else if (step === 1) {
        if (!reply[0]?.startsWith('250')) return done(null);
        step = 2;
        send('GETINFO status/bootstrap-phase');
      } else {
        const line = reply.find((l) => l.startsWith('250-status/bootstrap-phase=')) ?? '';
        const progress = Number.parseInt(replyValue(line, 'PROGRESS') ?? '', 10);
        send('QUIT');
        done(Number.isFinite(progress) ? { progress, summary: replyValue(line, 'SUMMARY') } : null);
      }
    };
    socket.setEncoding('utf8');
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(null));
    socket.once('error', () => done(null));
    socket.once('close', () => done(null));
    socket.once('connect', () => send('PROTOCOLINFO 1'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        lines.push(line);
        // "250-" goes on, "250 " is a reply's last line.
        if (/^\d{3} /.test(line)) {
          const reply = lines;
          lines = [];
          answered(reply);
        }
      }
    });
  });
}

async function bootstrap(): Promise<Bootstrap | null> {
  for (const target of CONTROL_TARGETS) {
    if ('path' in target && !fs.existsSync(target.path)) continue;
    const answer = await askBootstrap(target);
    if (answer) return answer;
  }
  return null;
}

function isConnecting(s: TorStatus): boolean {
  return s.port !== null && s.progress !== null && s.progress < 100;
}

let refreshing: Promise<TorStatus> | null = null;
let pollTimer: NodeJS.Timeout | null = null;

function schedule(): void {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = isConnecting(status)
    ? CONNECTING_POLL_MS
    : status.enabled === true && status.port === null
      ? STARTING_POLL_MS
      : IDLE_POLL_MS;
  pollTimer = setTimeout(() => void refresh(), delay);
}

/** Look for Tor again, and tell the shell if anything changed. */
function refresh(): Promise<TorStatus> {
  refreshing ??= (async () => {
    try {
      let port: number | null = null;
      for (const candidate of SOCKS_PORTS) {
        if (await socksAnswers(candidate)) {
          port = candidate;
          break;
        }
      }
      const phase = port === null ? null : await bootstrap();
      const next: TorStatus = {
        canToggle: Boolean(HELPER),
        enabled: HELPER ? !fs.existsSync(OFF_FILE) : null,
        port,
        progress: phase?.progress ?? null,
        summary: phase?.summary ?? null,
      };
      if (JSON.stringify(next) !== JSON.stringify(status)) {
        status = next;
        setTorSocksPort(port);
        sendToShell('tor:status', status);
      }
      return status;
    } finally {
      refreshing = null;
      schedule();
    }
  })();
  return refreshing;
}

/** The network changed: Tor may have to reconnect. */
export function torNetworkChanged(): void {
  void refresh();
}

async function helper(args: string[]): Promise<void> {
  if (!HELPER) throw new Error("Din can't turn Tor on and off on this system");
  try {
    await runCommand('sudo', ['-n', HELPER, ...args], { timeout: 30_000 });
  } catch (error) {
    // The helper says what went wrong on its last line.
    const reason = error instanceof CommandError ? error.stderr.trim().split('\n').pop() : '';
    throw reason ? new Error(reason) : error;
  }
}

// ---------------------------------------------------------------------------
// Onion-Location
// ---------------------------------------------------------------------------

/** A v3 onion service's address, with any subdomains. */
const ONION_HOST = /(^|\.)[a-z2-7]{56}\.onion$/;

function isOnionHost(hostname: string): boolean {
  return /(^|\.)onion\.?$/i.test(hostname);
}

/**
 * The onion service a page names, as Tor Browser takes it: only from an
 * https page that isn't on an onion service itself, and only an http(s)
 * address on one.
 */
function onionLocationFor(pageUrl: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== 'https:' || isOnionHost(page.hostname)) return null;
    const target = new URL(value.trim());
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (target.username || target.password || !ONION_HOST.test(target.hostname.toLowerCase())) return null;
    return target.href;
  } catch {
    return null;
  }
}

/** A URL as the response and the committed page both have it. */
function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

/** Onion-Location headers of recent top-level responses, by response URL. */
const headerOnions = new Map<string, { onion: string; at: number }>();
const HEADER_TTL_MS = 60_000;
/** Each browser tab's page's onion service, if it names one. */
const onionLocations = new Map<number, string>();
const tabs = new Set<Electron.WebContents>();

function setOnionLocation(contents: Electron.WebContents, onion: string | null): void {
  if ((onionLocations.get(contents.id) ?? null) === onion) return;
  if (onion) onionLocations.set(contents.id, onion);
  else onionLocations.delete(contents.id);
  sendToShell('tor:onion-location', { wcId: contents.id, url: onion });
}

/**
 * A top-level response in a browser session, with its Onion-Location
 * header (null without one). It may come in before the page commits or,
 * from the extension, just after.
 */
export function onionLocationResponse(url: string, header: string | null): void {
  const now = Date.now();
  for (const [key, entry] of headerOnions) if (now - entry.at > HEADER_TTL_MS) headerOnions.delete(key);
  const onion = onionLocationFor(url, header);
  if (!onion) return;
  const key = withoutHash(url);
  headerOnions.set(key, { onion, at: now });
  for (const tab of tabs) {
    if (!tab.isDestroyed() && withoutHash(tab.getURL()) === key) setOnionLocation(tab, onion);
  }
}

/** The Onion-Location header among a response's headers, whatever its case. */
export function onionLocationHeader(headers: Record<string, string[]> | undefined): string | null {
  for (const [name, values] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'onion-location') return values[0] ?? null;
  }
  return null;
}

/** An isolated world of its own, so the page's scripts can't stand in for the DOM's. */
const META_WORLD_ID = 1_337;
const READ_META = `(() => {
  const meta = document.querySelector('meta[http-equiv="onion-location" i]');
  return meta ? meta.getAttribute('content') : null;
})()`;

/** Follow a browser tab's pages for the onion services they name. */
export function attachOnionLocation(contents: Electron.WebContents): void {
  tabs.add(contents);
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) setOnionLocation(contents, null);
  });
  contents.on('did-navigate', (_event, url) => {
    const entry = headerOnions.get(withoutHash(url));
    if (entry) setOnionLocation(contents, entry.onion);
  });
  contents.on('dom-ready', () => {
    const url = contents.getURL();
    if (onionLocations.has(contents.id) || !url.startsWith('https:')) return;
    contents
      .executeJavaScriptInIsolatedWorld(META_WORLD_ID, [{ code: READ_META }])
      .then((content: unknown) => {
        const onion = onionLocationFor(url, content);
        if (onion && !contents.isDestroyed() && contents.getURL() === url) setOnionLocation(contents, onion);
      })
      .catch(() => {});
  });
  contents.once('destroyed', () => {
    tabs.delete(contents);
    onionLocations.delete(contents.id);
  });
}

/** Whether a URL is on an onion service. */
export function isOnionUrl(url: string): boolean {
  try {
    return isOnionHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Keep a browser tab's pages in the session that fits them: onion sites in
 * Tor's, everything else out of it. A link, script or redirect that crosses
 * over is stopped, and the shell loads it again in a surface in the other
 * session (the Web Browser's tor:move-tab listener).
 */
export function keepTorSession(contents: Electron.WebContents, inTor: boolean): void {
  // WebRTC would otherwise go around the proxy, and give away the address.
  if (inTor) contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  const guard = (event: Electron.Event, url: string) => {
    if (!/^(https?|nsite):/i.test(url) || isOnionUrl(url) === inTor) return;
    event.preventDefault();
    sendToShell('tor:move-tab', { wcId: contents.id, url });
  };
  contents.on('will-navigate', (event) => guard(event, event.url));
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame) guard(event, event.url);
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function registerTorHandlers(options: {
  assertShellSender: AssertSender;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;
  void refresh();

  ipcMain.handle('tor:status', (event) => {
    assertShellSender(event);
    return status;
  });

  ipcMain.handle('tor:refresh', (event) => {
    assertShellSender(event);
    return refresh();
  });

  ipcMain.handle('tor:set-enabled', async (event, enabled: unknown) => {
    assertShellSender(event);
    if (typeof enabled !== 'boolean') throw new Error('Invalid setting');
    await helper([enabled ? 'on' : 'off']);
    return refresh();
  });

  ipcMain.handle('tor:onion-location', (event, wcId: unknown) => {
    assertShellSender(event);
    return typeof wcId === 'number' ? (onionLocations.get(wcId) ?? null) : null;
  });
}
