// The Torrents bridge (window.dinos.torrents for `din torrents`, and
// din.system.torrents for the Torrents app): BitTorrent transfers, from
// .torrent files and magnet: links. Types are src/lib/torrents.ts.
//
// The engine is Transmission's daemon, run by Din as the user: DinOS names
// it (DIN_TRANSMISSION, os/configuration.nix); elsewhere it's the system's
// transmission-daemon, version 4 or later, which Optional Features installs
// (system-packages.mts). Its settings, resume files and torrents are in
// ~/.local/share/din/torrents, and it answers RPC on a Unix socket in the
// user's runtime directory, readable by the user alone, rather than a port
// any page could reach. Every call here is one of a handful of operations,
// checked, never RPC passed through: nothing an app sends can set the
// daemon's scripts, its socket or what it watches.
//
// It starts the first time it's wanted, or with Din when there are
// transfers to go on with, and stops when Din does (setpriv's pdeathsig
// takes it down even if Din crashes). A daemon already answering on the
// socket, left from a Din that went without stopping it, is used as it is.
// While it runs it's polled, every second while anything's moving and
// every five while nothing is, and the list is pushed as `torrents:changed`
// when it changes; a transfer that finishes downloading says so in a
// notification.
//
// Removing a transfer with its data moves the data to the Trash, never
// deletes it outright as Transmission's own delete-local-data would.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { trash } from './files.mts';
import type { SystemNotification } from './notifications.mts';
import { runCommand, which } from './system.mts';

const SYSTEM_BINARY = process.env.DIN_TRANSMISSION;
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const CONFIG_DIR = path.join(DATA_HOME, 'din', 'torrents');
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : CONFIG_DIR;
const SOCKET = path.join(RUNTIME_DIR, 'din-torrents.sock');
/** The port peers reach this computer on; DinOS's firewall lets it in (os/configuration.nix). */
const PEER_PORT = 51413;
const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;
const MAX_TORRENT_FILE = 32 * 1024 * 1024;
const MAX_MAGNET = 8192;

/** The status Transmission gives a transfer, by number. */
const STATES = [
  { state: 'stopped', waiting: false },
  { state: 'checking', waiting: true },
  { state: 'checking', waiting: false },
  { state: 'downloading', waiting: true },
  { state: 'downloading', waiting: false },
  { state: 'seeding', waiting: true },
  { state: 'seeding', waiting: false },
] as const;

const LIST_FIELDS = [
  'id', 'hashString', 'name', 'status', 'error', 'errorString', 'percentDone', 'metadataPercentComplete', 'recheckProgress',
  'sizeWhenDone', 'totalSize', 'leftUntilDone', 'downloadedEver', 'uploadedEver', 'uploadRatio', 'rateDownload', 'rateUpload', 'eta',
  'peersConnected', 'peersSendingToUs', 'peersGettingFromUs', 'webseedsSendingToUs', 'addedDate', 'doneDate', 'downloadDir',
  'isFinished', 'isPrivate', 'queuePosition', 'file-count', 'primary-mime-type',
];

const DETAIL_FIELDS = [
  ...LIST_FIELDS,
  'magnetLink', 'comment', 'creator', 'dateCreated', 'pieceCount', 'pieceSize', 'pieces', 'corruptEver', 'secondsDownloading',
  'secondsSeeding', 'files', 'fileStats', 'peers', 'trackerStats',
];

// ---------------------------------------------------------------------------
// Types (as src/lib/torrents.ts has them; electron/ can't import from src/)
// ---------------------------------------------------------------------------

type TorrentState = 'stopped' | 'checking' | 'downloading' | 'seeding';
type Priority = 'low' | 'normal' | 'high';
type Encryption = 'preferred' | 'required' | 'allowed';

interface Torrent {
  id: number;
  hash: string;
  name: string;
  state: TorrentState;
  waiting: boolean;
  finished: boolean;
  progress: number;
  metadataProgress: number | null;
  checkProgress: number | null;
  sizeBytes: number;
  totalBytes: number;
  haveBytes: number;
  downloadedBytes: number;
  uploadedBytes: number;
  ratio: number | null;
  rateDown: number;
  rateUp: number;
  eta: number | null;
  peersConnected: number;
  peersSending: number;
  peersReceiving: number;
  fileCount: number;
  mimeType: string | null;
  addedAt: number;
  doneAt: number | null;
  downloadDir: string;
  error: string | null;
  errorKind: 'tracker-warning' | 'tracker-error' | 'local' | null;
  private: boolean;
  queuePosition: number;
}

interface Settings {
  downloadDir: string;
  startWhenAdded: boolean;
  downloadQueue: { enabled: boolean; size: number };
  downloadLimit: { enabled: boolean; kBps: number };
  uploadLimit: { enabled: boolean; kBps: number };
  altSpeed: { enabled: boolean; downKBps: number; upKBps: number };
  seedRatio: { enabled: boolean; ratio: number };
  encryption: Encryption;
  portForwarding: boolean;
  peerPort: number;
}

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The daemon
// ---------------------------------------------------------------------------

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let quitting = false;
let stderrTail = '';
let sessionId = '';
let binaryInfo: { path: string | null; version: string | null; reason: string | null } | null = null;

