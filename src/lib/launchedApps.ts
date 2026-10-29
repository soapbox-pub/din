/**
 * Apps the `din` command runs from a folder or a dev server
 * (electron/din-launch.mts): served at din://<origin>/ like a built-in app,
 * but with a manifest Din has never seen. The desktop keeps only the parts
 * of it that can't reach past the app (no storage migration, no files
 * copied), and asks before granting its permissions (LaunchedAppFrame).
 * They're in the app registry while they have windows (LaunchHost).
 */
import { createElement, lazy } from 'react';
import type { ComponentType } from 'react';
import type { AppComponentProps, AppDefinition } from '@/lib/apps';
import { WEB_APP_ICON } from '@/lib/appIcons';
import { normalizeThemeColor } from '@/lib/themeColor';
import type { DinManifest, FrameMode, Permission } from '@/sdk/din';

const LaunchedAppFrame = lazy(() =>
  import('@/components/desktop/LaunchedAppFrame').then((m) => ({ default: m.LaunchedAppFrame })),
);

/** A launch as main hands it over (LaunchRequest in electron/din-launch.mts). */
export interface LaunchRequest {
  launchId: string;
  appId: string;
  manifest: unknown;
  source: string;
  ephemeral: boolean;
  paths: string[];
}

/** What the desktop's preload exposes for launches (electron/preload.cjs). */
export interface LaunchBridge {
  onOpen(callback: (request: unknown) => void): () => void;
  onClose(callback: (launchId: string) => void): () => void;
  opened(launchId: string, error: string | null): Promise<void>;
  ended(launchId: string): Promise<void>;
  release(appId: string): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    launch?: LaunchBridge;
  }
}

export function getLaunchBridge(): LaunchBridge | undefined {
  return window.dinos?.launch;
}

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A launch request, checked, or null. */
export function parseLaunchRequest(raw: unknown): LaunchRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.launchId !== 'string' || typeof r.appId !== 'string' || !APP_ID.test(r.appId)) return null;
  return {
    launchId: r.launchId,
    appId: r.appId,
    manifest: r.manifest,
    source: typeof r.source === 'string' ? r.source : '',
    ephemeral: r.ephemeral !== false,
    paths: Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === 'string' && p.startsWith('/')) : [],
  };
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

/** Every permission there is, with what granting it means, for the prompt. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  account: 'See your public key, relays and media servers',
  nostr: 'Sign, encrypt and decrypt as you (Din asks each time)',
  fs: 'Read, change and delete any of your files',
  pty: 'Run commands in terminals',
  printing: 'Print',
  notifications: 'Keep notifications and a Dock badge',
  'media-session': 'Hear the media keys',
  wallpaper: 'Change the desktop wallpaper',
  assistant: 'Use the Assistant',
  indd: 'Convert InDesign documents',
  volumes: 'Mount and eject disks',
  'file-folders': 'Reach the folders of files you give it',
};

const FRAMES: readonly FrameMode[] = ['standard', 'custom', 'none'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function strings(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 200)).slice(0, max) : [];
}

/**
 * The parts of a launched app's manifest Din honors: what it looks like and
 * what it asks for. The migration members, file and protocol handlers, and
 * anything naming another app are dropped. Icons arrive inlined as data URLs.
 */
export function sanitizeManifest(raw: unknown, fallbackName: string): DinManifest {
  const m = isObject(raw) ? raw : {};
  const din = isObject(m.din) ? m.din : {};
  const win = isObject(din.window) ? din.window : {};
  const size = isObject(win.size) ? win.size : {};
  const dimension = (v: unknown, min: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(Math.max(v, min), 4096)) : null);
  const width = dimension(size.width, 200);
  const height = dimension(size.height, 120);
  const known = Object.keys(PERMISSION_LABELS) as Permission[];
  const icon = Array.isArray(m.icons)
    ? m.icons.find((i): i is { src: string } => isObject(i) && typeof i.src === 'string' && /^data:image\/[a-z0-9.+-]+[;,]/i.test(i.src))
    : undefined;
  const start = text(m.start_url, 2000);
  const name = text(m.name) ?? fallbackName;
  return {
    name,
    short_name: text(m.short_name),
    description: text(m.description, 1000),
    icons: icon ? [{ src: icon.src }] : [],
    start_url: start?.startsWith('/') && !start.startsWith('//') ? start : '/',
    theme_color: normalizeThemeColor(typeof m.theme_color === 'string' ? m.theme_color : null) ?? undefined,
    background_color: normalizeThemeColor(typeof m.background_color === 'string' ? m.background_color : null) ?? undefined,
    launch_handler: isObject(m.launch_handler) && m.launch_handler.client_mode === 'focus-existing' ? { client_mode: 'focus-existing' } : undefined,
    shortcuts: Array.isArray(m.shortcuts)
      ? m.shortcuts.flatMap((s) => {
          if (!isObject(s) || !text(s.name)) return [];
          const sd = isObject(s.din) ? s.din : {};
          const id = text(sd.id);
          return [{
            name: text(s.name) ?? '',
            url: text(s.url, 2000) ?? '/',
            ...(id ? { din: { id, ...(isObject(sd.params) ? { params: sd.params } : {}) } } : {}),
          }];
        }).slice(0, 8)
      : undefined,
    din: {
      permissions: Array.isArray(din.permissions) ? [...new Set(din.permissions.filter((p): p is Permission => known.includes(p as Permission)))] : [],
      window: {
        ...(width && height ? { size: { width, height } } : {}),
        ...(win.floating === true ? { floating: true } : {}),
        ...(FRAMES.includes(win.frame as FrameMode) ? { frame: win.frame as FrameMode } : {}),
      },
      keywords: strings(din.keywords, 16),
      folders: strings(din.folders, 16).filter((f) => f.startsWith('/') || f.startsWith('~/')),
    },
  };
}

