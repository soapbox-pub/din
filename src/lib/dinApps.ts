/**
 * The desktop's side of built-in apps at din://<id>/ (docs/din/README.md):
 * their manifests, and the ports main hands the desktop as their windows
 * connect. DinAppFrame does the hosting.
 */
import type { DinManifest, Permission, Size } from '@/sdk/din';
import { guestsAvailable } from '@/platform/guest';
import type { Push } from '@/sdk/protocol';
import { encodeLaunchParams } from '@/shared/launch';

/** The session partition apps run in (DIN_APPS_PARTITION in electron/din-apps.mts). */
export const DIN_APPS_PARTITION = 'persist:din-apps';

/** Permissions whose bridges get a port of their own to main (SYSTEM_PERMISSIONS in electron/din-apps.mts). */
export const SYSTEM_PERMISSIONS = ['fs', 'pty', 'assistant', 'indd', 'volumes', 'mail', 'phone', 'passwords', 'vms', 'capture', 'quickshare'] as const;
export type SystemPermission = (typeof SYSTEM_PERMISSIONS)[number];

/** What the desktop's preload exposes for hosting apps (electron/preload.cjs). */
export interface AppsBridge {
  /**
   * For fs, resolves with the URL base the app loads files by path from.
   * `roots` scopes an fs grant to those folders.
   */
  grant(webContentsId: number, permission: SystemPermission, roots?: { path: string; writable: boolean }[]): Promise<string | null>;
  /**
   * `background`: the window may give its app a schedule
   * (registration.periodicSync), and, with `notifications`, the app's worker
   * may notify (electron/din-app-workers.mts).
   */
  grantBackground(webContentsId: number, options: { notifications: boolean }): Promise<void>;
  /** An app's worker opened (`url`) or focused (`focus`) a window, after a click on one of its notifications. */
  onWorkerOpen(callback: (request: { appId: string; url: string | null; focus: boolean }) => void): () => void;
  /** Another folder an app's scoped fs grant reaches. */
  addFsRoot(webContentsId: number, root: string, writable: boolean): Promise<void>;
  /** Whether an app's fs grant reaches each path (to write it, with `write`), as main checks its calls. */
  reaches(webContentsId: number, paths: string[], write: boolean): Promise<boolean[]>;
  /**
   * Each path as it resolves now (its links followed), whether it's Din's
   * own (no app may reach it), and whether it's a folder holding home or
   * Din's own files.
   */
  resolve(paths: string[]): Promise<{ real: string; protected: boolean; holds: boolean }[]>;
  /** Milliseconds since the user last pressed a key or clicked in an app window, or null if never. */
  sinceInput(webContentsId: number): Promise<number | null>;
  revoke(webContentsId: number, permission: SystemPermission): Promise<void>;
  fileUrl(webContentsId: number, path: string): Promise<string>;
  kill(webContentsId: number): Promise<void>;
  onResponsive(callback: (e: { webContentsId: number; responsive: boolean }) => void): () => void;
  /** Open a folder as an app (src/lib/fileApps.ts); resolves with its id and its manifest as found, untrusted. */
  folder(path: string): Promise<{ appId: string; path: string; manifest: unknown }>;
  /** Stop serving and watching a folder's app. */
  closeFolder(appId: string): Promise<void>;
  /** Hear when a file in a folder opened as an app changes. */
  onFolderChanged(callback: (e: { appId: string }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    apps?: AppsBridge;
  }
}

export function getAppsBridge(): AppsBridge | undefined {
  return window.dinos?.apps;
}

// ---------------------------------------------------------------------------
// Manifests: src/apps/<id>/manifest.webmanifest, bundled into the desktop.
// ---------------------------------------------------------------------------

const RAW = import.meta.glob<string>('/src/apps/*/manifest.webmanifest', {
  eager: true,
  query: '?raw',
  import: 'default',
});

const MANIFESTS = new Map<string, DinManifest>();
for (const [file, text] of Object.entries(RAW)) {
  const id = /\/src\/apps\/([^/]+)\/manifest\.webmanifest$/.exec(file)?.[1];
  if (!id) continue;
  try {
    MANIFESTS.set(id, JSON.parse(text) as DinManifest);
  } catch (error) {
    console.error(`din: ${id}'s manifest isn't valid JSON:`, error);
  }
}

/** Every built-in app's manifest, by id. */
export function dinManifests(): ReadonlyMap<string, DinManifest> {
  return MANIFESTS;
}

export function dinManifest(id: string): DinManifest | undefined {
  return MANIFESTS.get(id);
}

/** The icon Din shows for an app: its largest square icon (a root path, served on both origins). */
export function manifestIcon(manifest: DinManifest): string {
  const square = manifest.icons
    .filter((i) => !i.sizes || i.sizes.split(' ').some((s) => /^(\d+)x\1$/.test(s)))
    .sort((a, b) => size(b.sizes) - size(a.sizes));
  return (square[0] ?? manifest.icons[0])?.src ?? '';
}

function size(sizes: string | undefined): number {
  return Math.max(0, ...(sizes ?? '').split(' ').map((s) => Number.parseInt(s, 10) || 0));
}

export function manifestPermissions(manifest: DinManifest): Permission[] {
  return [...new Set(manifest.din.permissions ?? [])];
}

export function manifestSize(manifest: DinManifest): Size | undefined {
  return manifest.din.window?.size;
}

/** Whether an id is an app's from a folder, at din+file://<host>/ (`file-<host>`; src/lib/fileApps.ts). */
export function isFileAppId(id: string): boolean {
  return /^file-[a-z2-7]{52}$/.test(id);
}

/** The app a `din://<id>/` (or `din+file://<host>/`) URL launches, or null for any other URL. */
export function linkedAppId(url: unknown): string | null {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  if (u.protocol === 'din:') return u.hostname;
  if (u.protocol === 'din+file:') return `file-${u.hostname}`;
  return null;
}

/**
 * A launch's `targetURL`: the app's own URL (`din://<id>/`, wherever the
 * page is served from), at the shortcut's `url` when a shortcut launched it
 * (else the start URL), with the launch parameters in its query.
 */
export function launchUrl(id: string, manifest: DinManifest, shortcut: string | null, params: Record<string, unknown>): string {
  const base = isFileAppId(id) ? `din+file://${id.slice('file-'.length)}/` : `din://${id}/`;
  const path = (shortcut ? manifest.shortcuts?.find((s) => s.din?.id === shortcut)?.url : undefined) ?? manifest.start_url ?? '/';
  const own = new URL(base);
  let url: URL;
  try {
    url = new URL(path, own);
    if (url.protocol !== own.protocol || url.host !== own.host) url = own;
  } catch {
    url = own;
  }
  encodeLaunchParams(url, params);
  return url.href;
}

/** The URL an app's window loads. */
export function appUrl(id: string, manifest: DinManifest): string {
  const start = manifest.start_url && manifest.start_url.startsWith('/') ? manifest.start_url : '/';
  if (isFileAppId(id)) return `din+file://${id.slice('file-'.length)}${start}`;
  if (guestsAvailable()) return `din://${id}${start}`;
  // Outside Electron the app is a page of the dev server (or the static
  // build), framed. In development it gets an origin of its own; a static
  // web deploy has only one origin to give.
  const page = start === '/' ? `/src/apps/${id}/index.html` : `/src/apps/${id}${start}`;
  if (location.hostname === 'localhost') return `${location.protocol}//${id}.localhost:${location.port}${page}`;
  return `${location.origin}${page}`;
}

// ---------------------------------------------------------------------------
// Ports, as main hands them over (dinos-apps:port in electron/preload.cjs).
// ---------------------------------------------------------------------------

export interface AppPort {
  webContentsId: number;
  appId: string;
  port: MessagePort;
}

const waiting = new Map<number, (port: AppPort) => void>();
const arrived = new Map<number, AppPort>();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const data = e.data as { type?: string; info?: { webContentsId?: unknown; appId?: unknown } } | null;
    if (data?.type !== 'dinos-apps:port') return;
    const port = e.ports[0];
    const { webContentsId, appId } = data.info ?? {};
    if (!port || typeof webContentsId !== 'number' || typeof appId !== 'string') return;
    const entry = { webContentsId, appId, port };
    const take = waiting.get(webContentsId);
    if (take) take(entry);
    else arrived.set(webContentsId, entry);
  });
}

