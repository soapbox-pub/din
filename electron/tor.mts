// Tor (window.dinos.tor - see preload.cjs, Settings → Wi-Fi and the Web
// Browser): finding it, and how far it has got connecting.
//
// DinOS runs Tor from boot (os/configuration.nix). Elsewhere Din uses one
// that's running already: a system Tor on 9050, or Tor Browser's on 9150.
// Either way it's found by speaking SOCKS5 to it, and network.mts points the
// browser's Tor session at it, through onion-proxy.mts, which makes
// plain-http onion sites https origins (onionRequest). Browser tabs on .onion
// addresses, and only those, run in that session (keepTorSession). Tor's
// control socket, where Din may use it, says how far Tor has got
// connecting; without one, a Tor that answers counts as connected.
//
// Turning Tor on and off is DinOS's: os/din-tor.sh, which DinOS's launcher
// names in DIN_TOR and the shell's user runs through sudo without a
// password, like the time zone's helper.
//
// The onion services sites name (Onion-Location) are site-locations.mts's.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import net from 'node:net';
import { ipcMain } from 'electron';
import { addNavigationClientHints } from './client-hints.mts';
import { setTorSocksPort } from './network.mts';
import { isPlainOnionHost, markTlsOnionHost, tlsOnionHosts, watchTlsOnionHosts } from './onion-proxy.mts';
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
// Onion sites
// ---------------------------------------------------------------------------

function isOnionHost(hostname: string): boolean {
  return /(^|\.)onion\.?$/i.test(hostname);
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
 * What becomes of a request in the Tor session before it goes out (ahead of
 * the ad blocker, which has the session's one onBeforeRequest). Onion sites
 * run as https, as Tor Browser's onion sites are secure contexts: an
 * http:// onion address on the default port goes to https://, which the
 * onion proxy serves however the site does (electron/onion-proxy.mts). Other
 * onion addresses go as they are, since Tor encrypts them anyway; the tab
 * lets them load (allowRunningInsecureContent). Plain http to anywhere else
 * is mixed content, so a page's requests go to https or, for a WebSocket,
 * nowhere. Null: on its way.
 */
export function onionRequest(details: Electron.OnBeforeRequestListenerDetails): Electron.CallbackResponse | null {
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return null;
  }
  const onion = isOnionHost(url.hostname);
  if (url.protocol === 'ws:') return onion ? null : { cancel: true };
  if (url.protocol !== 'http:') return null;
  if (onion && url.port) return null;
  // A clearnet page goes as it is, as Tor Browser lets it (keepTorSession).
  if (!onion && details.resourceType === 'mainFrame') return null;
  url.protocol = 'https:';
  return { redirectURL: url.href };
}

/**
 * Tell a plain-http onion site what it would hear from Tor Browser: that its
 * pages are on http://, in the Origin and Referer of their requests to it.
 * Sites check those against their own scheme (Django's CSRF check does).
 * Only for requests to the same site: a cross-origin request's Origin is what
 * its CORS answer must match, and the page's is https.
 */
export function secureOnionSites(s: Electron.Session): void {
  // The session's one onBeforeSendHeaders listener, so it also gives every
  // page and frame the client hints Electron leaves off (client-hints.mts).
  s.webRequest.onBeforeSendHeaders({ urls: ['https://*/*', 'wss://*.onion/*'] }, (details, callback) => {
    const headers = details.requestHeaders;
    addNavigationClientHints(details, headers);
    let host: string;
    try {
      const url = new URL(details.url);
      if (!url.hostname.endsWith('.onion') || !isPlainOnionHost(url.hostname)) {
        callback({ requestHeaders: headers });
        return;
      }
      host = url.host;
    } catch {
      callback({ requestHeaders: headers });
      return;
    }
    const secure = `https://${host}`;
    for (const name of Object.keys(headers)) {
      const value = headers[name];
      const header = name.toLowerCase();
      if (header === 'origin' && value === secure) {
        headers[name] = `http://${host}`;
      } else if (header === 'referer' && (value === secure || value.startsWith(`${secure}/`))) {
        headers[name] = `http://${host}${value.slice(secure.length)}`;
      }
    }
    callback({ requestHeaders: headers });
  });

  // A site served plain that sends its visitor to https:// on itself has TLS
  // of its own (Facebook's does): it can't know its page is https already,
  // so it would send the same URL round forever. The Location header as
  // sent, since a relative one comes out as https here too.
  s.webRequest.onBeforeRedirect({ urls: ['https://*.onion/*'] }, (details) => {
    try {
      const url = new URL(details.url);
      if (!isPlainOnionHost(url.hostname)) return;
      const location = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === 'location')?.[1][0] ?? '';
      if (!/^https:\/\//i.test(location)) return;
      const target = new URL(location);
      if (target.hostname === url.hostname && !target.port) markTlsOnionHost(url.hostname);
    } catch {
      // Not a URL: not a redirect to anything.
    }
  });
}

/**
 * Keep a browser tab's onion sites in Tor's session. A link, script or
 * redirect from a clearnet page to one is stopped, and the shell loads it
 * again in a surface in Tor's session (the Web Browser's tor:move-tab
 * listener). A Tor tab never leaves on its own: a clearnet page it goes to
 * loads in Tor's session too, through Tor, as in Tor Browser, since a page
 * that could send its tab out could learn the visitor's address (a script
 * setting location, a redirect). Only the user typing an address takes a tab
 * out. nsite:// stays out of Tor: its relays and Blossom servers are reached
 * directly.
 */
export function keepTorSession(contents: Electron.WebContents, inTor: boolean): void {
  // WebRTC would otherwise go around the proxy, and give away the address.
  if (inTor) contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  const guard = (event: Electron.Event, url: string) => {
    if (inTor) {
      if (/^nsite:/i.test(url)) event.preventDefault();
      return;
    }
    if (!/^https?:/i.test(url) || !isOnionUrl(url)) return;
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

  // Which onion sites have TLS of their own: the rest run as https behind the
  // onion proxy, but the Web Browser shows their address as the http:// it is.
  ipcMain.handle('tor:tls-hosts', (event) => {
    assertShellSender(event);
    return tlsOnionHosts();
  });
  watchTlsOnionHosts((hosts) => sendToShell('tor:tls-hosts', hosts));
}
