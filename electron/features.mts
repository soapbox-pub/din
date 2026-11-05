// The optional features bridge (window.dinos.features, for Settings →
// Optional Features and `din features`): parts of DinOS that aren't on the
// disk until someone wants them - Wine, QEMU, Whisper, WebKitGTK, Podman.
//
// The system lists them in DIN_FEATURES (/etc/dinos/features.json, written
// by os/configuration.nix): for each, its parts, by the store paths they
// are, none of which is in the system. Installing one downloads each part
// as the user, through the Nix daemon - a package from the binary cache, a
// plain download (the Whisper model, or the .NET runtime's zips, unpacked)
// from its URL, checked against its hash - with a link at DIN_FEATURES_DIR/<id>/<part>: the links are both
// what keeps them from being collected and where everything that uses them
// looks (the launcher's PATH and DIN_* variables), so it works as soon as
// they're there. Removing one takes its links away and deletes what only
// it used.
//
// Some come with the computer (`default` in the manifest: dictation): they're
// wanted until the user removes one, and download in the background, as if
// they'd been installed just before the computer restarted. Every choice -
// installing, removing, or a default nobody changed - is kept in CHOICES, so
// an install that a restart or a lost connection cut short picks up again
// the next time Din starts or the computer is online. Nothing downloads by
// itself from a live USB stick (/run/din/live): the stick is slow and small,
// and the computer it's installed onto downloads them instead.
//
// A system update downloads the new versions of installed features before
// it switches (os/din-update.sh); one it couldn't (offline, say) keeps working
// as it was, and is brought up to date here soon after Din starts. A
// computer updated from a DinOS that had them all built in keeps them all
// (migrate). One installed before features had parts, as a single link at
// DIN_FEATURES_DIR/<id>, counts as installed but not current, so it's
// downloaded again in parts.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { ipcMain, net } from 'electron';

const MANIFEST = process.env.DIN_FEATURES;
const DIR = process.env.DIN_FEATURES_DIR;
/** Which features the user wants, next to DIR (not in it: the updater reads every link there). */
const CHOICES = DIR ? path.join(path.dirname(DIR), 'feature-choices.json') : null;
/** A live USB boot, where nothing downloads by itself (os/configuration.nix's dinos-live). */
const LIVE = fs.existsSync('/run/din/live');
/** How often wanted features that aren't there yet are tried again. */
const RETRY_MS = 5 * 60_000;

/** The order Settings lists them in; any others follow by id. */
const ORDER = ['windows', 'vms', 'dictation', 'containers', 'webkit'];

const STORE_PATH = /^\/nix\/store\/[0-9a-z]{32}-[^/]+$/;

/**
 * A part: a package in the binary cache, or a plain download (`url`, its
 * `name` and `hash`), which with `unpack` is an archive unpacked in the
 * store (the .NET runtime).
 */
interface Part {
  path: string;
  url?: string;
  name?: string;
  hash?: string;
  unpack?: boolean;
}

interface ManifestEntry {
  title: string;
  description: string;
  size: number;
  /** Comes with the computer: wanted until removed. */
  default: boolean;
  parts: Record<string, Part>;
}

type Choice = 'wanted' | 'declined';

export type FeatureAction = 'install' | 'remove';
/** What an action is doing now: waiting its turn, fetching, building, or deleting. */
export type FeaturePhase = 'waiting' | 'downloading' | 'building' | 'removing';

export interface FeatureState {
  id: string;
  title: string;
  description: string;
  /** About what installing it takes, in bytes. */
  size: number;
  /** Its link is there, to something in the store. */
  installed: boolean;
  /** Installed, and the version this system has (not one from before an update). */
  current: boolean;
  /**
   * Installed, or on its way: the user installed it, or it comes with the
   * computer and they haven't removed it. One that's wanted and not
   * installed downloads in the background (except on a live USB stick).
   */
  wanted: boolean;
  busy: { action: FeatureAction; phase: FeaturePhase; progress: number | null } | null;
  /** Why its last action failed, until the next one. */
  error: string | null;
}

export interface FeaturesState {
  /** False off DinOS, where there's nothing to install this way. */
  available: boolean;
  /** Running from a live USB stick, where wanted features don't download by themselves. */
  live: boolean;
  features: FeatureState[];
}

