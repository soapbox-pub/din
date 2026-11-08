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
// Elsewhere, where no Tor is running, Settings → Wi-Fi's Set Up Tor gets one
// of Din's own, as Settings → Assistant's Install OpenCode does: the Tor
// Project's Expert Bundle for Linux, downloaded into ~/.local/share/din/tor,
// its checksum taken from the release's signed list (checked against the Tor
// Browser Developers' key where gpg is there to check it), and run by Din as
// the user, from login while it's on, on a SOCKS port of its own. Din looks
// for a newer bundle now and then, and moves to it. A torrc there is read
// too, for bridges and the like.
//
// The onion services sites name (Onion-Location) are site-locations.mts's.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app, ipcMain } from 'electron';
import { setTorSocksPort } from './network.mts';
import { isPlainOnionHost, markTlsOnionHost, tlsOnionHosts, watchTlsOnionHosts } from './onion-proxy.mts';
import { CommandError, runCommand } from './system.mts';

const HELPER = process.env.DIN_TOR;
/** Where DinOS keeps Tor turned off (os/din-tor.sh). */
const OFF_FILE = '/var/lib/din/tor-off';

/** Din's own Tor, where it isn't DinOS's. */
const OWN_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'din/tor');
const OWN_BUNDLE = path.join(OWN_DIR, 'bundle');
const OWN_BINARY = path.join(OWN_BUNDLE, 'tor/tor');
const OWN_VERSION_FILE = path.join(OWN_DIR, 'version');
const OWN_OFF_FILE = path.join(OWN_DIR, 'off');
const OWN_CONTROL = path.join(OWN_DIR, 'control');
/** Clear of a system Tor's 9050 and Tor Browser's 9150, so they can run beside it. */
const OWN_SOCKS_PORT = 9250;

/** The Expert Bundle's names for the machines it's built for. */
const BUNDLE_ARCH: Partial<Record<string, string>> = { x64: 'x86_64', arm64: 'aarch64' };
const DIST_URL = 'https://dist.torproject.org/torbrowser';
/** The Tor Browser Developers' signing key, which signs each release's checksums. */
const SIGNING_KEY = 'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290';
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const UPDATE_CHECK_MS = 24 * 60 * 60_000;
/** How long to wait before starting Din's own Tor again after it stopped on its own. */
const RESTART_DELAYS_MS = [2_000, 10_000, 30_000, 60_000];

/** A system Tor's SOCKS port, then Tor Browser's. */
const SOCKS_PORTS = [9050, 9150];
const CONTROL_TARGETS: net.NetConnectOpts[] = [
  { path: OWN_CONTROL },
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
  /** Whether Din can turn Tor on and off here: DinOS, or where Din has a Tor of its own. */
  canToggle: boolean;
  /** Whether Tor is set to run; null where Din doesn't manage it. */
  enabled: boolean | null;
  /** The SOCKS port of the Tor Din found, or null. */
  port: number | null;
  /** How far Tor has got connecting, 0-100; null when it doesn't say. */
  progress: number | null;
  /** Tor's word for what it's doing, e.g. "Loading relay descriptors". */
  summary: string | null;
  /** Whether Din can set up a Tor of its own here (not DinOS, which has one). */
  canInstall: boolean;
  /** The version of Din's own Tor (the bundle's, "16.0"), or null where it has none. */
  installed: string | null;
  /** What setting up or updating Din's own Tor is doing, or null. */
  installing: string | null;
  /** Why setting up or running Din's own Tor last failed, or null. */
  error: string | null;
}

type AssertSender = (event: Electron.IpcMainInvokeEvent) => void;

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let status: TorStatus = {
  canToggle: Boolean(HELPER),
  enabled: null,
  port: null,
  progress: null,
  summary: null,
  canInstall: canInstall(),
  installed: null,
  installing: null,
  error: null,
};
/** What install and Din's own Tor say, which refresh() folds into the status. */
let installing: string | null = null;
let ownError: string | null = null;

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

let queued: Promise<TorStatus> | null = null;

