// Periodic Background Sync (registration.periodicSync and the `periodicsync`
// event), one schedule for every kind of app Din runs: built-in apps and apps
// from folders (din-app-workers.mts), installed nsites (napp.mts) and
// installed web apps (web-push.mts). Each of those runtimes shims the API in
// its pages and workers, decides who may register, and raises the event in
// its own workers; this keeps the tags, decides when they're due, and is what
// Settings → Background Activity and `din background` see and change.
//
// The rules, as Tenna's NAPP.md has them (so a site written for Chrome or
// Tenna works unchanged):
//   - a new tag comes from the page, where the user is; a worker can only
//     register again (or drop) a tag its site already holds
//   - at most MAX_TAGS per site, run at most every MIN_INTERVAL_MS
//   - registering a tag again keeps its place in the schedule, and its first
//     run is one interval after it was registered
//   - nothing runs while the computer is offline; a run missed while asleep
//     or off happens once, soon after, never once per interval missed
// On top of that, the user can pause a site, or every site at once, and a
// site whose worker is gone (three runs in a row) loses its tags, as a
// registration's go with it in Chrome.
//
// Sites are keyed by origin: din://<id>, din+file://<host>, nsite://<host>,
// https://<host>. Each has one schedule, run in the worker registered for
// the scope it last registered from.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { app, ipcMain, net, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const MIN_INTERVAL_MS = 15 * 60_000;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 256;
const CHECK_MS = 60_000;
/** Runs in a row that found no worker before a site's tags are dropped. */
const MAX_MISSES = 3;

/** Which runtime a site's worker is woken by. */
export type SyncKind = 'app' | 'nsite' | 'web';

/** What became of a run (worker-events.mts's DispatchResult). */
export type SyncOutcome = 'handled' | 'failed' | 'no-worker';

export interface SyncRunner {
  /** Raise `periodicsync` with `tag` in the worker registered for `scope`. */
  dispatch: (origin: string, scope: string, tag: string) => Promise<SyncOutcome>;
  /** Whether the site may still be woken (it still holds its permission). */
  allowed: (origin: string) => boolean;
  /** Forget the user's answer for the site, so it asks again (Settings' Remove). */
  forgetPermission?: (origin: string) => void;
}

/** An error the calling page or worker sees as a particular kind (a DOMException name, or TypeError). */
export class PeriodicSyncError extends Error {
  readonly kind: string;
  constructor(message: string, kind: string) {
    super(message);
    this.kind = kind;
  }
}

interface StoredTag {
  minInterval: number;
  nextRun: number;
  lastRun: number | null;
  outcome: SyncOutcome | null;
  /** How long the last run took. */
  ms: number | null;
}

interface StoredSite {
  scope: string;
  tags: Record<string, StoredTag>;
  paused: boolean;
  /** Runs in a row that found no worker. */
  misses: number;
  /** For an app (din://): whether its worker may show notifications, as the desktop granted it. */
  notifications?: boolean;
}

interface Stored {
  /** The global switch: off, nothing runs. */
  enabled: boolean;
  sites: Record<string, StoredSite>;
}

/** A site's schedule as Settings and `din background` see it. */
export interface BackgroundSite {
  origin: string;
  kind: SyncKind;
  paused: boolean;
  /** Whether it may still be woken; false once its permission was taken back. */
  allowed: boolean;
  tags: { tag: string; minInterval: number; nextRun: number; lastRun: number | null; outcome: SyncOutcome | null; ms: number | null }[];
}

let stored: Stored | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let changedTimer: NodeJS.Timeout | null = null;
let sendToShell: (channel: string, payload?: unknown) => void = () => {};
const runners = new Map<SyncKind, SyncRunner>();
/** Tags running now, `origin\0tag`, so a slow run isn't started twice. */
const running = new Set<string>();

function log(line: string): void {
  console.log(`[periodic-sync] ${line}`);
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'periodic-sync.json');
}

function state(): Stored {
  if (stored) return stored;
  stored = { enabled: true, sites: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<Stored>;
    if (typeof parsed.enabled === 'boolean') stored.enabled = parsed.enabled;
    if (parsed.sites && typeof parsed.sites === 'object') {
      for (const [origin, site] of Object.entries(parsed.sites)) {
        if (kindOf(origin) && site && typeof site === 'object' && typeof site.scope === 'string' && site.tags) {
          stored.sites[origin] = { ...site, paused: site.paused === true, misses: site.misses ?? 0 };
        }
      }
    }
  } catch {
    // Nothing stored yet (or unreadable): no site has asked.
  }
  return stored;
}

function save(): void {
  changed();
  if (saveTimer) return;
  saveTimer = setTimeout(writeState, 1_000);
}

