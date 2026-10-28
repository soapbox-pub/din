/**
 * The desktop's side of built-in apps at din://<id>/ (docs/din/README.md):
 * their manifests, and the ports main hands the desktop as their windows
 * connect. DinAppFrame does the hosting.
 */
import type { DinManifest, Permission, Size } from '@/sdk/din';
import { guestsAvailable } from '@/platform/guest';

/** The session partition apps run in (DIN_APPS_PARTITION in electron/din-apps.mts). */
export const DIN_APPS_PARTITION = 'persist:din-apps';

/** What the desktop's preload exposes for hosting apps (electron/preload.cjs). */
export interface AppsBridge {
  grant(webContentsId: number, permission: 'fs' | 'pty'): Promise<void>;
  revoke(webContentsId: number, permission: 'fs' | 'pty'): Promise<void>;
  kill(webContentsId: number): Promise<void>;
  onResponsive(callback: (e: { webContentsId: number; responsive: boolean }) => void): () => void;
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

/** The URL an app's window loads. */
export function appUrl(id: string, manifest: DinManifest): string {
  const start = manifest.start_url && manifest.start_url.startsWith('/') ? manifest.start_url : '/';
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