/**
 * Hear each port an app window's guest connects with (once per load: a
 * reload connects again). Ports that came before the listener are handed
 * over at once.
 */
export function onAppPort(webContentsId: number, listener: (port: AppPort) => void): () => void {
  waiting.set(webContentsId, listener);
  const early = arrived.get(webContentsId);
  if (early) {
    arrived.delete(webContentsId);
    listener(early);
  }
  return () => {
    if (waiting.get(webContentsId) === listener) waiting.delete(webContentsId);
  };
}

// ---------------------------------------------------------------------------
// Settings apps kept on the desktop's origin before they moved out.
// ---------------------------------------------------------------------------

function matches(key: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p));
}

/** The desktop's localStorage entries an app's manifest claims, or null for none. */
export function storageToMigrate(manifest: DinManifest): Record<string, string> | null {
  const patterns = manifest.din.migrateStorage ?? [];
  if (patterns.length === 0) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && matches(key, patterns)) out[key] = localStorage.getItem(key) ?? '';
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The app has its copies: the desktop's go. */
export function forgetMigratedStorage(entries: Record<string, string>): void {
  for (const key of Object.keys(entries)) localStorage.removeItem(key);
}

// ---------------------------------------------------------------------------
// Handles apps keep across restarts, in their IndexedDB (src/sdk/standards.ts'
// installStoredHandles), as tokens for grants kept here.
// ---------------------------------------------------------------------------

