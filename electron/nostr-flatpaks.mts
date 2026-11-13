// Flatpaks published on Nostr as NIP-82 software: an application (kind
// 32267) whose release (kind 30063) names a `.flatpak` bundle asset (kind
// 3063, `m application/vnd.flatpak`), installed the way npkg republishes
// them (~/Projects/npkg's src/publish/flatpak.ts), but for this computer
// alone.
//
// A bundle installed with `flatpak install --bundle` gets an origin remote
// with nowhere to update from. So, as npkg does, Din keeps a Flatpak remote
// of its own: an OSTree repository in archive-z2 mode under
// $XDG_DATA_HOME/din/flatpak/repo, added to the user's installation as the
// `din-nostr` remote (file://, no GPG: nothing goes into it but bundles
// whose bytes matched the hash in an event signed by the app's publisher,
// and only the user can write there). Installing a release:
//
//   1. downloads its bundle from the asset's URLs, hashing as it goes, and
//      keeps it only if the hash is the asset's `x`;
//   2. imports it into a scratch repository, first, and reads back the refs
//      it made: exactly one, `app/<id>/<arch>/<branch>`, `<id>` being the
//      NIP-82 app's `d` and `<arch>` this computer's. npkg stages for the
//      same reason: `build-import-bundle` writes the ref as it goes, so a
//      bundle claiming another app's id (or a runtime's) would have taken it
//      over by the time anything could look;
//   3. commits that ref into the remote's repository (`build-commit-from`,
//      hard links on one filesystem), regenerates its summary and prunes the
//      older commits, which nothing installs again;
//   4. installs or updates the app from the remote, whose runtimes come from
//      Flathub like any other Flatpak's.
//
// An id is the publisher's who installed it first: a second publisher's app
// claiming it is refused until it's removed. One installed from another
// remote (Flathub's) is refused too, rather than replaced.
//
// DinOS has `flatpak` but not `ostree`, so the repositories are made by hand
// (makeRepo) and refs read off disk, never through the ostree command.
//
// One writer at a time, as npkg's queue is: OSTree assumes it.
//
// A release may carry an AppImage instead, or as well (kind 3063,
// `m application/vnd.appimage`), which installs without Flatpak: the same
// download and hash check, then the file is kept in
// $XDG_DATA_HOME/din/appimages/<id>.AppImage, beside the icon it carries,
// with a desktop entry of Din's own in the user's applications folder
// (<id>.desktop, so the launcher has it under the same id a Flatpak's
// would be) that runs it the way Din runs any AppImage (appimage-run where
// there is one). An app is installed one way at a time: the other is
// refused until it's removed.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync, { constants as fsConstants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, net } from 'electron';
import { appImageEntryAndIcon } from './files.mts';

/** The user remote Din's own repository is added as. */
export const FLATPAK_REMOTE = 'din-nostr';
const REMOTE_TITLE = 'Nostr (Din)';
const FLATHUB = { name: 'flathub', url: 'https://dl.flathub.org/repo/flathub.flatpakrepo' };

const SHA256 = /^[0-9a-f]{64}$/;
const COORDINATE = /^32267:[0-9a-f]{64}:.+$/;
/** A Flatpak application id: reverse DNS, three parts or more (flatpak_is_valid_name). */
const APP_ID = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*){2,}$/;
const MAX_BUNDLE_BYTES = 8 * 1024 ** 3;
/** Importing and installing (runtimes included) can take a long while on a slow line. */
const INSTALL_TIMEOUT_MS = 60 * 60_000;
const QUICK_TIMEOUT_MS = 2 * 60_000;
/** flatpak is translated; its errors reach the user, but nothing here parses another language's. */
const ENV = { ...process.env, LC_ALL: 'C' };

export class FlatpakError extends Error {}

/** How an app is installed: from Din's Flatpak remote, or as an AppImage. */
type Format = 'flatpak' | 'appimage';

/** What the renderer sends to install a release (src/lib/nostrFlatpaks.ts). */
interface InstallRequest {
  /** The app's `d`, which is its Flatpak id. */
  appId: string;
  name: string;
  /** `32267:<pubkey>:<d>`. */
  coordinate: string;
  /** The release's `created_at`. */
  publishedAt: number;
  version: string;
  format: Format;
  asset: { sha256: string; size: number; urls: string[] };
}