/** What a manifest asks for that the user should allow: its permissions and fixed folders. */
export function requestedAccess(manifest: DinManifest): { permissions: Permission[]; folders: string[] } {
  return { permissions: manifest.din.permissions ?? [], folders: manifest.din.folders ?? [] };
}

/** The manifest without what it asks for: a web page in a window. */
export function withoutAccess(manifest: DinManifest): DinManifest {
  return { ...manifest, din: { ...manifest.din, permissions: [], folders: [] } };
}

// ---------------------------------------------------------------------------
// Approvals: an app on a named origin is asked about once per source and request.
// ---------------------------------------------------------------------------

const APPROVALS_KEY = 'din:launched-app-approvals';

function approvalKey(manifest: DinManifest): string {
  const { permissions, folders } = requestedAccess(manifest);
  return JSON.stringify([[...permissions].sort(), [...folders].sort()]);
}

function readApprovals(): Record<string, { source: string; access: string }> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(APPROVALS_KEY) ?? '{}');
    return isObject(parsed) ? (parsed as Record<string, { source: string; access: string }>) : {};
  } catch {
    return {};
  }
}

export function isApproved(app: LaunchedApp): boolean {
  if (app.ephemeral) return false;
  const entry = readApprovals()[app.appId];
  return entry?.source === app.source && entry.access === approvalKey(app.manifest);
}

export function rememberApproval(app: LaunchedApp): void {
  if (app.ephemeral) return;
  const approvals = readApprovals();
  approvals[app.appId] = { source: app.source, access: approvalKey(app.manifest) };
  localStorage.setItem(APPROVALS_KEY, JSON.stringify(approvals));
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface LaunchedApp {
  appId: string;
  manifest: DinManifest;
  /** The folder or server it runs from. */
  source: string;
  ephemeral: boolean;
  definition: AppDefinition;
}

const apps = new Map<string, LaunchedApp>();
let snapshot: readonly LaunchedApp[] = [];
const listeners = new Set<() => void>();

function changed(): void {
  snapshot = [...apps.values()];
  for (const listener of listeners) listener();
}

export function subscribeLaunchedApps(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function launchedApps(): readonly LaunchedApp[] {
  return snapshot;
}

export function launchedApp(appId: string): LaunchedApp | undefined {
  return apps.get(appId);
}

/** Register a launched app (or refresh its manifest); its definition, for the window manager. */
export function addLaunchedApp(request: LaunchRequest): LaunchedApp {
  const fallback = request.source.replace(/\/+$/, '').split('/').pop() || request.appId;
  const manifest = sanitizeManifest(request.manifest, fallback);
  const existing = apps.get(request.appId);
  if (existing && JSON.stringify(existing.manifest) === JSON.stringify(manifest) && existing.source === request.source) return existing;
  const entry = { appId: request.appId, manifest, source: request.source, ephemeral: request.ephemeral } as LaunchedApp;
  const component: ComponentType<AppComponentProps> = function LaunchedApp(props: AppComponentProps) {
    return createElement(LaunchedAppFrame, { ...props, app: entry });
  };
  entry.definition = {
    id: request.appId,
    name: manifest.short_name ?? manifest.name,
    icon: manifest.icons[0]?.src ?? WEB_APP_ICON,
    component,
    defaultSize: manifest.din.window?.size,
    floating: manifest.din.window?.floating,
    keywords: manifest.din.keywords,
    singleInstance: manifest.launch_handler?.client_mode === 'focus-existing',
  };
  apps.set(request.appId, entry);
  changed();
  return entry;
}

export function removeLaunchedApp(appId: string): void {
  if (apps.delete(appId)) changed();
}