let sendToShell: (channel: string, payload?: unknown) => void = () => {};

const busy = new Map<string, NonNullable<FeatureState['busy']>>();
const errors = new Map<string, string>();
/** One action at a time: they share the daemon, the disk and the network. */
let queue: Promise<unknown> = Promise.resolve();

function readManifest(): Record<string, ManifestEntry> {
  if (!MANIFEST) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return {};
  }
  const entries: Record<string, ManifestEntry> = {};
  if (!raw || typeof raw !== 'object') return entries;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Partial<ManifestEntry> | null;
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !v) continue;
    const parts = readParts(v.parts);
    if (!parts) continue;
    entries[id] = {
      title: typeof v.title === 'string' ? v.title : id,
      description: typeof v.description === 'string' ? v.description : '',
      size: typeof v.size === 'number' ? v.size : 0,
      default: v.default === true,
      parts,
    };
  }
  return entries;
}

/** A feature's parts, or null if any isn't one. */
function readParts(raw: unknown): Record<string, Part> | null {
  if (!raw || typeof raw !== 'object') return null;
  const parts: Record<string, Part> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Partial<Part> | null;
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !v || typeof v.path !== 'string' || !STORE_PATH.test(v.path)) return null;
    if (v.url === undefined) {
      parts[name] = { path: v.path };
    } else if (typeof v.url === 'string' && /^https:\/\//.test(v.url) && typeof v.name === 'string' && typeof v.hash === 'string') {
      parts[name] = { path: v.path, url: v.url, name: v.name, hash: v.hash, unpack: v.unpack === true };
    } else {
      return null;
    }
  }
  return Object.keys(parts).length > 0 ? parts : null;
}

/** A feature's folder of part links (or, from before parts, its one link). */
function folderOf(id: string): string {
  if (!DIR) throw new Error('Optional features aren’t available here');
  return path.join(DIR, id);
}

/** Where a link points, if it's there and what it points to is too. */
function target(link: string): string | null {
  try {
    const to = fs.readlinkSync(link);
    return fs.existsSync(to) ? to : null;
  } catch {
    return null;
  }
}

/** What a feature has in the store: its parts' paths, by name, or its one link's, from before parts. */
function installedPaths(id: string): string[] {
  const folder = folderOf(id);
  const legacy = target(folder);
  if (legacy) return [legacy];
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names.map((name) => target(path.join(folder, name))).filter((p): p is string => p !== null);
}

/** Every part linked, to this system's version of it. */
function isCurrent(id: string, entry: ManifestEntry): boolean {
  const folder = folderOf(id);
  return Object.entries(entry.parts).every(([name, part]) => target(path.join(folder, name)) === part.path);
}

function readChoices(): Record<string, Choice> {
  if (!CHOICES) return {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(CHOICES, 'utf8'));
    const choices: Record<string, Choice> = {};
    if (raw && typeof raw === 'object') {
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value === 'wanted' || value === 'declined') choices[id] = value;
      }
    }
    return choices;
  } catch {
    return {};
  }
}

function writeChoices(choices: Record<string, Choice>): void {
  if (!CHOICES) return;
  fs.mkdirSync(path.dirname(CHOICES), { recursive: true });
  const temp = `${CHOICES}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(choices, null, 2)}\n`);
  fs.renameSync(temp, CHOICES);
}

function choose(id: string, choice: Choice): void {
  writeChoices({ ...readChoices(), [id]: choice });
}

/** Whether a feature is wanted: as the user chose, or by its link and default. */
function isWanted(id: string, entry: ManifestEntry, choices: Record<string, Choice>, installed: boolean): boolean {
  const choice = choices[id];
  if (choice) return choice === 'wanted';
  return installed || entry.default;
}

function byOrder(a: string, b: string): number {
  const ia = ORDER.indexOf(a);
  const ib = ORDER.indexOf(b);
  if (ia !== ib) return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
  return a.localeCompare(b);
}

