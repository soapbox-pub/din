import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { APP_KIND, ASSET_KIND, RELEASE_KIND } from '@/lib/extensionCatalog';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';

/**
 * Linux apps on Nostr, as NIP-82 software: an application (kind 32267)
 * naming this computer's platform (`f linux-x86_64`), whose newest release
 * (kind 30063, channel `main`) names a Flatpak bundle asset (kind 3063,
 * `m application/vnd.flatpak`) for that platform. Armada publishes its
 * desktop builds this way, and npkg republishes the same bundles as a
 * Flatpak remote; the App Store installs them through a remote of Din's own
 * (electron/nostr-flatpaks.mts), so they update like any other Flatpak.
 *
 * The author is the only trust boundary: a release counts only by the app's
 * own author, and an asset only when that release names it and the same key
 * signed it. The app's `d` is its Flatpak id (NIP-82 asks for reverse DNS),
 * which the main process checks the bundle against before installing it.
 */

export const FLATPAK_MIME = 'application/vnd.flatpak';

const SHA256 = /^[0-9a-f]{64}$/;
const DELETION_KIND = 5;
/** Filters per request: relays cap how many one REQ may hold. */
const FILTER_BATCH = 10;
/** Ids per asset filter: relays cap an `ids` list too (relay.dreamith.to at about 50). */
const ID_BATCH = 40;

/** A Linux app published on Nostr with a Flatpak for this computer. */
export interface FlatpakApp {
  event: NostrEvent;
  pubkey: string;
  /** The app's `d`: its Flatpak application id. */
  identifier: string;
  name: string;
  summary: string;
  description: string;
  icon: string | null;
  screenshots: string[];
  categories: string[];
  license: string;
  website: string | null;
  repository: string | null;
  release: { id: string; version: string; createdAt: number; notes: string };
  asset: { id: string; sha256: string; size: number; urls: string[]; filename: string };
}

export type FlatpakQuery = (filters: NostrFilter[], signal?: AbortSignal) => Promise<NostrEvent[]>;

// ---------------------------------------------------------------------------
// The bridge (window.dinos.flatpaks, electron/nostr-flatpaks.mts)
// ---------------------------------------------------------------------------

export interface InstalledFlatpak {
  appId: string;
  /** `32267:<pubkey>:<d>`. */
  coordinate: string;
  /** The installed release's `created_at`. */
  publishedAt: number;
  version: string;
  sha256: string;
}

export interface FlatpakProgress {
  appId: string;
  phase: 'download' | 'import' | 'install' | 'remove';
  percent?: number;
}

export interface FlatpakInstallRequest {
  appId: string;
  name: string;
  coordinate: string;
  publishedAt: number;
  version: string;
  asset: { sha256: string; size: number; urls: string[] };
}

export interface FlatpaksBridge {
  status(): Promise<{ available: boolean; platform: string | null }>;
  installed(): Promise<InstalledFlatpak[]>;
  install(request: FlatpakInstallRequest): Promise<InstalledFlatpak>;
  uninstall(appId: string): Promise<void>;
  onProgress(callback: (progress: FlatpakProgress) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    flatpaks?: FlatpaksBridge;
  }
}

/** The bridge, or undefined outside the Electron shell. */
export function getFlatpaksBridge(): FlatpaksBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.flatpaks;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(([n]) => n === name)?.[1];
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter(([n, v]) => n === name && v).map(([, v]) => v);
}

function httpsUrls(urls: string[]): string[] {
  return [...new Set(urls.filter((url) => {
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  }))];
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `32267:<pubkey>:<d>`. */
export function flatpakCoordinate(app: { pubkey: string; identifier: string }): string {
  return `${APP_KIND}:${app.pubkey}:${app.identifier}`;
}

/** The app's shareable address. */
export function flatpakNaddr(app: { pubkey: string; identifier: string }): string {
  return nip19.naddrEncode({ kind: APP_KIND, pubkey: app.pubkey, identifier: app.identifier });
}

/** The NIP-82 app an `naddr1…` (or `nostr:naddr1…`) names, or null. */
export function parseAppNaddr(text: string): { pubkey: string; identifier: string } | null {
  const value = text.trim().replace(/^nostr:/, '');
  if (!value.startsWith('naddr1')) return null;
  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== 'naddr' || decoded.data.kind !== APP_KIND) return null;
    return { pubkey: decoded.data.pubkey, identifier: decoded.data.identifier };
  } catch {
    return null;
  }
}

