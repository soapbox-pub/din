/**
 * What App info says about an app (the window, src/components/desktop/apps/
 * AppInfoWindow.tsx, and `din apps info`): what kind of app it is, where it
 * comes from, what it asks for, and what it opens. Everything here is known
 * without asking main; what main keeps (a site's permissions, its scheduled
 * background work, a running app's windows) the window reads for itself.
 */
import type { InstalledAppsManager } from '@/contexts/InstalledAppsContext';
import { getBrowserBridge, type SiteInfo } from '@/lib/browser';
import { appNotificationsOff, setAppNotificationsOff } from '@/lib/notificationCenter';
import type { AppDefinition } from '@/lib/apps';
import { dinManifest, isFileAppId, manifestPermissions } from '@/lib/dinApps';
import { launchedApp } from '@/lib/launchedApps';
import type { NativeApp } from '@/lib/nativeApps';
import { nsiteAppId, nsiteAppUrl } from '@/lib/nsiteApps';
import type { DinManifest, Permission } from '@/sdk/din';

export type AppKind = 'builtin' | 'system' | 'web' | 'nsite' | 'linux' | 'windows' | 'folder' | 'command';

export const APP_KIND_LABELS: Record<AppKind, string> = {
  builtin: 'Built-in app',
  system: 'Part of Din',
  web: 'Website',
  nsite: 'nsite',
  linux: 'Linux app',
  windows: 'Windows program',
  folder: 'App from a folder',
  command: 'Run by the din command',
};

export interface AppFacts {
  id: string;
  name: string;
  kind: AppKind;
  /** What its manifest or desktop entry says it is. */
  description: string | null;
  /** Where it's from: its URL, folder or desktop entry. */
  address: string | null;
  /**
   * The origin its permissions, data and background work are filed under:
   * https://host, nsite://host, din://id or din+file://host. Null for native
   * apps and Din's own windows.
   */
  origin: string | null;
  /** An nsite's canonical host. */
  nsiteHost: string | null;
  /** When it was installed or added, in Unix ms. */
  installedAt: number | null;
  /** What its manifest asks for (built-in apps, folders, the din command). */
  permissions: Permission[];
  /** Folders its manifest reaches by path. */
  folders: string[];
  /** File extensions Files opens in it. */
  fileTypes: string[];
  /** Freedesktop categories, for a Linux app. */
  categories: string[];
  /** The `nostr:` links it opens: every kind (null), these kinds, or none (undefined). */
  nostrKinds: number[] | null | undefined;
  /** Whether Din's share sheet offers it. */
  takesShares: boolean;
  /** Its jump list. */
  shortcuts: string[];
  uninstallable: boolean;
}

function fromManifest(manifest: DinManifest) {
  return {
    description: manifest.description?.trim() || null,
    permissions: manifestPermissions(manifest),
    folders: manifest.din.folders ?? [],
    fileTypes: [
      ...new Set((manifest.file_handlers ?? []).flatMap((h) => Object.values(h.accept).flat())),
    ].sort(),
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The facts about an app. `native` is its record in the list of installed
 * Linux apps, when it's one (useNativeApps, or the bridge's list).
 */
export function appFacts(
  app: AppDefinition,
  apps: Pick<InstalledAppsManager, 'webApps' | 'nsiteApps' | 'fileApps' | 'canUninstall'>,
  native?: NativeApp,
): AppFacts {
  const base: AppFacts = {
    id: app.id,
    name: app.name,
    kind: 'system',
    description: null,
    address: null,
    origin: null,
    nsiteHost: null,
    installedAt: null,
    permissions: [],
    folders: [],
    fileTypes: [],
    categories: [],
    nostrKinds: app.nostr ? app.nostr.kinds : undefined,
    takesShares: Boolean(app.share),
    shortcuts: (app.actions ?? []).map((a) => a.label),
    uninstallable: apps.canUninstall(app.id),
  };

  if (app.native) {
    return {
      ...base,
      kind: app.feature === 'windows' ? 'windows' : 'linux',
      description: native?.comment ?? null,
      address: native?.desktopId ?? null,
      categories: native?.categories ?? [],
    };
  }

  const nsite = apps.nsiteApps.find((entry) => nsiteAppId(entry.host) === app.id);
  if (nsite) {
    return {
      ...base,
      kind: 'nsite',
      address: nsiteAppUrl(nsite.host),
      origin: `nsite://${nsite.host}`,
      nsiteHost: nsite.host,
      installedAt: nsite.installedAt * 1000,
    };
  }

  const web = apps.webApps.find((w) => w.id === app.id);
  if (web) {
    return { ...base, kind: 'web', address: web.url, origin: originOf(web.url) };
  }

  if (isFileAppId(app.id)) {
    const entry = apps.fileApps.find((e) => e.appId === app.id);
    return {
      ...base,
      kind: 'folder',
      address: entry?.path ?? null,
      origin: `din+file://${app.id.slice('file-'.length)}`,
      installedAt: entry ? entry.addedAt * 1000 : null,
      ...(entry ? fromManifest(entry.manifest) : {}),
    };
  }

  const launched = launchedApp(app.id);
  if (launched) {
    return { ...base, kind: 'command', address: launched.source, ...fromManifest(launched.manifest) };
  }

  const manifest = dinManifest(app.id);
  if (manifest) {
    return { ...base, kind: 'builtin', address: `din://${app.id}/`, origin: `din://${app.id}`, ...fromManifest(manifest) };
  }

  return base;
}

/** Its `nostr:` links in a few words, or null when it opens none. */
export function nostrLinksLabel(kinds: number[] | null | undefined): string | null {
  if (kinds === undefined) return null;
  if (kinds === null || kinds.length === 0) return 'Every kind';
  return `Kind${kinds.length === 1 ? '' : 's'} ${kinds.join(', ')}`;
}

/** Whether a website or nsite, whose notifications are its permission's to allow. */
export function notifiesBySite(facts: Pick<AppFacts, 'kind' | 'origin'>): boolean {
  return (facts.kind === 'web' || facts.kind === 'nsite') && facts.origin !== null;
}

/**
 * Whether an app's notifications are on: a website's or nsite's permission
 * (`ask` until it's answered), anything else's switch in the notification
 * center. `site` is the site's answers, for a website or nsite.
 */
export function appNotificationsState(facts: Pick<AppFacts, 'id' | 'kind' | 'origin'>, site: SiteInfo | null): 'on' | 'off' | 'ask' {
  if (notifiesBySite(facts)) {
    const answer = site?.permissions.notifications;
    return answer === undefined ? 'ask' : answer ? 'on' : 'off';
  }
  return appNotificationsOff(facts.id) ? 'off' : 'on';
}

/**
 * Turn an app's notifications on or off, as App Info's switch does: a
 * website or nsite is allowed or blocked (blocking an nsite also ends the
 * Nostr subscriptions it keeps while closed), anything else is heard or not.
 */
export async function setAppNotifications(facts: Pick<AppFacts, 'id' | 'kind' | 'origin'>, on: boolean): Promise<void> {
  if (notifiesBySite(facts)) {
    const browser = getBrowserBridge();
    if (!browser) throw new Error('A website’s notifications are kept by Din’s desktop app');
    await browser.setSitePermission(facts.origin!, 'notifications', on, false);
    return;
  }
  setAppNotificationsOff(facts.id, !on);
}