/** One app installed from Nostr, as kept in installed.json. */
interface InstalledRecord {
  coordinate: string;
  publishedAt: number;
  version: string;
  sha256: string;
  format: Format;
}

export interface InstalledFlatpak extends InstalledRecord {
  appId: string;
}

export interface FlatpakProgress {
  appId: string;
  phase: 'download' | 'import' | 'install' | 'remove';
  /** 0-100, where it's known. */
  percent?: number;
}

function dataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
}

const base = (): string => path.join(dataHome(), 'din/flatpak');
const repoDir = (): string => path.join(base(), 'repo');
const stateFile = (): string => path.join(base(), 'installed.json');
const appImageDir = (): string => path.join(dataHome(), 'din/appimages');
const appImageFile = (appId: string): string => path.join(appImageDir(), `${appId}.AppImage`);
const entryFile = (appId: string): string => path.join(dataHome(), 'applications', `${appId}.desktop`);
/** The key in a desktop entry Din wrote for an AppImage it installed, naming the app. */
const ENTRY_MARK = 'X-Din-Nostr-App';

/** This computer's Flatpak arch, and the NIP-82 platform it runs. */
function arch(): { flatpak: string; platform: string } | null {
  if (process.arch === 'x64') return { flatpak: 'x86_64', platform: 'linux-x86_64' };
  if (process.arch === 'arm64') return { flatpak: 'aarch64', platform: 'linux-aarch64' };
  return null;
}

// ---------------------------------------------------------------------------
// Running flatpak
// ---------------------------------------------------------------------------

/** Run flatpak; resolves with its output, rejects with its last error line. */
function flatpak(
  args: string[],
  options: { timeout?: number; onLine?: (line: string) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('flatpak', args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? QUICK_TIMEOUT_MS);
    const take = (chunk: Buffer, into: 'out' | 'err') => {
      const text = chunk.toString();
      if (into === 'out') out += text;
      else err += text;
      if (options.onLine) for (const line of text.split(/[\r\n]+/)) if (line.trim()) options.onLine(line.trim());
    };
    child.stdout.on('data', (chunk: Buffer) => take(chunk, 'out'));
    child.stderr.on('data', (chunk: Buffer) => take(chunk, 'err'));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new FlatpakError('Flatpak isn’t installed on this computer.') : error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out);
        return;
      }
      const last = (err || out).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? `flatpak exited with ${code}`;
      reject(new FlatpakError(last.replace(/^error:\s*/i, '')));
    });
  });
}

let availability: Promise<boolean> | null = null;