const PERSIST_KEY = 'din:app-file-tokens';

export interface PersistedGrant {
  appId: string;
  path: string;
  kind: 'file' | 'directory';
  writable: boolean;
  /**
   * The app's IndexedDB has it. Tokens from before handles went there (the
   * old `din.files.persist`, recent lists moved out of the desktop) are put
   * in its `din-handles` database under their own name on its next launch.
   */
  stored?: boolean;
}

function persistedGrants(): Record<string, PersistedGrant> {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}');
    return typeof all === 'object' && all !== null ? (all as Record<string, PersistedGrant>) : {};
  } catch {
    return {};
  }
}

/** Keep a grant for an app under a token (a new one when none is given); null if the token is another app's. */
export function persistGrant(token: string | null, grant: PersistedGrant): string | null {
  const all = persistedGrants();
  const t = token ?? crypto.randomUUID();
  if (all[t] && all[t].appId !== grant.appId) return null;
  all[t] = grant;
  localStorage.setItem(PERSIST_KEY, JSON.stringify(all));
  return t;
}

/** An app's tokens its IndexedDB doesn't have yet, to put there. */
export function unstoredGrants(appId: string): (PersistedGrant & { token: string })[] {
  return Object.entries(persistedGrants())
    .filter(([, g]) => g.appId === appId && !g.stored)
    .map(([token, g]) => ({ ...g, token }));
}

/** The app's IndexedDB has these now. */
export function markGrantsStored(appId: string, tokens: string[]): void {
  const all = persistedGrants();
  for (const t of tokens) if (all[t]?.appId === appId) all[t].stored = true;
  localStorage.setItem(PERSIST_KEY, JSON.stringify(all));
}

/** The grant a token stands for, if it's this app's. */
export function persistedGrant(appId: string, token: string): PersistedGrant | null {
  const grant = persistedGrants()[token];
  return grant && grant.appId === appId ? grant : null;
}

/** A token whose file is gone. */
export function releaseGrant(appId: string, token: string): void {
  const all = persistedGrants();
  if (all[token]?.appId !== appId) return;
  delete all[token];
  localStorage.setItem(PERSIST_KEY, JSON.stringify(all));
}

/**
 * Recent-file lists an app kept here as `{ path, time }` (its manifest's
 * `migrateRecentFiles`), rewritten for the app's own storage: each entry
 * gets a persisted grant, so the app can reopen it without paths. Files
 * that are gone are dropped. Null when there's nothing to move.
 */
export async function recentFilesToMigrate(
  appId: string,
  manifest: DinManifest,
  exists: (path: string) => Promise<'file' | 'directory' | null>,
): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  for (const key of manifest.din.migrateRecentFiles ?? []) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    const entries = [];
    for (const item of list as { path?: unknown; time?: unknown }[]) {
      if (typeof item?.path !== 'string' || typeof item.time !== 'number') continue;
      const kind = await exists(item.path);
      if (!kind) continue;
      const token = persistGrant(null, { appId, path: item.path, kind, writable: true });
      const name = item.path.replace(/\/+$/, '').split('/').pop() || item.path;
      entries.push({ token, key: appKeyOf(appId, item.path), name, path: item.path, time: item.time });
    }
    out[key] = JSON.stringify(entries);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A stable, opaque key for a path, per app (a grant's key, which isSameEntry compares). */
export function appKeyOf(appId: string, path: string): string {
  let h = 5381;
  for (const c of `${appId}\u0000${path}`) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36) + path.length.toString(36);
}

// ---------------------------------------------------------------------------
// The open app windows, so one can reach another of the same app.
// ---------------------------------------------------------------------------

export interface AppWindowEntry {
  appId: string;
  /** Send the window's document a push. */
  push: (message: Push) => void;
  /** Where the window's page is in the desktop's viewport. */
  guestRect: () => DOMRect | undefined;
}

export const appWindows = new Map<string, AppWindowEntry>();

/** The window whose frame is frontmost at a point of the desktop's viewport. */
export function windowIdAt(x: number, y: number): string | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const id = el.closest('[data-window-id]')?.getAttribute('data-window-id');
    if (id) return id;
  }
  return null;
}

/** The app window another one's tab is dragged over, which hears where (din.window.onTabHover). */
let hovered: string | null = null;

export function hoverTab(windowId: string | null, at: { x: number; y: number } | null): void {
  if (hovered && hovered !== windowId) appWindows.get(hovered)?.push({ type: 'tabHover', at: null });
  hovered = windowId;
  if (windowId && at) appWindows.get(windowId)?.push({ type: 'tabHover', at });
}