function state(): FeaturesState {
  const manifest = readManifest();
  const ids = Object.keys(manifest).sort(byOrder);
  const choices = readChoices();
  return {
    available: Boolean(DIR) && ids.length > 0,
    live: LIVE,
    features: ids.map((id) => {
      const entry = manifest[id];
      const installed = DIR ? installedPaths(id).length > 0 : false;
      return {
        id,
        title: entry.title,
        description: entry.description,
        size: entry.size,
        installed,
        current: installed && isCurrent(id, entry),
        wanted: isWanted(id, entry, choices, installed),
        busy: busy.get(id) ?? null,
        error: errors.get(id) ?? null,
      };
    }),
  };
}

let notifyTimer: NodeJS.Timeout | null = null;
/** Tell the shell, at most a few times a second while something downloads. */
function notify(now = false): void {
  if (now) {
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = null;
    sendToShell('features:changed', state());
    return;
  }
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    sendToShell('features:changed', state());
  }, 250);
}

function entryFor(id: unknown): [string, ManifestEntry] {
  const manifest = readManifest();
  if (typeof id !== 'string' || !Object.hasOwn(manifest, id)) throw new Error(`There’s no optional feature “${String(id)}”`);
  return [id, manifest[id]];
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

/** A store path and everything it refers to. */
async function closure(paths: string[]): Promise<string[]> {
  const present = paths.filter((p) => fs.existsSync(p));
  if (present.length === 0) return [];
  return (await run('nix-store', ['--query', '--requisites', ...present])).split('\n').filter(Boolean);
}

// Nix colours its errors.
// eslint-disable-next-line no-control-regex
const strip = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
/** Store paths as their names, for an error a person reads. */
const readable = (text: string) => text.replace(/\/nix\/store\/[0-9a-z]{32}-([^\s'"]+?)(\.drv)?(?=['"\s]|$)/g, '$1');

/**
 * Run `nix` with its internal-json log, its download progress (bytes done,
 * of those expected) as the feature's busy progress, and its first error as
 * the one it fails with.
 */
function nixWithProgress(id: string, args: string[], fallback: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('nix', [...args, '--log-format', 'internal-json', '-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
    // actFileTransfer (101): resProgress is [bytes done, bytes expected].
    // Substituting, the whole download's size comes as resSetExpected for
    // that type, on the activity realising the lot.
    const copied = new Map<number, number>();
    const expected = new Map<number, number>();
    const ownExpected = new Map<number, number>();
    const types = new Map<number, number>();
    let firstError = '';
    let buffer = '';
    let stdout = '';
    const update = () => {
      const done = [...copied.values()].reduce((a, b) => a + b, 0);
      const total = [...(expected.size > 0 ? expected : ownExpected).values()].reduce((a, b) => a + b, 0);
      const current = busy.get(id);
      if (!current) return;
      current.phase = 'downloading';
      current.progress = total <= 0 ? null : Math.min(1, done / total);
      notify();
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('@nix ')) continue;
        let m: { action?: string; id?: number; type?: number; fields?: unknown[]; level?: number; msg?: string };
        try {
          m = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (m.action === 'start' && typeof m.id === 'number' && typeof m.type === 'number') {
          types.set(m.id, m.type);
        } else if (m.action === 'stop' && typeof m.id === 'number') {
          types.delete(m.id);
        } else if (m.action === 'result' && typeof m.id === 'number' && Array.isArray(m.fields)) {
          if (m.type === 105 && types.get(m.id) === 101 && typeof m.fields[0] === 'number') {
            copied.set(m.id, m.fields[0]);
            if (typeof m.fields[1] === 'number' && m.fields[1] > 0) ownExpected.set(m.id, m.fields[1]);
            update();
          } else if (m.type === 106 && m.fields[0] === 101 && typeof m.fields[1] === 'number') {
            expected.set(m.id, m.fields[1]);
            update();
          }
        } else if (m.action === 'msg' && m.level === 0 && typeof m.msg === 'string' && !firstError) {
          firstError = readable(strip(m.msg).replace(/^error: /, ''))
            .split('\n')
            .find((l) => /\S/.test(l))
            ?.trim() ?? '';
        }
      }
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(firstError || fallback));
    });
  });
}

/**
 * Download a feature's parts that aren't this system's versions, and link
 * each into its folder: the packages from the binary cache together, then
 * any plain download. A folder from before parts, one link, makes way.
 */
async function fetchParts(id: string, entry: ManifestEntry): Promise<void> {
  const folder = folderOf(id);
  const failed = `Couldn’t install ${entry.title}`;
  if (fs.lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(folder);
  fs.mkdirSync(folder, { recursive: true });
  const missing = Object.entries(entry.parts).filter(([name, part]) => target(path.join(folder, name)) !== part.path);
  const packages = missing.filter(([, part]) => part.url === undefined);
  if (packages.length > 0) {
    await nixWithProgress(id, ['build', '--no-link', ...packages.map(([, part]) => part.path)], failed);
  }
  for (const [, part] of missing.filter(([, p]) => p.url !== undefined)) {
    const out = await nixWithProgress(id, ['store', 'prefetch-file', '--json', ...(part.unpack ? ['--unpack'] : []), '--name', part.name ?? '', '--expected-hash', part.hash ?? '', part.url ?? ''], failed);
    let storePath: unknown;
    try {
      storePath = (JSON.parse(out) as { storePath?: unknown }).storePath;
    } catch {
      storePath = null;
    }
    if (storePath !== part.path) throw new Error(`${failed}: its download isn’t the one this system expects`);
  }
  // The links, each a root that keeps its part: Nix holds what it just
  // downloaded only while it runs, so a collection in between would mean
  // downloading it again here, never a link to nothing.
  for (const [name, part] of missing) {
    await run('nix', ['build', '--out-link', path.join(folder, name), part.path]);
  }
  for (const name of fs.readdirSync(folder)) {
    if (!Object.hasOwn(entry.parts, name)) fs.rmSync(path.join(folder, name), { force: true });
  }
  if (!isCurrent(id, entry)) throw new Error(failed);
}

/**
 * Delete what only a removed feature used: its closure, less what the
 * system and the other installed features have. Anything else still in
 * use (a program of it running, another profile's) is something Nix won't
 * delete, so it and what it refers to are left out and the rest tried again.
 */
async function deleteUnused(paths: string[]): Promise<void> {
  const keep = new Set(await closure(['/run/current-system', ...state().features.flatMap((f) => installedPaths(f.id))]));
  let candidates = (await closure(paths)).filter((p) => !keep.has(p));
  for (let attempt = 0; candidates.length > 0 && attempt < 200; attempt++) {
    try {
      await run('nix', ['store', 'delete', ...candidates]);
      return;
    } catch (error) {
      const alive = /Cannot delete path '([^']+)' since it is still alive/.exec(String((error as Error).message))?.[1];
      if (!alive) throw error;
      const live = new Set(await closure([alive]));
      live.add(alive);
      candidates = candidates.filter((p) => !live.has(p));
    }
  }
}