/**
 * Look for Tor again, and tell the shell if anything changed. Asked while
 * looking, it looks once more after, since what it was asked about (Din's
 * own Tor starting, a step of setting it up) may have come too late for
 * this look.
 */
function refresh(): Promise<TorStatus> {
  if (refreshing) {
    queued ??= refreshing.catch(() => {}).then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  }
  refreshing = (async () => {
    try {
      const installed = HELPER ? null : ownVersion();
      const ports = installed && ownEnabled() ? [OWN_SOCKS_PORT, ...SOCKS_PORTS] : SOCKS_PORTS;
      let port: number | null = null;
      for (const candidate of ports) {
        if (await socksAnswers(candidate)) {
          port = candidate;
          break;
        }
      }
      const phase = port === null ? null : await bootstrap();
      const next: TorStatus = {
        canToggle: Boolean(HELPER) || installed !== null,
        enabled: HELPER ? !fs.existsSync(OFF_FILE) : installed ? ownEnabled() : null,
        port,
        progress: phase?.progress ?? null,
        summary: phase?.summary ?? null,
        canInstall: canInstall(),
        installed,
        installing,
        error: ownError,
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
// Din's own Tor
// ---------------------------------------------------------------------------

function canInstall(): boolean {
  return !HELPER && process.platform === 'linux' && BUNDLE_ARCH[process.arch] !== undefined;
}

/** The version of the bundle Din has set up, or null. */
function ownVersion(): string | null {
  try {
    fs.accessSync(OWN_BINARY, fs.constants.X_OK);
    return fs.readFileSync(OWN_VERSION_FILE, 'utf8').trim() || '?';
  } catch {
    return null;
  }
}

function ownEnabled(): boolean {
  return !fs.existsSync(OWN_OFF_FILE);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setInstalling(step: string | null): void {
  installing = step;
  void refresh();
}

let child: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let restarts = 0;

/** Start Din's own Tor, where it's set up and on and not running already. */
function startOwn(): void {
  if (HELPER || child || !ownVersion() || !ownEnabled()) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  // Tor won't open a control socket in, or keep its keys in, a directory
  // anyone else can read.
  fs.mkdirSync(path.join(OWN_DIR, 'data'), { recursive: true, mode: 0o700 });
  fs.chmodSync(OWN_DIR, 0o700);
  fs.chmodSync(path.join(OWN_DIR, 'data'), 0o700);
  fs.rmSync(OWN_CONTROL, { force: true });
  const bundleData = path.join(OWN_BUNDLE, 'data');
  const proc = spawn(
    OWN_BINARY,
    [
      // The bundle's own torrc-defaults is Tor Browser's, and names its
      // pluggable transports where Tor Browser keeps them: none of it here.
      '--defaults-torrc', path.join(OWN_DIR, 'torrc-defaults'),
      '-f', path.join(OWN_DIR, 'torrc'),
      '--ignore-missing-torrc',
      '--DataDirectory', path.join(OWN_DIR, 'data'),
      '--SocksPort', `127.0.0.1:${OWN_SOCKS_PORT}`,
      '--ControlSocket', OWN_CONTROL,
      '--CookieAuthentication', '1',
      '--GeoIPFile', path.join(bundleData, 'geoip'),
      '--GeoIPv6File', path.join(bundleData, 'geoip6'),
      '--AvoidDiskWrites', '1',
      // It goes when Din does, however Din goes.
      '--__OwningControllerProcess', String(process.pid),
      '--Log', 'notice stdout',
    ],
    {
      // The bundle's tor is linked against the libraries beside it.
      env: { ...process.env, LD_LIBRARY_PATH: path.dirname(OWN_BINARY) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child = proc;
  let tail = '';
  const keep = (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-4000);
    // Running long enough to connect: a later exit starts over at the shortest wait.
    if (/Bootstrapped 100%/.test(tail)) {
      restarts = 0;
      if (ownError) {
        ownError = null;
        void refresh();
      }
    }
  };
  proc.stdout?.on('data', keep);
  proc.stderr?.on('data', keep);
  proc.on('error', (error) => {
    if (child === proc) child = null;
    ownError = `Tor didn’t start: ${error.message}`;
    void refresh();
  });
  proc.on('exit', (code, signal) => {
    if (child !== proc) return;
    child = null;
    if (ownVersion() && ownEnabled()) {
      // Tor's last [warn] or [err] says why, as "Could not bind to 127.0.0.1:9250: Address already in use".
      const reason = tail
        .split('\n')
        .filter((line) => /\[(warn|err)\]/.test(line))
        .pop()
        ?.replace(/^.*?\[(warn|err)\]\s*/, '');
      ownError = reason || `Tor stopped (${signal ?? code})`;
      console.warn('[tor] stopped:', ownError);
      const delay = RESTART_DELAYS_MS[Math.min(restarts++, RESTART_DELAYS_MS.length - 1)];
      restartTimer = setTimeout(startOwn, delay);
    }
    void refresh();
  });
  void refresh();
}

/** Stop Din's own Tor, if it's running. */
function stopOwn(): Promise<void> {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const proc = child;
  if (!proc) return Promise.resolve();
  child = null;
  return new Promise((resolve) => {
    const kill = setTimeout(() => proc.kill('SIGKILL'), 5_000);
    proc.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The Tor Project’s server answered ${response.status} for ${path.basename(new URL(url).pathname)}`);
  return response;
}

/** The newest Tor Browser release, whose Expert Bundle is the Tor to get. */
async function latestVersion(): Promise<string> {
  const arch = BUNDLE_ARCH[process.arch];
  const response = await fetchOk(`https://aus1.torproject.org/torbrowser/update_3/release/download-linux-${arch}.json`);
  const { version } = (await response.json()) as { version?: unknown };
  if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) throw new Error('The Tor Project didn’t say which release is newest');
  return version;
}

function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function execGpg(args: string[], home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gpg', ['--batch', '--no-tty', ...args], { env: { ...process.env, GNUPGHOME: home }, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(stderr.trim().split('\n').pop() || error.message), { code: error.code }));
      else resolve(stdout);
    });
  });
}

/**
 * Check the release's checksums are signed by the Tor Browser Developers,
 * with their key from torproject.org's Web Key Directory in a keyring of its
 * own. Where there's no gpg, HTTPS from the Tor Project's server is all
 * there is, as for OpenCode's installer.
 */
async function verifySums(sums: string, signature: string): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'din-tor-gpg-'));
  try {
    try {
      await execGpg(['--version'], home);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return;
      throw error;
    }
    fs.writeFileSync(path.join(home, 'sums.txt'), sums);
    fs.writeFileSync(path.join(home, 'sums.txt.asc'), signature);
    await execGpg(['--auto-key-locate', 'nodefault,wkd', '--locate-keys', 'torbrowser@torproject.org'], home);
    const out = await execGpg(['--status-fd', '1', '--verify', path.join(home, 'sums.txt.asc'), path.join(home, 'sums.txt')], home).catch(() => '');
    // VALIDSIG's last field is the primary key's fingerprint.
    const valid = out.split('\n').find((line) => line.startsWith('[GNUPG:] VALIDSIG '));
    if (valid?.trim().split(' ').pop() !== SIGNING_KEY) throw new Error('The Tor release isn’t signed by the Tor Browser Developers');
  } finally {
    execFile('gpgconf', ['--kill', 'all'], { env: { ...process.env, GNUPGHOME: home } }, () => {
      fs.rmSync(home, { recursive: true, force: true });
    });
  }
}

let installation: Promise<void> | null = null;

/**
 * Download the newest Expert Bundle, check it, and put it in place of the
 * one there is, restarting Din's own Tor on it if it was running.
 */
function installBundle(version?: string): Promise<void> {
  installation ??= (async () => {
    const arch = BUNDLE_ARCH[process.arch];
    if (!canInstall() || !arch) throw new Error('Din can’t set up Tor on this computer');
    const work = path.join(OWN_DIR, 'bundle.new');
    try {
      setInstalling('Finding the newest Tor');
      const release = version ?? (await latestVersion());
      const name = `tor-expert-bundle-linux-${arch}-${release}.tar.gz`;
      const base = `${DIST_URL}/${release}`;

      setInstalling('Checking the release’s signature');
      const [sums, signature] = await Promise.all([
        fetchOk(`${base}/sha256sums-signed-build.txt`).then((r) => r.text()),
        fetchOk(`${base}/sha256sums-signed-build.txt.asc`).then((r) => r.text()),
      ]);
      await verifySums(sums, signature);
      const expected = sums
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([, file]) => file === name)?.[0];
      if (!expected) throw new Error(`Tor ${release} has no bundle for this computer`);

      setInstalling(`Downloading Tor ${release}`);
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true, mode: 0o700 });
      const archive = path.join(work, name);
      const response = await fetchOk(`${base}/${name}`);
      if (!response.body) throw new Error('The download was empty');
      const hash = createHash('sha256');
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        fs.createWriteStream(archive),
      );
      if (hash.digest('hex') !== expected) throw new Error('The Tor download didn’t match its checksum');

      setInstalling(`Installing Tor ${release}`);
      await runCommand('tar', ['-xzf', archive, '-C', work, 'tor', 'data'], { timeout: 120_000 });
      fs.rmSync(archive);

      await stopOwn();
      const old = path.join(OWN_DIR, 'bundle.old');
      fs.rmSync(old, { recursive: true, force: true });
      if (fs.existsSync(OWN_BUNDLE)) fs.renameSync(OWN_BUNDLE, old);
      fs.renameSync(work, OWN_BUNDLE);
      fs.rmSync(old, { recursive: true, force: true });
      fs.writeFileSync(OWN_VERSION_FILE, `${release}\n`);
      startOwn();
    } catch (error) {
      fs.rmSync(work, { recursive: true, force: true });
      throw error;
    } finally {
      installation = null;
      setInstalling(null);
    }
  })();
  return installation;
}