function flatpakAvailable(): Promise<boolean> {
  availability ??= flatpak(['--version']).then(() => true, () => false);
  return availability;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/**
 * An empty archive-z2 OSTree repository, as `ostree init --mode=archive-z2`
 * makes one, which DinOS has no command for. Leaves one that's there alone.
 */
async function makeRepo(dir: string): Promise<void> {
  try {
    await fs.access(path.join(dir, 'config'));
    return;
  } catch {
    // Not there yet.
  }
  for (const sub of ['objects', 'tmp/cache', 'extensions', 'state', 'refs/heads', 'refs/mirrors', 'refs/remotes']) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
  await fs.writeFile(path.join(dir, 'config'), '[core]\nrepo_version=1\nmode=archive-z2\n');
}

/** The branch refs a repository holds, read off disk (`ostree refs`). */
async function refsIn(dir: string): Promise<string[]> {
  const heads = path.join(dir, 'refs/heads');
  const entries = await fs.readdir(heads, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(heads, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

/** Make sure the remote is there and points at the repository, and Flathub is there for runtimes. */
async function ensureRemotes(): Promise<void> {
  const url = `file://${repoDir()}`;
  const remotes = (await flatpak(['remotes', '--user', '--columns=name,url'])).split('\n').map((line) => line.split('\t'));
  const ours = remotes.find(([name]) => name === FLATPAK_REMOTE);
  if (!ours) {
    await flatpak(['remote-add', '--user', '--no-gpg-verify', `--title=${REMOTE_TITLE}`, FLATPAK_REMOTE, url]);
  } else if (ours[1]?.replace(/\/$/, '') !== url) {
    await flatpak(['remote-modify', '--user', '--no-gpg-verify', `--url=${url}`, FLATPAK_REMOTE]);
  }
  if (!remotes.some(([name]) => name === FLATHUB.name)) {
    await flatpak(['remote-add', '--user', '--if-not-exists', FLATHUB.name, FLATHUB.url], { timeout: QUICK_TIMEOUT_MS });
  }
}

// ---------------------------------------------------------------------------
// What's installed
// ---------------------------------------------------------------------------

async function readState(): Promise<Record<string, InstalledRecord>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(stateFile(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, InstalledRecord> = {};
    for (const [appId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const r = value as Partial<InstalledRecord> | null;
      if (!APP_ID.test(appId) || !r || typeof r.coordinate !== 'string' || !COORDINATE.test(r.coordinate)) continue;
      out[appId] = {
        coordinate: r.coordinate,
        publishedAt: typeof r.publishedAt === 'number' ? r.publishedAt : 0,
        version: typeof r.version === 'string' ? r.version : '',
        sha256: typeof r.sha256 === 'string' && SHA256.test(r.sha256) ? r.sha256 : '',
        // Records from before AppImages are all Flatpaks.
        format: r.format === 'appimage' ? 'appimage' : 'flatpak',
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function writeState(state: Record<string, InstalledRecord>): Promise<void> {
  await fs.mkdir(base(), { recursive: true });
  const tmp = `${stateFile()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, stateFile());
}

/** Every app installed, by id, with the remote it came from. */
async function installedApps(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const text = await flatpak(['list', '--app', '--columns=application,origin']).catch(() => '');
  for (const line of text.split('\n')) {
    const [id, origin] = line.split('\t');
    if (id?.trim()) out.set(id.trim(), origin?.trim() ?? '');
  }
  return out;
}

/** Every app installed, by id, with its remote; none where Flatpak isn't. */
async function installedFlatpaks(): Promise<Map<string, string>> {
  return (await flatpakAvailable()) ? installedApps() : new Map();
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

/** The apps installed from Nostr, forgetting any removed some other way. */
async function listInstalled(): Promise<InstalledFlatpak[]> {
  const [state, apps] = await Promise.all([readState(), installedFlatpaks()]);
  const out: InstalledFlatpak[] = [];
  for (const [appId, record] of Object.entries(state)) {
    const here = record.format === 'appimage' ? await exists(appImageFile(appId)) : apps.get(appId) === FLATPAK_REMOTE;
    if (here) out.push({ appId, ...record });
  }
  return out;
}

/** Whether this computer can run AppImages: Linux, on an architecture NIP-82 names. */
function appImagesAvailable(): boolean {
  return process.platform === 'linux' && !!arch();
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

function checkRequest(value: unknown): InstallRequest {
  const v = (value ?? {}) as Record<string, unknown>;
  const asset = (v.asset ?? {}) as Record<string, unknown>;
  const { appId, coordinate, publishedAt } = v;
  if (typeof appId !== 'string' || !APP_ID.test(appId) || appId.length > 255) {
    throw new FlatpakError('This app’s identifier isn’t a Flatpak application id.');
  }
  if (typeof coordinate !== 'string' || !COORDINATE.test(coordinate) || coordinate.split(':').slice(2).join(':') !== appId) {
    throw new FlatpakError('Not a NIP-82 app');
  }
  if (typeof publishedAt !== 'number' || !Number.isInteger(publishedAt) || publishedAt < 0) throw new FlatpakError('Not a release');
  const format: Format = v.format === 'appimage' ? 'appimage' : 'flatpak';
  if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) throw new FlatpakError('Not an asset');
  const urls = (Array.isArray(asset.urls) ? asset.urls : []).filter((url): url is string => {
    if (typeof url !== 'string') return false;
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  });
  if (!urls.length) throw new FlatpakError(`The release names nowhere to download its ${formatName(format)} from.`);
  const size = typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : 0;
  // The name goes into a desktop entry: one line, no control characters.
  const name = typeof v.name === 'string' ? v.name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, 200) : '';
  return {
    appId,
    name: name || appId,
    coordinate,
    publishedAt,
    version: typeof v.version === 'string' ? v.version.slice(0, 100) : '',
    format,
    asset: { sha256: asset.sha256, size, urls: [...new Set(urls)].slice(0, 16) },
  };
}

function formatName(format: Format): string {
  return format === 'appimage' ? 'AppImage' : 'Flatpak';
}

/** Download a bundle to `file` from the first URL whose copy has its hash. */
async function download(req: InstallRequest, file: string, progress: (percent?: number) => void): Promise<void> {
  const limit = req.asset.size || MAX_BUNDLE_BYTES;
  for (const url of req.asset.urls) {
    try {
      const response = await net.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
      if (!response.ok || !response.body) continue;
      const total = req.asset.size || Number(response.headers.get('content-length')) || 0;
      const hash = crypto.createHash('sha256');
      const out = createWriteStream(file);
      let bytes = 0;
      let last = -1;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += chunk.length;
          if (bytes > limit) throw new FlatpakError('too big');
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
          const percent = total ? Math.min(99, Math.floor((bytes / total) * 100)) : undefined;
          if (percent !== last) {
            last = percent ?? -1;
            progress(percent);
          }
        }
      } finally {
        await new Promise<void>((resolve) => out.end(() => resolve()));
      }
      // The event is signed; the server isn't trusted.
      if (hash.digest('hex') === req.asset.sha256) return;
    } catch {
      // Unreachable, too slow, too big: the next URL.
    }
  }
  throw new FlatpakError(`${req.name}’s ${formatName(req.format)} couldn’t be downloaded, or no copy of it matched its release.`);
}

/**
 * Import a verified bundle into Din's repository, by way of a scratch one,
 * after checking it's the app it says it is. Resolves with its ref.
 */
async function importBundle(req: InstallRequest, file: string, staging: string): Promise<string> {
  const machine = arch();
  if (!machine) throw new FlatpakError('Flatpaks from Nostr aren’t available on this kind of computer.');
  const scratch = path.join(staging, 'scratch');
  await makeRepo(scratch);
  await flatpak(['build-import-bundle', '--no-update-summary', scratch, file], { timeout: INSTALL_TIMEOUT_MS });
  const refs = await refsIn(scratch);
  const [ref] = refs;
  const parts = ref?.split('/') ?? [];
  if (refs.length !== 1 || parts.length !== 4 || parts[0] !== 'app') {
    throw new FlatpakError(`${req.name}’s Flatpak isn’t one application, so it wasn’t installed.`);
  }
  if (parts[1] !== req.appId) {
    throw new FlatpakError(`${req.name}’s Flatpak says it’s ${parts[1]}, not ${req.appId}, so it wasn’t installed.`);
  }
  if (parts[2] !== machine.flatpak) {
    throw new FlatpakError(`${req.name}’s Flatpak is built for ${parts[2]}, and this computer is ${machine.flatpak}.`);
  }
  const repo = repoDir();
  await makeRepo(repo);
  await flatpak(['build-commit-from', '--no-update-summary', `--src-repo=${scratch}`, repo, ref], { timeout: INSTALL_TIMEOUT_MS });
  // One commit per ref: nothing installs an older one from here again.
  await flatpak(['build-update-repo', '--prune', '--prune-depth=0', repo], { timeout: INSTALL_TIMEOUT_MS });
  return ref;
}

let queue: Promise<unknown> = Promise.resolve();

/** Run one change to the repository after any running now. */
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** Refuse an app another publisher's app is installed as, or one installed the other way. */
function checkOwner(req: InstallRequest, owner: InstalledRecord | undefined, installed: boolean): void {
  if (!owner || !installed) return;
  if (owner.coordinate.split(':')[1] !== req.coordinate.split(':')[1]) {
    throw new FlatpakError(`Another publisher’s app is installed as ${req.appId}. Remove it first.`);
  }
  if (owner.format !== req.format) {
    throw new FlatpakError(`${req.name} is installed as ${owner.format === 'appimage' ? 'an AppImage' : 'a Flatpak'}. Remove it first.`);
  }
}

async function install(value: unknown, progress: (p: FlatpakProgress) => void, changed: () => void): Promise<InstalledFlatpak> {
  const req = checkRequest(value);
  if (req.format === 'appimage') return installAppImage(req, progress, changed);
  if (!(await flatpakAvailable())) throw new FlatpakError('Flatpak isn’t installed on this computer.');
  return serially(async () => {
    const state = await readState();
    const owner = state[req.appId];
    if (owner?.format === 'appimage') checkOwner(req, owner, await exists(appImageFile(req.appId)));
    const apps = await installedApps();
    const origin = apps.get(req.appId);
    if (origin && origin !== FLATPAK_REMOTE) {
      throw new FlatpakError(`${req.appId} is already installed from ${origin === 'flathub' ? 'Flathub' : origin}. Remove that one first.`);
    }
    if (owner?.format === 'flatpak') checkOwner(req, owner, origin === FLATPAK_REMOTE);

    await fs.mkdir(base(), { recursive: true });
    const staging = await fs.mkdtemp(path.join(base(), '.staging-'));
    try {
      const file = path.join(staging, 'bundle.flatpak');
      progress({ appId: req.appId, phase: 'download', percent: 0 });
      await download(req, file, (percent) => progress({ appId: req.appId, phase: 'download', percent }));
      progress({ appId: req.appId, phase: 'import' });
      await importBundle(req, file, staging);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }

    progress({ appId: req.appId, phase: 'install' });
    await ensureRemotes();
    const args = origin === FLATPAK_REMOTE
      ? ['update', '--user', '--noninteractive', '-y', req.appId]
      : ['install', '--user', '--noninteractive', '-y', FLATPAK_REMOTE, req.appId];
    await flatpak(args, {
      timeout: INSTALL_TIMEOUT_MS,
      onLine: (line) => {
        const step = /^(?:Installing|Updating)\s+(\d+)\/(\d+)/.exec(line);
        if (step) progress({ appId: req.appId, phase: 'install', percent: Math.floor(((Number(step[1]) - 1) / Number(step[2])) * 100) });
      },
    });

    const record: InstalledRecord = {
      coordinate: req.coordinate,
      publishedAt: req.publishedAt,
      version: req.version,
      sha256: req.asset.sha256,
      format: 'flatpak',
    };
    await writeState({ ...(await readState()), [req.appId]: record });
    changed();
    return { appId: req.appId, ...record };
  });
}

async function uninstall(appId: unknown, progress: (p: FlatpakProgress) => void, changed: () => void): Promise<void> {
  if (typeof appId !== 'string' || !APP_ID.test(appId)) throw new FlatpakError('Not a Flatpak application id');
  if ((await readState())[appId]?.format === 'appimage') return uninstallAppImage(appId, progress, changed);
  if (!(await flatpakAvailable())) throw new FlatpakError('Flatpak isn’t installed on this computer.');
  return serially(async () => {
    const state = await readState();
    if (!state[appId]) throw new FlatpakError(`${appId} wasn’t installed from Nostr.`);
    progress({ appId, phase: 'remove' });
    const origin = (await installedApps()).get(appId);
    if (origin === FLATPAK_REMOTE) {
      await flatpak(['uninstall', '--user', '--noninteractive', '-y', appId], { timeout: INSTALL_TIMEOUT_MS });
    }
    // Its refs leave the repository too, so its objects can go and the id is free again.
    const repo = repoDir();
    for (const ref of await refsIn(repo)) {
      if (ref.split('/')[1] === appId) await fs.rm(path.join(repo, 'refs/heads', ...ref.split('/')), { force: true });
    }
    await flatpak(['build-update-repo', '--prune', repo], { timeout: INSTALL_TIMEOUT_MS }).catch(() => {});
    const { [appId]: _gone, ...rest } = state;
    await writeState(rest);
    changed();
  });
}

// ---------------------------------------------------------------------------
// AppImages
// ---------------------------------------------------------------------------

/** ELF machines (e_machine) by Flatpak arch name. */
const ELF_MACHINES: Record<number, string> = { 0x3e: 'x86_64', 0xb7: 'aarch64' };

/**
 * The arch an AppImage is built for, or null when the file isn't one: an
 * ELF executable (its runtime) with the AppImage magic, "AI" and its type,
 * at byte 8.
 */
async function appImageArch(file: string): Promise<string | null> {
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(20);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < head.length || !head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return null;
    if (head[8] !== 0x41 || head[9] !== 0x49 || (head[10] !== 1 && head[10] !== 2)) return null;
    // e_machine, in the file's byte order (EI_DATA: 1 little-endian).
    const machine = head[5] === 1 ? head.readUInt16LE(18) : head.readUInt16BE(18);
    return ELF_MACHINES[machine] ?? `machine ${machine}`;
  } finally {
    await handle.close();
  }
}

/** Whether a program is on PATH, as a desktop entry's Exec finds it. */
function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(':').some((dir) => {
    if (!dir) return false;
    try {
      fsSync.accessSync(path.join(dir, command), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The [Desktop Entry] group's keys, as written. */
function entryValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let inEntry = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (inEntry) break;
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    const eq = line.indexOf('=');
    if (inEntry && eq > 0) values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/\p{Cc}/gu, ''));
  }
  return values;
}

/** A string as a desktop entry's value. */
const entryValue = (text: string): string => text.replace(/\\/g, '\\\\');

/** A program's path as an argument in Exec, quoted. */
const execArg = (arg: string): string => `"${arg.replace(/[\\"`$]/g, '\\$&')}"`;

/**
 * The desktop entry for an installed AppImage: its name as the store has it,
 * its icon, and what its own entry says of it (the arguments its Exec gives
 * the program, the types it opens, the window class that ties its windows
 * to it), running the AppImage itself the way Din runs any (appimage-run
 * where there is one, as on DinOS).
 */
function appImageEntry(req: InstallRequest, file: string, icon: string | null, embedded: string | null): string {
  const own = entryValues(embedded ?? '');
  const program = [...(onPath('appimage-run') ? ['appimage-run'] : []), execArg(file)].join(' ');
  // Its Exec's own program is inside the AppImage; its arguments (Electron's
  // --no-sandbox, a %U) follow ours, as written.
  let args = '';
  const exec = own.get('Exec');
  if (exec) {
    const first = /^("(?:[^"\\]|\\.)*"|\S+)\s*/.exec(exec);
    args = first && first[1] !== 'env' ? exec.slice(first[0].length) : (/%[UuFf]/.exec(exec)?.[0] ?? '');
  }
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${entryValue(req.name)}`,
    `Exec=${entryValue(program)}${args ? ` ${args}` : ''}`,
    `TryExec=${entryValue(file)}`,
    ...(icon ? [`Icon=${entryValue(icon)}`] : []),
    ...['Comment', 'Categories', 'Keywords', 'MimeType', 'StartupWMClass'].flatMap((key) => {
      const value = own.get(key);
      return value ? [`${key}=${value}`] : [];
    }),
    'Terminal=false',
    `${ENTRY_MARK}=${req.appId}`,
    '',
  ];
  return lines.join('\n');
}

/** Whether the entry at `file` is the one Din wrote for this app (or there's none). */
async function entryIsOurs(appId: string): Promise<boolean> {
  const text = await fs.readFile(entryFile(appId), 'utf8').catch(() => null);
  return text === null || text.split('\n').some((line) => line.trim() === `${ENTRY_MARK}=${appId}`);
}

async function removeAppImageIcons(appId: string): Promise<void> {
  for (const ext of ['png', 'svg']) await fs.rm(path.join(appImageDir(), `${appId}.${ext}`), { force: true });
}

async function writeAtomically(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.din-tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function installAppImage(req: InstallRequest, progress: (p: FlatpakProgress) => void, changed: () => void): Promise<InstalledFlatpak> {
  const machine = arch();
  if (!appImagesAvailable() || !machine) throw new FlatpakError('AppImages from Nostr aren’t available on this kind of computer.');
  return serially(async () => {
    const state = await readState();
    const owner = state[req.appId];
    const file = appImageFile(req.appId);
    const origin = (await installedFlatpaks()).get(req.appId);
    if (origin && origin !== FLATPAK_REMOTE) {
      throw new FlatpakError(`${req.appId} is already installed from ${origin === 'flathub' ? 'Flathub' : origin}. Remove that one first.`);
    }
    checkOwner(req, owner, owner?.format === 'appimage' ? await exists(file) : origin === FLATPAK_REMOTE);
    if (origin === FLATPAK_REMOTE) throw new FlatpakError(`${req.name} is installed as a Flatpak. Remove it first.`);
    if (!(await entryIsOurs(req.appId))) {
      throw new FlatpakError(`Another app is in your applications folder as ${req.appId}, so ${req.name} wasn’t installed.`);
    }

    await fs.mkdir(appImageDir(), { recursive: true });
    const staging = await fs.mkdtemp(path.join(appImageDir(), '.staging-'));
    try {
      const staged = path.join(staging, 'app.AppImage');
      progress({ appId: req.appId, phase: 'download', percent: 0 });
      await download(req, staged, (percent) => progress({ appId: req.appId, phase: 'download', percent }));
      progress({ appId: req.appId, phase: 'import' });
      const built = await appImageArch(staged);
      if (!built) throw new FlatpakError(`${req.name}’s AppImage isn’t one, so it wasn’t installed.`);
      if (built !== machine.flatpak) throw new FlatpakError(`${req.name}’s AppImage is built for ${built}, and this computer is ${machine.flatpak}.`);
      await fs.chmod(staged, 0o755);
      progress({ appId: req.appId, phase: 'install' });
      const { entry: embedded, icon } = await appImageEntryAndIcon(staged);
      await removeAppImageIcons(req.appId);
      const iconFile = icon ? path.join(appImageDir(), `${req.appId}.${icon.type === 'image/svg+xml' ? 'svg' : 'png'}`) : null;
      if (icon && iconFile) await writeAtomically(iconFile, icon.data);
      // A running copy keeps the file it started from.
      await fs.rename(staged, file);
      await writeAtomically(entryFile(req.appId), appImageEntry(req, file, iconFile, embedded));
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }

    const record: InstalledRecord = {
      coordinate: req.coordinate,
      publishedAt: req.publishedAt,
      version: req.version,
      sha256: req.asset.sha256,
      format: 'appimage',
    };
    await writeState({ ...(await readState()), [req.appId]: record });
    changed();
    return { appId: req.appId, ...record };
  });
}

async function uninstallAppImage(appId: string, progress: (p: FlatpakProgress) => void, changed: () => void): Promise<void> {
  return serially(async () => {
    const state = await readState();
    if (state[appId]?.format !== 'appimage') throw new FlatpakError(`${appId} wasn’t installed from Nostr.`);
    progress({ appId, phase: 'remove' });
    if (await entryIsOurs(appId)) await fs.rm(entryFile(appId), { force: true });
    await fs.rm(appImageFile(appId), { force: true });
    await removeAppImageIcons(appId);
    const { [appId]: _gone, ...rest } = state;
    await writeState(rest);
    changed();
  });
}

/**
 * The flatpak:* handlers behind window.dinos.flatpaks: which ways this
 * computer installs Linux apps (Flatpak, AppImage), what's installed from
 * Nostr, installing a release either way and removing one. `changed` is
 * told after either, for the installed apps to be listed again.
 */
export function registerNostrFlatpakHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  shell: () => Electron.WebContents | null;
  changed: () => void;
}): void {
  const { assertShellSender } = options;
  const progress = (p: FlatpakProgress) => options.shell()?.send('flatpaks:progress', p);

  ipcMain.handle('flatpaks:status', async (event) => {
    assertShellSender(event);
    const machine = arch();
    const formats: Format[] = [];
    if (machine && (await flatpakAvailable())) formats.push('flatpak');
    if (appImagesAvailable()) formats.push('appimage');
    return { available: formats.length > 0, platform: machine?.platform ?? null, formats };
  });

  ipcMain.handle('flatpaks:installed', async (event) => {
    assertShellSender(event);
    return listInstalled();
  });

  ipcMain.handle('flatpaks:install', async (event, request: unknown) => {
    assertShellSender(event);
    return install(request, progress, options.changed);
  });

  ipcMain.handle('flatpaks:uninstall', async (event, appId: unknown) => {
    assertShellSender(event);
    await uninstall(appId, progress, options.changed);
  });
}