/** The newest app per address, without those their own author deleted after. */
function newestApps(events: NostrEvent[]): NostrEvent[] {
  const deleted = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== DELETION_KIND) continue;
    for (const [name, value] of event.tags) {
      if (name !== 'a' || !value || value.split(':')[1] !== event.pubkey) continue;
      deleted.set(value, Math.max(deleted.get(value) ?? 0, event.created_at));
    }
  }
  const newest = new Map<string, NostrEvent>();
  for (const event of events) {
    const d = tagValue(event, 'd');
    if (event.kind !== APP_KIND || !d) continue;
    const key = `${APP_KIND}:${event.pubkey}:${d}`;
    if ((deleted.get(key) ?? -1) >= event.created_at) continue;
    const seen = newest.get(key);
    if (!seen || seen.created_at < event.created_at) newest.set(key, event);
  }
  return [...newest.values()];
}

/**
 * The apps among `appEvents` whose newest `main` release has a Flatpak for
 * `platform`, with that release and asset: their releases in one round of
 * requests, then the assets those name in another.
 */
async function withFlatpaks(appEvents: NostrEvent[], platform: string, query: FlatpakQuery, signal?: AbortSignal): Promise<FlatpakApp[]> {
  const apps = appEvents.filter((app) => tagValues(app, 'f').includes(platform));
  if (!apps.length) return [];

  const releaseFilters = apps.map((app): NostrFilter => ({
    kinds: [RELEASE_KIND], authors: [app.pubkey], '#i': [tagValue(app, 'd') ?? ''], '#c': ['main'], limit: 1,
  }));
  const releases = (await Promise.all(chunks(releaseFilters, FILTER_BATCH).map((batch) => query(batch, signal)))).flat();
  const latest = new Map<string, NostrEvent>();
  for (const release of releases) {
    const app = tagValue(release, 'i');
    if (release.kind !== RELEASE_KIND || !app) continue;
    // Prereleases sit on `main` too where ngit defaults the channel; a version with a suffix is one.
    if ((tagValue(release, 'c') ?? 'main') !== 'main' || (tagValue(release, 'version') ?? '').includes('-')) continue;
    const key = `${release.pubkey}:${app}`;
    const seen = latest.get(key);
    if (!seen || seen.created_at < release.created_at) latest.set(key, release);
  }

  const wanted = [...latest.values()].flatMap((release) => tagValues(release, 'e').map((id) => ({ id, author: release.pubkey })));
  const byAuthor = new Map<string, string[]>();
  for (const { id, author } of wanted) byAuthor.set(author, [...(byAuthor.get(author) ?? []), id]);
  const assetFilters = [...byAuthor].flatMap(([author, ids]) =>
    chunks(ids, ID_BATCH).map((batch): NostrFilter => ({ kinds: [ASSET_KIND], authors: [author], ids: batch })));
  const assets = new Map<string, NostrEvent>();
  for (const batch of chunks(assetFilters, FILTER_BATCH)) {
    for (const asset of await query(batch, signal)) if (asset.kind === ASSET_KIND) assets.set(asset.id, asset);
  }

  return apps.flatMap((app) => {
    const identifier = tagValue(app, 'd');
    const release = identifier ? latest.get(`${app.pubkey}:${identifier}`) : undefined;
    if (!identifier || !release) return [];
    const asset = tagValues(release, 'e')
      .map((id) => assets.get(id))
      .find((a): a is NostrEvent => !!a
        && a.pubkey === app.pubkey
        && tagValue(a, 'm') === FLATPAK_MIME
        && tagValues(a, 'f').includes(platform)
        && SHA256.test(tagValue(a, 'x') ?? ''));
    if (!asset) return [];
    const sha256 = tagValue(asset, 'x') as string;
    const urls = httpsUrls(tagValues(asset, 'url'));
    if (!urls.length) return [];
    const size = Number(tagValue(asset, 'size'));
    const icon = tagValue(app, 'icon');
    const content = app.content.trim();
    return [{
      event: app,
      pubkey: app.pubkey,
      identifier,
      name: tagValue(app, 'name')?.trim() || identifier,
      summary: tagValue(app, 'summary')?.trim() || content.split('\n')[0] || '',
      description: content,
      icon: icon ? sanitizeImageUrl(icon) ?? null : null,
      screenshots: tagValues(app, 'image').flatMap((url) => sanitizeImageUrl(url) ?? []).slice(0, 8),
      categories: [...new Set(tagValues(app, 't').map((t) => t.trim().toLowerCase()).filter(Boolean))],
      license: tagValue(app, 'license') ?? '',
      website: httpsUrls(tagValues(app, 'url'))[0] ?? null,
      repository: tagValue(app, 'repository') ?? null,
      release: {
        id: release.id,
        version: tagValue(release, 'version')?.trim() || release.created_at.toString(),
        createdAt: release.created_at,
        notes: release.content.trim(),
      },
      asset: {
        id: asset.id,
        sha256,
        size: Number.isSafeInteger(size) && size > 0 ? size : 0,
        urls,
        filename: tagValue(asset, 'filename') ?? `${identifier}.flatpak`,
      },
    }];
  });
}