/** Set up Din's own Tor, and turn it on. */
async function install(): Promise<void> {
  fs.mkdirSync(OWN_DIR, { recursive: true, mode: 0o700 });
  fs.rmSync(OWN_OFF_FILE, { force: true });
  ownError = null;
  restarts = 0;
  try {
    if (!ownVersion()) await installBundle();
    else startOwn();
  } catch (error) {
    ownError = messageOf(error);
    void refresh();
    throw error;
  }
}

let lastUpdateCheck = 0;

/** Move Din's own Tor to a newer release, if there is one, at most daily. */
async function checkForUpdate(): Promise<void> {
  const current = ownVersion();
  if (!current || installation || Date.now() - lastUpdateCheck < UPDATE_CHECK_MS) return;
  lastUpdateCheck = Date.now();
  try {
    const latest = await latestVersion();
    if (current === '?' || isNewer(latest, current)) await installBundle(latest);
  } catch (error) {
    console.warn('[tor] update failed:', messageOf(error));
  }
}

async function setOwnEnabled(enabled: boolean): Promise<void> {
  if (!ownVersion()) throw new Error('Set up Tor first');
  if (enabled) {
    fs.rmSync(OWN_OFF_FILE, { force: true });
    restarts = 0;
    startOwn();
  } else {
    fs.writeFileSync(OWN_OFF_FILE, '');
    ownError = null;
    await stopOwn();
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
  s.webRequest.onBeforeSendHeaders({ urls: ['https://*.onion/*', 'wss://*.onion/*'] }, (details, callback) => {
    let host: string;
    try {
      const url = new URL(details.url);
      if (!isPlainOnionHost(url.hostname)) {
        callback({});
        return;
      }
      host = url.host;
    } catch {
      callback({});
      return;
    }
    const secure = `https://${host}`;
    const headers = details.requestHeaders;
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
  if (canInstall()) {
    startOwn();
    void checkForUpdate();
    setInterval(() => void checkForUpdate(), UPDATE_CHECK_MS).unref();
  }
  app.on('will-quit', () => {
    if (restartTimer) clearTimeout(restartTimer);
    child?.kill('SIGTERM');
  });

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
    if (HELPER) await helper([enabled ? 'on' : 'off']);
    else await setOwnEnabled(enabled);
    return refresh();
  });

  ipcMain.handle('tor:install', async (event) => {
    assertShellSender(event);
    await install();
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
