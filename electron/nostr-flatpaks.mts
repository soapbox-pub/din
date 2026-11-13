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
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, net } from 'electron';

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
  asset: { sha256: string; size: number; urls: string[] };
}

/** One app installed from Din's remote, as kept in installed.json. */
interface InstalledRecord {
  coordinate: string;
  publishedAt: number;
  version: string;
  sha256: string;
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

/** The apps installed from Din's remote, forgetting any removed some other way. */
async function listInstalled(): Promise<InstalledFlatpak[]> {
  if (!(await flatpakAvailable())) return [];
  const [state, apps] = await Promise.all([readState(), installedApps()]);
  return Object.entries(state)
    .filter(([appId]) => apps.get(appId) === FLATPAK_REMOTE)
    .map(([appId, record]) => ({ appId, ...record }));
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
  if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) throw new FlatpakError('Not a Flatpak asset');
  const urls = (Array.isArray(asset.urls) ? asset.urls : []).filter((url): url is string => {
    if (typeof url !== 'string') return false;
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  });
  if (!urls.length) throw new FlatpakError('The release names nowhere to download its Flatpak from.');
  const size = typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : 0;
  return {
    appId,
    name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 200) : appId,
    coordinate,
    publishedAt,
    version: typeof v.version === 'string' ? v.version.slice(0, 100) : '',
    asset: { sha256: asset.sha256, size, urls: [...new Set(urls)].slice(0, 16) },
  };
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
  throw new FlatpakError(`${req.name}’s Flatpak couldn’t be downloaded, or no copy of it matched its release.`);
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

async function install(value: unknown, progress: (p: FlatpakProgress) => void, changed: () => void): Promise<InstalledFlatpak> {
  const req = checkRequest(value);
  if (!(await flatpakAvailable())) throw new FlatpakError('Flatpak isn’t installed on this computer.');
  return serially(async () => {
    const state = await readState();
    const owner = state[req.appId];
    const apps = await installedApps();
    const origin = apps.get(req.appId);
    if (origin && origin !== FLATPAK_REMOTE) {
      throw new FlatpakError(`${req.appId} is already installed from ${origin === 'flathub' ? 'Flathub' : origin}. Remove that one first.`);
    }
    if (owner && origin === FLATPAK_REMOTE && owner.coordinate.split(':')[1] !== req.coordinate.split(':')[1]) {
      throw new FlatpakError(`Another publisher’s app is installed as ${req.appId}. Remove it first.`);
    }

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
    };
    await writeState({ ...(await readState()), [req.appId]: record });
    changed();
    return { appId: req.appId, ...record };
  });
}

async function uninstall(appId: unknown, progress: (p: FlatpakProgress) => void, changed: () => void): Promise<void> {
  if (typeof appId !== 'string' || !APP_ID.test(appId)) throw new FlatpakError('Not a Flatpak application id');
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

/**
 * The flatpak:* handlers behind window.dinos.flatpaks: whether Flatpak is
 * here, what's installed from Nostr, installing a release and removing one.
 * `changed` is told after either, for the installed apps to be listed again.
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
    return { available: !!machine && (await flatpakAvailable()), platform: machine?.platform ?? null };
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