/** Run an action on the queue, with its busy state and its error. */
function enqueue(id: string, action: FeatureAction, work: () => Promise<void>): Promise<void> {
  if (busy.has(id)) return Promise.reject(new Error('It’s already being changed'));
  busy.set(id, { action, phase: 'waiting', progress: null });
  errors.delete(id);
  notify(true);
  const next = queue.then(async () => {
    busy.set(id, { action, phase: action === 'remove' ? 'removing' : 'downloading', progress: null });
    notify(true);
    try {
      await work();
    } catch (error) {
      errors.set(id, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      busy.delete(id);
      notify(true);
    }
  });
  queue = next.catch(() => {});
  return next;
}

/** Install a feature, or bring an installed one up to this system's version. */
export function install(id: unknown): Promise<void> {
  const [key] = entryFor(id);
  // Chosen before it downloads, so a restart halfway doesn't forget it.
  choose(key, 'wanted');
  return fetchFeature(key);
}

/** Download a feature's parts as this system has them, if it doesn't already. */
function fetchFeature(key: string): Promise<void> {
  const [, entry] = entryFor(key);
  if (isCurrent(key, entry)) return Promise.resolve();
  return enqueue(key, 'install', () => fetchParts(key, entry));
}

/** Install every feature that isn't. */
export async function installAll(): Promise<void> {
  const pending = state().features.filter((f) => !f.current && !f.busy);
  const results = await Promise.allSettled(pending.map((f) => install(f.id)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) throw new Error(failed === 1 ? 'One feature couldn’t be installed' : `${failed} features couldn’t be installed`);
}

/**
 * Remove a feature, and don't want it any more: one that comes with the
 * computer and hasn't downloaded yet won't.
 */
export function remove(id: unknown): Promise<void> {
  const [key] = entryFor(id);
  if (busy.get(key)?.action === 'install') return Promise.reject(new Error('Wait for it to finish installing'));
  choose(key, 'declined');
  const paths = installedPaths(key);
  if (paths.length === 0) {
    fs.rmSync(folderOf(key), { recursive: true, force: true });
    notify(true);
    return Promise.resolve();
  }
  return enqueue(key, 'remove', async () => {
    fs.rmSync(folderOf(key), { recursive: true, force: true });
    notify(true);
    await deleteUnused(paths).catch((error: unknown) => {
      // It's removed either way: what's left goes at the next collection.
      console.warn(`[features] couldn't delete ${key}'s parts:`, error);
    });
  });
}

/**
 * The first time Din starts with optional features, on a computer that ran a
 * DinOS from before them (a system generation without the manifest), where
 * they were all part of the system: install them all, so nothing it had
 * goes, from what's still in the store. The folder marks it done, so a
 * computer set up since, and one whose user removed them, is left alone.
 */
function migrate(): void {
  if (!DIR || fs.existsSync(DIR)) return;
  let before = false;
  try {
    const profiles = '/nix/var/nix/profiles';
    before = fs
      .readdirSync(profiles)
      .filter((name) => /^system-\d+-link$/.test(name))
      .some((name) => !fs.existsSync(path.join(profiles, name, 'etc/dinos/features.json')));
  } catch {
    // No system profile: not DinOS as installed.
  }
  fs.mkdirSync(DIR, { recursive: true });
  if (before) {
    installAll().catch((error: unknown) => console.warn("[features] couldn't keep the features DinOS had:", error));
  }
}

/**
 * The first time Din starts knowing which features come with the computer:
 * on one that was already set up (its features folder is there), a default
 * feature that isn't installed may have been removed before removing was
 * remembered, so it stays removed. A new computer, or one just erased, has
 * no folder yet and gets them. A live stick records nothing, so the
 * computer it's installed onto decides for itself.
 */
function settleChoices(): void {
  if (!CHOICES || !DIR || LIVE || fs.existsSync(CHOICES)) return;
  const choices: Record<string, Choice> = {};
  if (fs.existsSync(DIR)) {
    for (const [id, entry] of Object.entries(readManifest())) {
      if (entry.default && installedPaths(id).length === 0) choices[id] = 'declined';
    }
  }
  writeChoices(choices);
}

/**
 * Bring every wanted feature to this system's version: ones that come with
 * the computer and haven't downloaded, installs a restart cut short, and
 * installed ones from before a system update. Not from a live stick, and not
 * while offline; a failure waits for the next try.
 */
function fetchWanted(): void {
  if (LIVE || !net.isOnline()) return;
  for (const f of state().features) {
    if (f.wanted && !f.current && !f.busy) {
      fetchFeature(f.id).catch((error: unknown) => console.warn(`[features] couldn't install ${f.id}:`, error));
    }
  }
}

export function registerFeaturesHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;

  ipcMain.handle('features:state', (event) => {
    assertShellSender(event);
    return state();
  });
  ipcMain.handle('features:install', async (event, id: unknown) => {
    assertShellSender(event);
    await install(id);
  });
  ipcMain.handle('features:installAll', async (event) => {
    assertShellSender(event);
    await installAll();
  });
  ipcMain.handle('features:remove', async (event, id: unknown) => {
    assertShellSender(event);
    await remove(id);
  });

  if (DIR && Object.keys(readManifest()).length > 0) {
    setTimeout(() => {
      // Before migrate, which makes the folder settleChoices goes by.
      settleChoices();
      if (!LIVE) migrate();
      fetchWanted();
      setInterval(fetchWanted, RETRY_MS).unref();
    }, 30_000).unref();
  }
}
