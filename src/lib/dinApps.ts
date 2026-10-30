/**
 * The desktop's side of built-in apps at din://<id>/ (docs/din/README.md):
 * their manifests, and the ports main hands the desktop as their windows
 * connect. DinAppFrame does the hosting.
 */
import type { DinManifest, Permission, Size } from '@/sdk/din';
import { guestsAvailable } from '@/platform/guest';
import type { Push } from '@/sdk/protocol';

/** The session partition apps run in (DIN_APPS_PARTITION in electron/din-apps.mts). */
export const DIN_APPS_PARTITION = 'persist:din-apps';

/** Permissions whose bridges get a port of their own to main (SYSTEM_PERMISSIONS in electron/din-apps.mts). */
export const SYSTEM_PERMISSIONS = ['fs', 'pty', 'assistant', 'indd', 'volumes', 'mail', 'passwords'] as const;
export type SystemPermission = (typeof SYSTEM_PERMISSIONS)[number];

/** What the desktop's preload exposes for hosting apps (electron/preload.cjs). */
export interface AppsBridge {
  /**
   * For fs, resolves with the URL base the app loads files by path from.
   * `roots` scopes an fs grant to those folders.
   */
  grant(webContentsId: number, permission: SystemPermission, roots?: { path: string; writable: boolean }[]): Promise<string | null>;
  /** Another folder an app's scoped fs grant reaches. */
  addFsRoot(webContentsId: number, root: string, writable: boolean): Promise<void>;
  /** Whether an app's fs grant reaches each path (to write it, with `write`), as main checks its calls. */
  reaches(webContentsId: number, paths: string[], write: boolean): Promise<boolean[]>;
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
  const list = new Set(manifest.din.permissions ?? []);
  if (list.has('nostr')) list.add('account');
  return [...list];
}

export function manifestSize(manifest: DinManifest): Size | undefined {
  return manifest.din.window?.size;
}

/** Whether an id is an app's from a folder, at din+file://<host>/ (`file-<host>`; src/lib/fileApps.ts). */
export function isFileAppId(id: string): boolean {
  return /^file-[a-z2-7]{52}$/.test(id);
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
// Handles apps keep across restarts (handle.persist(), din.files.restore()).
// ---------------------------------------------------------------------------

const PERSIST_KEY = 'din:app-file-tokens';

export interface PersistedGrant {
  appId: string;
  path: string;
  kind: 'file' | 'directory';
  writable: boolean;
}

function persistedGrants(): Record<string, PersistedGrant> {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}');
    return typeof all === 'object' && all !== null ? (all as Record<string, PersistedGrant>) : {};
  } catch {
    return {};
  }
}

/** Keep a grant for an app; resolves to the token it gets back with. */
export function persistGrant(grant: PersistedGrant): string {
  const token = crypto.randomUUID();
  const all = persistedGrants();
  all[token] = grant;
  localStorage.setItem(PERSIST_KEY, JSON.stringify(all));
  return token;
}

/** The grant a token stands for, if it's this app's. */
export function persistedGrant(appId: string, token: string): PersistedGrant | null {
  const grant = persistedGrants()[token];
  return grant && grant.appId === appId ? grant : null;
}

/** An app let go of a token. */
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
      const token = persistGrant({ appId, path: item.path, kind, writable: true });
      const name = item.path.replace(/\/+$/, '').split('/').pop() || item.path;
      entries.push({ token, key: appKeyOf(appId, item.path), name, path: item.path, time: item.time });
    }
    out[key] = JSON.stringify(entries);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A stable, opaque key for a path, per app (DinFileHandle.key). */
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
  title: () => string;
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

/** An app's open windows, front to back. */
export function appWindowIds(appId: string): string[] {
  const z = (id: string) => Number(document.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(id)}"]`)?.style.zIndex || 0);
  return [...appWindows].filter(([, w]) => w.appId === appId).map(([id]) => id).sort((a, b) => z(b) - z(a));
}

// ---------------------------------------------------------------------------
// din.app.session: state the desktop keeps for an app while it runs.
// ---------------------------------------------------------------------------

const appSessions = new Map<string, Map<string, unknown>>();

export function appSessionState(appId: string): Map<string, unknown> {
  let state = appSessions.get(appId);
  if (!state) appSessions.set(appId, (state = new Map()));
  return state;
}

/** The app window another one's tab is dragged over, which hears where (din.window.onTabHover). */
let hovered: string | null = null;

export function hoverTab(windowId: string | null, at: { x: number; y: number } | null): void {
  if (hovered && hovered !== windowId) appWindows.get(hovered)?.push({ type: 'tabHover', at: null });
  hovered = windowId;
  if (windowId && at) appWindows.get(windowId)?.push({ type: 'tabHover', at });
}