/** The Linux apps `authors` publish with a Flatpak for `platform`, the most recently released first. */
export async function fetchFlatpakCatalog(authors: string[], platform: string, query: FlatpakQuery, signal?: AbortSignal): Promise<FlatpakApp[]> {
  if (!authors.length) return [];
  const allowed = new Set(authors);
  const events = (await query([
    { kinds: [APP_KIND], authors, '#f': [platform] },
    { kinds: [DELETION_KIND], authors, '#k': [String(APP_KIND)] },
  ], signal)).filter((event) => allowed.has(event.pubkey));
  const apps = await withFlatpaks(newestApps(events), platform, query, signal);
  return apps.sort((a, b) => b.release.createdAt - a.release.createdAt);
}

/** One app by its address, if it has a Flatpak for `platform`. */
export async function fetchFlatpakApp(
  address: { pubkey: string; identifier: string },
  platform: string,
  query: FlatpakQuery,
  signal?: AbortSignal,
): Promise<FlatpakApp | null> {
  const events = (await query([
    { kinds: [APP_KIND], authors: [address.pubkey], '#d': [address.identifier] },
    { kinds: [DELETION_KIND], authors: [address.pubkey], '#a': [`${APP_KIND}:${address.pubkey}:${address.identifier}`] },
  ], signal)).filter((event) => event.pubkey === address.pubkey);
  const [app] = await withFlatpaks(newestApps(events), platform, query, signal);
  return app ?? null;
}

/** What the main process needs to install an app's release. */
export function installRequest(app: FlatpakApp): FlatpakInstallRequest {
  return {
    appId: app.identifier,
    name: app.name,
    coordinate: flatpakCoordinate(app),
    publishedAt: app.release.createdAt,
    version: app.release.version,
    asset: { sha256: app.asset.sha256, size: app.asset.size, urls: app.asset.urls },
  };
}

/** Whether an installed app is behind the release `app` is at. */
export function isOutdated(installed: InstalledFlatpak, app: FlatpakApp): boolean {
  return installed.sha256 !== app.asset.sha256 && installed.publishedAt < app.release.createdAt;
}

/** What a progress report says, for a button or the command line. */
export function progressLabel(progress: FlatpakProgress | undefined, updating = false): string {
  if (!progress) return updating ? 'Updating…' : 'Getting…';
  const pct = progress.percent === undefined ? '' : ` ${progress.percent}%`;
  switch (progress.phase) {
    case 'download':
      return `Downloading${pct}`;
    case 'import':
      return 'Checking…';
    case 'install':
      return `${updating ? 'Updating' : 'Installing'}${pct}`;
    case 'remove':
      return 'Removing…';
  }
}

/** Electron's IPC wrapper off an error, for the user. */
export function cleanFlatpakError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '');
}