function writeState(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const file = statePath();
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(stored));
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // Non-fatal: it's written again on the next change.
  }
}

function changed(): void {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    sendToShell('periodic-sync:changed');
  }, 250);
}

/** The runtime an origin belongs to, or null for one none of them serves. */
export function kindOf(origin: string): SyncKind | null {
  const scheme = /^([a-z+]+):\/\/[^/]+$/.exec(origin)?.[1];
  if (scheme === 'din' || scheme === 'din+file') return 'app';
  if (scheme === 'nsite') return 'nsite';
  if (scheme === 'https' || scheme === 'http') return 'web';
  return null;
}

export function registerSyncRunner(kind: SyncKind, runner: SyncRunner): void {
  runners.set(kind, runner);
}

// ---------------------------------------------------------------------------
// What the runtimes call for their sites
// ---------------------------------------------------------------------------

/**
 * registration.periodicSync.register(), once the runtime has checked the
 * caller may: `fromWorker` only re-registers a tag the site holds.
 */
export function registerTag(
  origin: string,
  scope: string,
  tag: unknown,
  minInterval: unknown,
  fromWorker: boolean,
  extra: { notifications?: boolean } = {},
): void {
  if (typeof tag !== 'string' || !tag || tag.length > MAX_TAG_LENGTH) throw new PeriodicSyncError('Invalid tag', 'TypeError');
  if (!kindOf(origin)) throw new PeriodicSyncError('Not available here', 'NotAllowedError');
  const sites = state().sites;
  const existing = sites[origin]?.tags[tag];
  if (fromWorker && !existing) throw new PeriodicSyncError('Register new tags from the page', 'NotAllowedError');
  const site = (sites[origin] ??= { scope, tags: {}, paused: false, misses: 0 });
  if (!existing && Object.keys(site.tags).length >= MAX_TAGS) {
    throw new PeriodicSyncError(`At most ${MAX_TAGS} tags`, 'QuotaExceededError');
  }
  const interval = Math.max(MIN_INTERVAL_MS, typeof minInterval === 'number' && minInterval > 0 ? minInterval : 0);
  site.tags[tag] = existing
    ? { ...existing, minInterval: interval }
    : { minInterval: interval, nextRun: Date.now() + interval, lastRun: null, outcome: null, ms: null };
  if (!fromWorker) site.scope = scope;
  if (extra.notifications !== undefined) site.notifications = extra.notifications;
  if (!existing) log(`${origin}: registered ${tag} every ${Math.round(interval / 60_000)} min`);
  save();
}

export function unregisterTag(origin: string, tag: unknown): void {
  const site = state().sites[origin];
  if (!site || typeof tag !== 'string' || !site.tags[tag]) return;
  delete site.tags[tag];
  if (Object.keys(site.tags).length === 0) delete state().sites[origin];
  log(`${origin}: unregistered ${tag}`);
  save();
}

/** registration.periodicSync.getTags(). */
export function tagsOf(origin: string): string[] {
  return Object.keys(state().sites[origin]?.tags ?? {});
}

/** Whether an app (din://) holds tags and may show notifications from its worker. */
export function appMayNotify(origin: string): boolean {
  return state().sites[origin]?.notifications === true;
}

/** A site's tags go: uninstalled, its data cleared, its permission taken back. */
export function forgetSite(origin: string): void {
  if (!state().sites[origin]) return;
  delete state().sites[origin];
  log(`${origin}: forgotten`);
  save();
}

/** Every site of a kind loses its tags (all the browser's site data was cleared). */
export function forgetKind(kind: SyncKind): void {
  const sites = state().sites;
  const gone = Object.keys(sites).filter((origin) => kindOf(origin) === kind);
  for (const origin of gone) delete sites[origin];
  if (gone.length > 0) save();
}

/** Take over a site's tags from where a runtime used to keep them (napp.json's `sync`). */
export function adoptTags(origin: string, scope: string, tags: Record<string, { minInterval?: unknown; nextRun?: unknown }>): void {
  const site = (state().sites[origin] ??= { scope, tags: {}, paused: false, misses: 0 });
  for (const [tag, entry] of Object.entries(tags)) {
    if (site.tags[tag] || typeof entry?.minInterval !== 'number' || typeof entry.nextRun !== 'number') continue;
    site.tags[tag] = { minInterval: Math.max(MIN_INTERVAL_MS, entry.minInterval), nextRun: entry.nextRun, lastRun: null, outcome: null, ms: null };
  }
  if (Object.keys(site.tags).length === 0) delete state().sites[origin];
  save();
}

/** The user changed a site's answer: without background-sync, it has no schedule. */
export function periodicSyncPermissionChanged(origin: string, capability: string, allow: boolean | null): void {
  if (capability === 'background-sync' && allow !== true) forgetSite(origin);
}