/** The daemon to run, its version, and why it can't run if it can't. */
async function binary(): Promise<{ path: string | null; version: string | null; reason: string | null }> {
  if (binaryInfo?.path) return binaryInfo;
  const found = SYSTEM_BINARY && fs.existsSync(SYSTEM_BINARY) ? SYSTEM_BINARY : which('transmission-daemon');
  if (!found) {
    binaryInfo = { path: null, version: null, reason: 'Transmission isn’t installed.' };
    return binaryInfo;
  }
  let version: string | null;
  try {
    const { stdout, stderr } = await runCommand(found, ['--version'], { timeout: 10_000 });
    version = /(\d+\.\d+(?:\.\d+)?)/.exec(`${stdout} ${stderr}`)?.[1] ?? null;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    version = /(\d+\.\d+(?:\.\d+)?)/.exec(`${err.stdout ?? ''} ${err.stderr ?? ''}`)?.[1] ?? null;
  }
  const major = version ? Number(version.split('.')[0]) : 0;
  binaryInfo =
    major >= 4
      ? { path: found, version, reason: null }
      : { path: null, version, reason: `Torrents needs Transmission 4 or later, and this computer has ${version ? `Transmission ${version}` : 'an older one'}.` };
  return binaryInfo;
}

function readJson(file: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/**
 * Write the daemon's settings before it starts: the user's, from last time
 * (the daemon writes them back as it stops), with Din's own over them.
 */
function writeSettings(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(CONFIG_DIR, 0o700);
  const file = path.join(CONFIG_DIR, 'settings.json');
  const existing = readJson(file);
  const settings: Json = existing ?? {
    // A new install's choices, which the user can change.
    'download-dir': app.getPath('downloads'),
    'rename-partial-files': true,
    'start-added-torrents': true,
    'port-forwarding-enabled': true,
    encryption: 1,
    'download-queue-enabled': true,
    'download-queue-size': 5,
    'seed-queue-enabled': false,
    'ratio-limit-enabled': false,
    'ratio-limit': 2,
    'speed-limit-down': 1000,
    'speed-limit-up': 100,
    'alt-speed-down': 500,
    'alt-speed-up': 50,
    'incomplete-dir-enabled': false,
    'dht-enabled': true,
    'pex-enabled': true,
    'lpd-enabled': true,
    'utp-enabled': true,
  };
  Object.assign(settings, {
    // Only the user reaches it: a socket in their runtime directory.
    'rpc-enabled': true,
    'rpc-bind-address': `unix:${SOCKET}`,
    'rpc-socket-mode': '0600',
    'rpc-authentication-required': false,
    'rpc-whitelist-enabled': false,
    'rpc-host-whitelist-enabled': false,
    // Nothing runs or is picked up behind the user's back.
    'script-torrent-added-enabled': false,
    'script-torrent-done-enabled': false,
    'script-torrent-done-seeding-enabled': false,
    'watch-dir-enabled': false,
    'trash-original-torrent-files': false,
    'peer-port': PEER_PORT,
    'peer-port-random-on-start': false,
    'message-level': 2,
  });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** Make sure the daemon's answering, starting it if it isn't. */
function ensureDaemon(): Promise<void> {
  if (child && sessionId) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    // One already answering (Din went without stopping it): use it.
    try {
      await rawRpc('session-get', { fields: ['version'] });
      startPolling();
      return;
    } catch {
      // Not running.
    }
    if (quitting) throw new Error('Din is quitting.');
    const bin = await binary();
    if (!bin.path) throw new Error(bin.reason ?? 'Transmission isn’t installed.');
    writeSettings();
    fs.rmSync(SOCKET, { force: true });
    const args = ['--foreground', '--config-dir', CONFIG_DIR, '--log-level=error'];
    // It goes when Din does, however Din goes.
    const setpriv = which('setpriv');
    const proc = setpriv
      ? spawn(setpriv, ['--pdeathsig', 'SIGTERM', '--', bin.path, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
      : spawn(bin.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child = proc;
    stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    proc.on('error', () => {
      if (child === proc) child = null;
    });
    proc.on('exit', () => {
      if (child !== proc) return;
      child = null;
      sessionId = '';
      if (!quitting) console.warn('[torrents] Transmission stopped:', lastError() ?? 'no reason given');
      void poll();
    });
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (child !== proc) throw new Error(`Transmission didn’t start${lastError() ? `: ${lastError()}` : ''}.`);
      try {
        await rawRpc('session-get', { fields: ['version'] });
        startPolling();
        return;
      } catch {
        // Not answering yet.
      }
    }
    proc.kill('SIGTERM');
    throw new Error('Transmission didn’t answer.');
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** The last thing the daemon complained of. */
function lastError(): string | null {
  const line = stderrTail.trim().split('\n').filter(Boolean).pop();
  return line ? line.replace(/^\[[^\]]*\]\s*/, '').trim() : null;
}

/** One RPC call over the socket, renewing the CSRF session id once if asked. */
function rawRpc(method: string, args: Json = {}, retried = false): Promise<Json> {
  const body = JSON.stringify({ method, arguments: args });
  return new Promise<Json>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: '/transmission/rpc',
        method: 'POST',
        headers: {
          Host: 'localhost',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Transmission-Session-Id': sessionId,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 409 && !retried) {
            sessionId = String(res.headers['x-transmission-session-id'] ?? '');
            rawRpc(method, args, true).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Transmission answered ${res.statusCode}`));
            return;
          }
          try {
            const reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result?: string; arguments?: Json };
            if (reply.result !== 'success') reject(new Error(cleanResult(reply.result)));
            else resolve(reply.arguments ?? {});
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Transmission didn’t answer in time.')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Transmission's result string, as a sentence. */
function cleanResult(result: string | undefined): string {
  if (!result) return 'Transmission couldn’t do that.';
  const text = result.trim();
  return /[.!?]$/.test(text) ? text[0].toUpperCase() + text.slice(1) : `${text[0].toUpperCase()}${text.slice(1)}.`;
}

/** An RPC call, starting the daemon first if it isn't running. */
async function rpc(method: string, args: Json = {}): Promise<Json> {
  await ensureDaemon();
  try {
    return await rawRpc(method, args);
  } catch (error) {
    // The daemon went away: once more, from the start.
    if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (error as NodeJS.ErrnoException).code === 'ENOENT') {
      sessionId = '';
      await ensureDaemon();
      return rawRpc(method, args);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toTorrent(t: Json): Torrent {
  const status = STATES[num(t.status)] ?? STATES[0];
  const errorCode = num(t.error);
  const sizeBytes = num(t.sizeWhenDone);
  const eta = num(t.eta, -1);
  const ratio = num(t.uploadRatio, -1);
  const metadata = num(t.metadataPercentComplete, 1);
  return {
    id: num(t.id),
    hash: str(t.hashString),
    name: str(t.name) || str(t.hashString),
    state: status.state,
    waiting: status.waiting,
    finished: metadata >= 1 && num(t.leftUntilDone) === 0 && sizeBytes > 0,
    progress: num(t.percentDone),
    metadataProgress: metadata >= 1 ? null : metadata,
    checkProgress: status.state === 'checking' && !status.waiting ? num(t.recheckProgress) : null,
    sizeBytes,
    totalBytes: num(t.totalSize),
    haveBytes: Math.max(0, sizeBytes - num(t.leftUntilDone)),
    downloadedBytes: num(t.downloadedEver),
    uploadedBytes: num(t.uploadedEver),
    ratio: ratio < 0 ? null : ratio,
    rateDown: num(t.rateDownload),
    rateUp: num(t.rateUpload),
    eta: eta < 0 ? null : eta,
    peersConnected: num(t.peersConnected),
    peersSending: num(t.peersSendingToUs) + num(t.webseedsSendingToUs),
    peersReceiving: num(t.peersGettingFromUs),
    fileCount: num(t['file-count']),
    mimeType: str(t['primary-mime-type']) || null,
    addedAt: num(t.addedDate),
    doneAt: num(t.doneDate) || null,
    downloadDir: str(t.downloadDir),
    error: errorCode ? str(t.errorString) || 'Something went wrong.' : null,
    errorKind: errorCode === 1 ? 'tracker-warning' : errorCode === 2 ? 'tracker-error' : errorCode === 3 ? 'local' : null,
    private: t.isPrivate === true,
    queuePosition: num(t.queuePosition),
  };
}

const ENCRYPTIONS: Record<string, Encryption> = { preferred: 'preferred', required: 'required', tolerated: 'allowed' };

function toSettings(s: Json): Settings {
  return {
    downloadDir: str(s['download-dir']),
    startWhenAdded: s['start-added-torrents'] !== false,
    downloadQueue: { enabled: s['download-queue-enabled'] === true, size: num(s['download-queue-size'], 5) },
    downloadLimit: { enabled: s['speed-limit-down-enabled'] === true, kBps: num(s['speed-limit-down'], 1000) },
    uploadLimit: { enabled: s['speed-limit-up-enabled'] === true, kBps: num(s['speed-limit-up'], 100) },
    altSpeed: { enabled: s['alt-speed-enabled'] === true, downKBps: num(s['alt-speed-down'], 500), upKBps: num(s['alt-speed-up'], 50) },
    seedRatio: { enabled: s.seedRatioLimited === true, ratio: num(s.seedRatioLimit, 2) },
    encryption: ENCRYPTIONS[str(s.encryption)] ?? 'preferred',
    portForwarding: s['port-forwarding-enabled'] !== false,
    peerPort: num(s['peer-port'], PEER_PORT),
  };
}

const SETTINGS_FIELDS = [
  'version', 'download-dir', 'start-added-torrents', 'download-queue-enabled', 'download-queue-size', 'speed-limit-down-enabled',
  'speed-limit-down', 'speed-limit-up-enabled', 'speed-limit-up', 'alt-speed-enabled', 'alt-speed-down', 'alt-speed-up',
  'seedRatioLimited', 'seedRatioLimit', 'encryption', 'port-forwarding-enabled', 'peer-port',
];

const PRIORITIES: Record<number, Priority> = { [-1]: 'low', 0: 'normal', 1: 'high' };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Checking what's asked
// ---------------------------------------------------------------------------

function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) throw new Error('No transfers given');
  return value.map((v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error('Not a transfer');
    return v;
  });
}

function fileIndexes(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000_000) throw new Error('Not a list of files');
  return value.map((v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error('Not a file');
    return v;
  });
}

async function folder(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('Not a folder');
  const dir = path.resolve(value);
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`There’s no folder at ${dir}.`);
  return dir;
}

function magnet(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_MAGNET) throw new Error('Not a magnet link');
  const link = value.trim();
  if (!/^magnet:\?/i.test(link) || !/[?&]xt=urn:bt(ih|mh):/i.test(link)) throw new Error('That isn’t a magnet link for a torrent.');
  return link;
}

type Source = { magnet: string } | { path: string };

function source(value: unknown): Source {
  if (!value || typeof value !== 'object') throw new Error('Nothing to add');
  const v = value as Json;
  if (typeof v.magnet === 'string') return { magnet: magnet(v.magnet) };
  if (typeof v.path === 'string' && path.isAbsolute(v.path) && !v.path.includes('\0')) return { path: v.path };
  throw new Error('Nothing to add');
}

async function readTorrentFile(file: string): Promise<Buffer> {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error(`There’s no file at ${file}.`);
  if (stat.size > MAX_TORRENT_FILE) throw new Error('That’s too big to be a torrent file.');
  return fsp.readFile(file);
}

// ---------------------------------------------------------------------------
// Reading torrent files (bencode) and magnet links, for the Add window
// ---------------------------------------------------------------------------

type Bencoded = number | Buffer | Bencoded[] | Map<string, Bencoded>;

/** Decode bencode, noting where the top-level `info` dictionary's bytes are. */
function bdecode(buf: Buffer): { value: Bencoded; info: [number, number] | null } {
  let pos = 0;
  let info: [number, number] | null = null;
  const fail = () => {
    throw new Error('That isn’t a torrent file.');
  };
  const read = (depth: number): Bencoded => {
    if (depth > 64 || pos >= buf.length) fail();
    const c = buf[pos];
    if (c === 0x69) {
      // i<digits>e
      const end = buf.indexOf(0x65, pos);
      if (end < 0) fail();
      const n = Number(buf.toString('latin1', pos + 1, end));
      if (!Number.isFinite(n)) fail();
      pos = end + 1;
      return n;
    }
    if (c === 0x6c) {
      pos++;
      const list: Bencoded[] = [];
      while (buf[pos] !== 0x65) list.push(read(depth + 1));
      pos++;
      return list;
    }
    if (c === 0x64) {
      pos++;
      const dict = new Map<string, Bencoded>();
      while (buf[pos] !== 0x65) {
        const key = read(depth + 1);
        if (!Buffer.isBuffer(key)) fail();
        const name = (key as Buffer).toString('utf8');
        const start = pos;
        dict.set(name, read(depth + 1));
        if (depth === 0 && name === 'info') info = [start, pos];
      }
      pos++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a, pos);
      if (colon < 0) fail();
      const len = Number(buf.toString('latin1', pos, colon));
      if (!Number.isInteger(len) || len < 0 || colon + 1 + len > buf.length) fail();
      const out = buf.subarray(colon + 1, colon + 1 + len);
      pos = colon + 1 + len;
      return out;
    }
    return fail();
  };
  const value = read(0);
  return { value, info };
}

const dictOf = (v: Bencoded | undefined): Map<string, Bencoded> | null => (v instanceof Map ? v : null);
const textOf = (v: Bencoded | undefined): string => (Buffer.isBuffer(v) ? v.toString('utf8') : '');

interface Preview {
  name: string;
  hash: string | null;
  sizeBytes: number | null;
  files: { path: string; bytes: number }[] | null;
  trackers: string[];
  private: boolean;
  comment: string;
  existing: number | null;
}

function previewFile(buf: Buffer): Preview {
  const { value, info: infoRange } = bdecode(buf);
  const root = dictOf(value);
  const info = dictOf(root?.get('info'));
  if (!root || !info) throw new Error('That isn’t a torrent file.');
  const name = textOf(info.get('name.utf-8')) || textOf(info.get('name')) || 'Untitled';
  let files: { path: string; bytes: number }[] | null = null;
  const list = info.get('files');
  if (Array.isArray(list)) {
    files = list.map((entry) => {
      const d = dictOf(entry);
      const parts = d?.get('path.utf-8') ?? d?.get('path');
      const segments = Array.isArray(parts) ? parts.map((p) => textOf(p)) : [];
      return { path: [name, ...segments].join('/'), bytes: typeof d?.get('length') === 'number' ? (d.get('length') as number) : 0 };
    });
  } else if (typeof info.get('length') === 'number') {
    files = [{ path: name, bytes: info.get('length') as number }];
  }
  const trackers = new Set<string>();
  const announce = textOf(root.get('announce'));
  if (announce) trackers.add(announce);
  const tiers = root.get('announce-list');
  if (Array.isArray(tiers)) for (const tier of tiers) if (Array.isArray(tier)) for (const t of tier) if (textOf(t)) trackers.add(textOf(t));
  const hash = infoRange && info.has('pieces') ? createHash('sha1').update(buf.subarray(infoRange[0], infoRange[1])).digest('hex') : null;
  return {
    name,
    hash,
    sizeBytes: files ? files.reduce((sum, f) => sum + f.bytes, 0) : null,
    files,
    trackers: [...trackers].slice(0, 100),
    private: info.get('private') === 1,
    comment: textOf(root.get('comment.utf-8')) || textOf(root.get('comment')),
    existing: null,
  };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(s: string): string | null {
  let bits = '';
  for (const ch of s.toUpperCase()) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

function previewMagnet(link: string): Preview {
  const params = new URLSearchParams(link.slice(link.indexOf('?') + 1));
  let hash: string | null = null;
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i.exec(xt);
    if (m) hash = m[1].length === 40 ? m[1].toLowerCase() : base32ToHex(m[1]);
  }
  const size = Number(params.get('xl'));
  return {
    name: params.get('dn')?.trim() || (hash ? `Magnet ${hash.slice(0, 8)}` : 'Magnet link'),
    hash,
    sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
    files: null,
    trackers: params.getAll('tr').slice(0, 100),
    private: false,
    comment: '',
    existing: null,
  };
}

// ---------------------------------------------------------------------------
// Polling and pushing
// ---------------------------------------------------------------------------

let pollTimer: NodeJS.Timeout | null = null;
let polling = false;
let lastPushed = '';
let lastTorrents: Torrent[] = [];
let lastSettings: Settings | null = null;
/** Hashes of transfers known to be finished, to notify only of new ones; null until the first poll. */
let finishedHashes: Set<string> | null = null;

function startPolling(): void {
  if (pollTimer || quitting) return;
  void poll();
}

function schedule(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (quitting || (!child && !sessionId)) return;
  const busy = lastTorrents.some((t) => t.state !== 'stopped' && (t.rateDown || t.rateUp || t.state === 'checking' || !t.finished));
  pollTimer = setTimeout(() => void poll(), busy ? ACTIVE_POLL_MS : IDLE_POLL_MS);
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const [list, session, stats] = await Promise.all([
      rawRpc('torrent-get', { fields: LIST_FIELDS }),
      rawRpc('session-get', { fields: SETTINGS_FIELDS }),
      rawRpc('session-stats'),
    ]);
    const torrents = (Array.isArray(list.torrents) ? (list.torrents as Json[]) : []).map(toTorrent);
    lastTorrents = torrents;
    lastSettings = toSettings(session);
    notifyFinished(torrents);
    const change = { torrents, rateDown: num(stats.downloadSpeed), rateUp: num(stats.uploadSpeed), settings: lastSettings };
    const json = JSON.stringify(change);
    if (json !== lastPushed) {
      lastPushed = json;
      sendToShell('torrents:changed', change);
    }
  } catch {
    // Not running any more: polling stops until it's wanted again.
    if (!child) sessionId = '';
    lastTorrents = [];
  } finally {
    polling = false;
    schedule();
  }
}

/** Say when a transfer finishes downloading. */
function notifyFinished(torrents: Torrent[]): void {
  const done = new Set(torrents.filter((t) => t.finished).map((t) => t.hash));
  if (finishedHashes) {
    for (const t of torrents) {
      if (t.finished && !finishedHashes.has(t.hash) && t.downloadedBytes > 0) {
        const notification: SystemNotification = {
          id: `din:torrents:${t.hash}`,
          appName: 'Torrents',
          appId: 'torrents',
          icon: null,
          image: null,
          title: 'Download finished',
          body: t.name,
          actions: [],
          urgency: 'normal',
          timeout: -1,
          resident: false,
          transient: false,
          guest: null,
          tag: '',
          site: null,
          worker: null,
          // A click opens Torrents (or brings it forward) with the transfer chosen.
          launch: { show: t.hash },
        };
        sendToShell('notifications:show', notification);
      }
    }
  }
  finishedHashes = done;
}

/** After an action: poll now rather than at the next tick. */
function refreshSoon(): void {
  setTimeout(() => void poll(), 150);
}

// ---------------------------------------------------------------------------
// What the bridge does
// ---------------------------------------------------------------------------

async function status(): Promise<Json> {
  const bin = await binary();
  const optionalFeature = !SYSTEM_BINARY && !bin.path;
  if (!bin.path) return { available: false, reason: bin.reason, optionalFeature, version: bin.version, settings: null, rateDown: 0, rateUp: 0 };
  try {
    const [session, stats] = await Promise.all([rpc('session-get', { fields: SETTINGS_FIELDS }), rpc('session-stats')]);
    lastSettings = toSettings(session);
    return { available: true, reason: null, optionalFeature: false, version: bin.version, settings: lastSettings, rateDown: num(stats.downloadSpeed), rateUp: num(stats.uploadSpeed) };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error), optionalFeature: false, version: bin.version, settings: null, rateDown: 0, rateUp: 0 };
  }
}

async function list(): Promise<Torrent[]> {
  const reply = await rpc('torrent-get', { fields: LIST_FIELDS });
  lastTorrents = (Array.isArray(reply.torrents) ? (reply.torrents as Json[]) : []).map(toTorrent);
  return lastTorrents;
}

async function detail(id: number): Promise<Json> {
  const reply = await rpc('torrent-get', { ids: [id], fields: DETAIL_FIELDS });
  const t = (Array.isArray(reply.torrents) ? (reply.torrents as Json[]) : [])[0];
  if (!t) throw new Error('That transfer isn’t here any more.');
  const files = Array.isArray(t.files) ? (t.files as Json[]) : [];
  const stats = Array.isArray(t.fileStats) ? (t.fileStats as Json[]) : [];
  return {
    torrent: toTorrent(t),
    magnet: str(t.magnetLink),
    comment: str(t.comment),
    creator: str(t.creator),
    createdAt: num(t.dateCreated) || null,
    pieceCount: num(t.pieceCount),
    pieceBytes: num(t.pieceSize),
    pieces: str(t.pieces),
    corruptBytes: num(t.corruptEver),
    secondsDownloading: num(t.secondsDownloading),
    secondsSeeding: num(t.secondsSeeding),
    files: files.map((f, index) => ({
      index,
      path: str(f.name),
      bytes: num(f.length),
      doneBytes: num(f.bytesCompleted),
      wanted: stats[index]?.wanted !== false,
      priority: PRIORITIES[num(stats[index]?.priority)] ?? 'normal',
    })),
    peers: (Array.isArray(t.peers) ? (t.peers as Json[]) : []).map((p) => ({
      address: str(p.address),
      port: num(p.port),
      client: str(p.clientName),
      progress: num(p.progress),
      rateDown: num(p.rateToClient),
      rateUp: num(p.rateToPeer),
      encrypted: p.isEncrypted === true,
      incoming: p.isIncoming === true,
      utp: p.isUTP === true,
    })),
    trackers: (Array.isArray(t.trackerStats) ? (t.trackerStats as Json[]) : []).map((tr) => {
      const count = (v: unknown) => (num(v, -1) < 0 ? null : num(v));
      return {
        id: num(tr.id),
        announce: str(tr.announce),
        host: str(tr.sitename) || hostOf(str(tr.announce)),
        tier: num(tr.tier),
        seeders: count(tr.seederCount),
        leechers: count(tr.leecherCount),
        downloads: count(tr.downloadCount),
        lastAnnounce:
          tr.hasAnnounced === true
            ? { at: num(tr.lastAnnounceTime), ok: tr.lastAnnounceSucceeded === true, result: str(tr.lastAnnounceResult), peers: num(tr.lastAnnouncePeerCount) }
            : null,
        nextAnnounceAt: num(tr.nextAnnounceTime) > 0 ? num(tr.nextAnnounceTime) : null,
        announcing: num(tr.announceState) === 3,
      };
    }),
  };
}

async function inspect(src: Source): Promise<Preview> {
  const preview = 'magnet' in src ? previewMagnet(src.magnet) : previewFile(await readTorrentFile(src.path));
  if (preview.hash) {
    try {
      const reply = await rpc('torrent-get', { ids: [preview.hash], fields: ['id'] });
      const found = (Array.isArray(reply.torrents) ? (reply.torrents as Json[]) : [])[0];
      if (found) preview.existing = num(found.id);
    } catch {
      // Not running yet: nothing's been added.
    }
  }
  return preview;
}

async function add(src: Source, options: unknown): Promise<{ id: number; name: string; duplicate: boolean }> {
  const opts = (options && typeof options === 'object' ? options : {}) as Json;
  const args: Json = {};
  if ('magnet' in src) args.filename = src.magnet;
  else {
    const buf = await readTorrentFile(src.path);
    previewFile(buf); // that it is one, said plainly if not
    args.metainfo = buf.toString('base64');
  }
  if (opts.downloadDir !== undefined) args['download-dir'] = await folder(opts.downloadDir);
  if (opts.paused !== undefined) args.paused = opts.paused === true;
  const unwanted = fileIndexes(opts.unwanted);
  if (unwanted.length) args['files-unwanted'] = unwanted;
  const reply = await rpc('torrent-add', args);
  const added = (reply['torrent-added'] ?? reply['torrent-duplicate']) as Json | undefined;
  if (!added) throw new Error('Transmission didn’t add it.');
  refreshSoon();
  return { id: num(added.id), name: str(added.name), duplicate: !reply['torrent-added'] };
}

/** Take transfers off, moving what they downloaded to the Trash with `trash`. */
async function remove(list: number[], trashData: boolean): Promise<void> {
  let paths: string[] = [];
  if (trashData) {
    const reply = await rpc('torrent-get', { ids: list, fields: ['downloadDir', 'files', 'name'] });
    for (const t of Array.isArray(reply.torrents) ? (reply.torrents as Json[]) : []) {
      const dir = path.resolve(str(t.downloadDir));
      const tops = new Set<string>();
      for (const f of Array.isArray(t.files) ? (t.files as Json[]) : []) {
        const first = str(f.name).split('/')[0];
        if (first) tops.add(first);
      }
      for (const top of tops) {
        for (const name of [top, `${top}.part`]) {
          const full = path.resolve(dir, name);
          // Only what's in its folder, never the folder itself or above it.
          if (path.dirname(full) === dir && name !== '.' && name !== '..') paths.push(full);
        }
      }
    }
    paths = [...new Set(paths)];
  }
  // Stopped first, so nothing's writing to what's trashed.
  await rpc('torrent-remove', { ids: list, 'delete-local-data': false });
  const failed: string[] = [];
  for (const p of paths) {
    if (!(await fsp.lstat(p).catch(() => null))) continue;
    try {
      await trash(p);
    } catch {
      failed.push(path.basename(p));
    }
  }
  refreshSoon();
  if (failed.length) throw new Error(`Couldn’t move ${failed.join(', ')} to the Trash.`);
}

async function setFiles(id: number, change: unknown): Promise<void> {
  const c = (change && typeof change === 'object' ? change : {}) as Json;
  const args: Json = { ids: [id] };
  const wanted = fileIndexes(c.wanted);
  const unwanted = fileIndexes(c.unwanted);
  if (wanted.length) args['files-wanted'] = wanted;
  if (unwanted.length) args['files-unwanted'] = unwanted;
  if (c.priority !== undefined) {
    const files = fileIndexes(c.files);
    if (c.priority !== 'low' && c.priority !== 'normal' && c.priority !== 'high') throw new Error('Not a priority');
    if (files.length) args[`priority-${c.priority}`] = files;
  }
  await rpc('torrent-set', args);
  refreshSoon();
}

function clampNumber(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Not a number');
  return Math.min(max, Math.max(min, v));
}

async function setSettings(patch: unknown): Promise<Settings> {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Json;
  const args: Json = {};
  const pair = (v: unknown) => (v && typeof v === 'object' ? (v as Json) : null);
  if (p.downloadDir !== undefined) args['download-dir'] = await folder(p.downloadDir);
  if (p.startWhenAdded !== undefined) args['start-added-torrents'] = p.startWhenAdded === true;
  const queue = pair(p.downloadQueue);
  if (queue) {
    if (queue.enabled !== undefined) args['download-queue-enabled'] = queue.enabled === true;
    if (queue.size !== undefined) args['download-queue-size'] = Math.round(clampNumber(queue.size, 1, 100));
  }
  const down = pair(p.downloadLimit);
  if (down) {
    if (down.enabled !== undefined) args['speed-limit-down-enabled'] = down.enabled === true;
    if (down.kBps !== undefined) args['speed-limit-down'] = Math.round(clampNumber(down.kBps, 1, 10_000_000));
  }
  const up = pair(p.uploadLimit);
  if (up) {
    if (up.enabled !== undefined) args['speed-limit-up-enabled'] = up.enabled === true;
    if (up.kBps !== undefined) args['speed-limit-up'] = Math.round(clampNumber(up.kBps, 1, 10_000_000));
  }
  const alt = pair(p.altSpeed);
  if (alt) {
    if (alt.enabled !== undefined) args['alt-speed-enabled'] = alt.enabled === true;
    if (alt.downKBps !== undefined) args['alt-speed-down'] = Math.round(clampNumber(alt.downKBps, 1, 10_000_000));
    if (alt.upKBps !== undefined) args['alt-speed-up'] = Math.round(clampNumber(alt.upKBps, 1, 10_000_000));
  }
  const ratio = pair(p.seedRatio);
  if (ratio) {
    if (ratio.enabled !== undefined) args.seedRatioLimited = ratio.enabled === true;
    if (ratio.ratio !== undefined) args.seedRatioLimit = Math.round(clampNumber(ratio.ratio, 0.1, 1000) * 100) / 100;
  }
  if (p.encryption !== undefined) {
    const value = { preferred: 'preferred', required: 'required', allowed: 'tolerated' }[String(p.encryption)];
    if (!value) throw new Error('Not an encryption setting');
    args.encryption = value;
  }
  if (p.portForwarding !== undefined) args['port-forwarding-enabled'] = p.portForwarding === true;
  if (Object.keys(args).length) await rpc('session-set', args);
  const session = await rpc('session-get', { fields: SETTINGS_FIELDS });
  lastSettings = toSettings(session);
  refreshSoon();
  return lastSettings;
}

/**
 * Where a transfer's download is (or one file of it): its folder in the
 * torrent's download folder, or its one file, as it's named while partial
 * too. Only ever what's in its download folder.
 */
async function downloadedPath(id: number, file: unknown): Promise<string> {
  const reply = await rpc('torrent-get', { ids: [id], fields: ['downloadDir', 'files', 'name'] });
  const t = (Array.isArray(reply.torrents) ? (reply.torrents as Json[]) : [])[0];
  if (!t) throw new Error('That transfer isn’t here any more.');
  const dir = path.resolve(str(t.downloadDir));
  const files = Array.isArray(t.files) ? (t.files as Json[]) : [];
  let relative: string;
  if (file === undefined || file === null) {
    relative = str(files[0]?.name).split('/')[0] || str(t.name);
  } else {
    if (typeof file !== 'number' || !Number.isInteger(file) || !files[file]) throw new Error('Not a file of it');
    relative = str(files[file].name);
  }
  const full = path.resolve(dir, relative);
  if (!full.startsWith(dir + path.sep)) throw new Error('Not in its download folder');
  for (const candidate of [full, `${full}.part`]) {
    if (await fsp.lstat(candidate).catch(() => null)) return candidate;
  }
  throw new Error('Nothing of it has been downloaded yet.');
}

/** Hand a path to the desktop: shown selected in Files, or opened in the app for it. */
async function showDownload(id: number, file: unknown, select: boolean): Promise<void> {
  const full = await downloadedPath(id, file);
  const stat = await fsp.stat(full);
  sendToShell('open-uri:path', { path: full, kind: stat.isDirectory() ? 'directory' : 'file', ...(select ? { select: true } : {}) });
}

/** Start Din's Transmission with Din when there are transfers to go on with. */
function resumeAtStartup(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(CONFIG_DIR, 'torrents'));
  } catch {
    return;
  }
  if (!entries.some((e) => e.endsWith('.torrent') || e.endsWith('.magnet'))) return;
  // After the desktop's up, not in its way.
  setTimeout(() => void ensureDaemon().catch((error: unknown) => console.warn('[torrents]', error instanceof Error ? error.message : error)), 8_000);
}

export function registerTorrentsHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;

  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(`torrents:${channel}`, (event, ...args: unknown[]) => {
      assertShellSender(event);
      return fn(...args);
    });

  handle('status', () => status());
  handle('list', () => list());
  handle('detail', (id) => detail(ids([id])[0]));
  handle('inspect', (src) => inspect(source(src)));
  handle('add', (src, opts) => add(source(src), opts));
  handle('start', async (list, now) => {
    await rpc(now === true ? 'torrent-start-now' : 'torrent-start', { ids: ids(list) });
    refreshSoon();
  });
  handle('stop', async (list) => {
    await rpc('torrent-stop', { ids: ids(list) });
    refreshSoon();
  });
  handle('verify', async (list) => {
    await rpc('torrent-verify', { ids: ids(list) });
    refreshSoon();
  });
  handle('reannounce', async (list) => {
    await rpc('torrent-reannounce', { ids: ids(list) });
    refreshSoon();
  });
  handle('remove', (list, opts) => remove(ids(list), !!opts && typeof opts === 'object' && (opts as Json).trash === true));
  handle('setFiles', (id, change) => setFiles(ids([id])[0], change));
  handle('setLocation', async (list, dir, move) => {
    await rpc('torrent-set-location', { ids: ids(list), location: await folder(dir), move: move === true });
    refreshSoon();
  });
  handle('setSettings', (patch) => setSettings(patch));
  handle('reveal', (id, file) => showDownload(ids([id])[0], file, true));
  handle('open', (id, file) => showDownload(ids([id])[0], file, false));
  handle('testPort', async () => {
    const reply = await rpc('port-test');
    return reply['port-is-open'] === true;
  });

  resumeAtStartup();

  app.on('will-quit', () => {
    quitting = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    // It saves where every transfer is as it stops.
    if (child) child.kill('SIGTERM');
    else if (sessionId) void rawRpc('session-close').catch(() => {});
  });
}