/** A site's service worker registration is gone, and its schedule with it. */
export function registrationGone(origin: string, scope: string): void {
  if (state().sites[origin]?.scope === scope) forgetSite(origin);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function run(origin: string, tag: string): Promise<SyncOutcome | null> {
  const site = state().sites[origin];
  const entry = site?.tags[tag];
  const kind = kindOf(origin);
  const runner = kind ? runners.get(kind) : undefined;
  const key = `${origin}\0${tag}`;
  if (!site || !entry || !runner || running.has(key)) return null;
  running.add(key);
  const started = Date.now();
  // Before it runs: a run that hangs, or Din quitting mid-run, isn't run again at once.
  entry.nextRun = started + entry.minInterval;
  entry.lastRun = started;
  save();
  let outcome: SyncOutcome;
  try {
    outcome = await runner.dispatch(origin, site.scope, tag);
  } catch {
    outcome = 'failed';
  } finally {
    running.delete(key);
  }
  const now = state().sites[origin];
  if (now !== site || !site.tags[tag]) return outcome;
  site.tags[tag] = { ...site.tags[tag], outcome, ms: Date.now() - started };
  site.misses = outcome === 'no-worker' ? site.misses + 1 : 0;
  if (site.misses >= MAX_MISSES) {
    log(`${origin}: no service worker for ${MAX_MISSES} runs; its tags are dropped`);
    delete state().sites[origin];
  }
  save();
  return outcome;
}

function runDue(): void {
  const s = state();
  if (!s.enabled || !net.isOnline()) return;
  const now = Date.now();
  for (const [origin, site] of Object.entries(s.sites)) {
    if (site.paused) continue;
    const kind = kindOf(origin);
    const runner = kind ? runners.get(kind) : undefined;
    if (!runner?.allowed(origin)) continue;
    for (const [tag, entry] of Object.entries(site.tags)) {
      if (entry.nextRun <= now) void run(origin, tag);
    }
  }
}

// ---------------------------------------------------------------------------
// Settings → Background Activity, and `din background`
// ---------------------------------------------------------------------------

export function backgroundStatus(): { enabled: boolean; sites: BackgroundSite[] } {
  const s = state();
  return {
    enabled: s.enabled,
    sites: Object.entries(s.sites).map(([origin, site]) => {
      const kind = kindOf(origin)!;
      return {
        origin,
        kind,
        paused: site.paused,
        allowed: runners.get(kind)?.allowed(origin) ?? false,
        tags: Object.entries(site.tags).map(([tag, t]) => ({ tag, ...t })),
      };
    }),
  };
}

function originArg(origin: unknown): string {
  if (typeof origin !== 'string' || !state().sites[origin]) throw new Error('No such app has anything scheduled');
  return origin;
}

export function registerPeriodicSyncHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  sendToShell = options.sendToShell;
  state();
  setInterval(runDue, CHECK_MS);
  // What came due while the computer slept, once the network is back.
  powerMonitor.on('resume', () => setTimeout(runDue, 10_000));
  app.on('will-quit', () => {
    if (saveTimer) writeState();
  });

  ipcMain.handle('periodic-sync:status', (event) => {
    options.assertShellSender(event);
    return backgroundStatus();
  });
  ipcMain.handle('periodic-sync:setEnabled', (event, enabled) => {
    options.assertShellSender(event);
    state().enabled = enabled === true;
    log(state().enabled ? 'turned on' : 'turned off');
    save();
  });
  ipcMain.handle('periodic-sync:setPaused', (event, origin, paused) => {
    options.assertShellSender(event);
    state().sites[originArg(origin)].paused = paused === true;
    save();
  });
  // Run now: the user asked, so it runs even when paused or switched off.
  ipcMain.handle('periodic-sync:run', async (event, origin, tag) => {
    options.assertShellSender(event);
    const site = state().sites[originArg(origin)];
    const tags = typeof tag === 'string' ? [tag] : Object.keys(site.tags);
    if (tags.some((t) => !site.tags[t])) throw new Error(`No tag ${tag}`);
    const outcomes: Record<string, SyncOutcome | null> = {};
    for (const t of tags) outcomes[t] = await run(origin as string, t);
    return outcomes;
  });
  // An app was uninstalled: what it scheduled goes, if it scheduled anything.
  ipcMain.handle('periodic-sync:forget', (event, origin) => {
    options.assertShellSender(event);
    if (typeof origin === 'string') forgetSite(origin);
  });
  // Remove: its tags go, and a site that asked the user asks again.
  ipcMain.handle('periodic-sync:remove', (event, origin) => {
    options.assertShellSender(event);
    const key = originArg(origin);
    forgetSite(key);
    runners.get(kindOf(key)!)?.forgetPermission?.(key);
  });
}
