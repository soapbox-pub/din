import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { APP_BLOSSOM_SERVERS, parseBlossomServerList } from '@/lib/appBlossom';
import { formatBytes } from '@/lib/fs';
import { getIconThemeBridge } from '@/lib/iconTheme';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { getSystemCursorBridge, type SystemCursorPreview } from '@/lib/systemCursor';

/**
 * Cursor and icon themes on Nostr (NIP.md): Din's own kinds, in a range of
 * its own, 346xx, DIN on a dialpad, the last two digits spelling the type
 * the same way.
 *
 * - **34628 (CU), a cursor theme:** an XCursor theme's cursors/ directory,
 *   one Blossom blob per cursor file (`cursor` tags) and its other names for
 *   them (`link` tags).
 * - **34642 (IC), an icon theme:** a freedesktop icon theme's directory as
 *   one gzipped tarball blob (`archive`), since a big set has tens of
 *   thousands of files, plus a few of its icons for showing it (`icon`).
 *
 * Both are addressable, `d` being the theme's directory name, so publishing
 * a theme again updates it. Publishing and installing are here, shared by
 * Settings, the App Store and the `din` command; the files are read and
 * written by the main process (electron/themePackages.mts).
 */

export const CURSOR_THEME_KIND = 34628;
export const ICON_THEME_KIND = 34642;

export type PackageType = 'cursor' | 'icon';

export const PACKAGE_KIND: Record<PackageType, number> = {
  cursor: CURSOR_THEME_KIND,
  icon: ICON_THEME_KIND,
};

const SHA256 = /^[0-9a-f]{64}$/;

interface PackageCommon {
  event: NostrEvent;
  pubkey: string;
  /** The `d` tag: the theme's directory name. */
  identifier: string;
  title: string;
  summary: string;
  inherits: string[];
  /** Blossom servers its files were uploaded to. */
  servers: string[];
  /** Bytes it takes to download. */
  size: number;
  createdAt: number;
}

export interface CursorPackage extends PackageCommon {
  type: 'cursor';
  cursors: { name: string; sha256: string; size: number }[];
  links: [string, string][];
  /** A picture of a few of its cursors. */
  image: string | null;
}

export interface IconPackage extends PackageCommon {
  type: 'icon';
  archive: { sha256: string; mime: string; size: number };
  /** A few of its icons, for showing it. */
  icons: { name: string; sha256: string; mime: string }[];
}

export type ThemePackage = CursorPackage | IconPackage;

export interface PackageAddress {
  type: PackageType;
  pubkey: string;
  identifier: string;
}

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

function size(value: string | undefined): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Parse a kind 34628 or 34642 event, or null when it lacks what installing needs. */
export function parseThemePackage(event: NostrEvent): ThemePackage | null {
  const identifier = tagValue(event, 'd');
  if (!identifier) return null;
  const common = {
    event,
    pubkey: event.pubkey,
    identifier,
    title: tagValue(event, 'title')?.trim() || identifier,
    summary: tagValue(event, 'summary')?.trim() ?? '',
    inherits: tagValues(event, 'inherits'),
    servers: httpsUrls(tagValues(event, 'server')),
    createdAt: event.created_at,
  };

  if (event.kind === CURSOR_THEME_KIND) {
    const cursors = event.tags
      .filter(([n, name, sha]) => n === 'cursor' && name && SHA256.test(sha ?? ''))
      .map(([, name, sha256, bytes]) => ({ name, sha256, size: size(bytes) }));
    if (!cursors.length) return null;
    const links = event.tags
      .filter(([n, alias, target]) => n === 'link' && alias && target)
      .map(([, alias, target]): [string, string] => [alias, target]);
    const image = tagValue(event, 'image');
    return {
      ...common,
      type: 'cursor',
      cursors,
      links,
      image: image ? sanitizeImageUrl(image) ?? null : null,
      size: cursors.reduce((sum, c) => sum + c.size, 0),
    };
  }

  if (event.kind === ICON_THEME_KIND) {
    const archive = event.tags.find(([n, sha]) => n === 'archive' && SHA256.test(sha ?? ''));
    if (!archive) return null;
    const icons = event.tags
      .filter(([n, name, sha, mime]) => n === 'icon' && name && SHA256.test(sha ?? '') && (mime === 'image/svg+xml' || mime === 'image/png'))
      .map(([, name, sha256, mime]) => ({ name, sha256, mime }));
    return {
      ...common,
      type: 'icon',
      archive: { sha256: archive[1], mime: archive[2] || 'application/gzip', size: size(archive[3]) },
      icons,
      size: size(archive[3]),
    };
  }

  return null;
}

export function packageTypeOf(kind: number): PackageType | null {
  return kind === CURSOR_THEME_KIND ? 'cursor' : kind === ICON_THEME_KIND ? 'icon' : null;
}

/** The `<kind>:<pubkey>:<d>` coordinate of a published theme. */
export function packageCoordinate(pkg: { type: PackageType; pubkey: string; identifier: string }): string {
  return `${PACKAGE_KIND[pkg.type]}:${pkg.pubkey}:${pkg.identifier}`;
}

/** A published theme's shareable address. */
export function packageNaddr(pkg: { type: PackageType; pubkey: string; identifier: string }): string {
  return nip19.naddrEncode({ kind: PACKAGE_KIND[pkg.type], pubkey: pkg.pubkey, identifier: pkg.identifier });
}

/** The published theme an `naddr1…` (or `nostr:naddr1…`) names, or null. */
export function parsePackageNaddr(text: string, type?: PackageType): PackageAddress | null {
  const value = text.trim().replace(/^nostr:/, '');
  if (!value.startsWith('naddr1')) return null;
  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== 'naddr') return null;
    const found = packageTypeOf(decoded.data.kind);
    if (!found || (type && found !== type)) return null;
    return { type: found, pubkey: decoded.data.pubkey, identifier: decoded.data.identifier };
  } catch {
    return null;
  }
}

/**
 * The newest version of each published theme, newest first, leaving out any
 * deleted (NIP-09) after it was published by its own author.
 */
export function buildPackageCatalog(events: NostrEvent[]): ThemePackage[] {
  const deleted = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 5) continue;
    for (const [name, value] of event.tags) {
      if (name !== 'a' || !value || value.split(':')[1] !== event.pubkey) continue;
      deleted.set(value, Math.max(deleted.get(value) ?? 0, event.created_at));
    }
  }
  const newest = new Map<string, ThemePackage>();
  for (const event of events) {
    const pkg = parseThemePackage(event);
    if (!pkg) continue;
    const key = packageCoordinate(pkg);
    const seen = newest.get(key);
    if (!seen || seen.createdAt < pkg.createdAt) newest.set(key, pkg);
  }
  return [...newest.values()]
    .filter((pkg) => (deleted.get(packageCoordinate(pkg)) ?? -1) < pkg.createdAt)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Kind 5 deletions of published themes of a type, by the given authors. */
export function packageDeletionsFilter(type: PackageType, authors: string[]): NostrFilter {
  return { kinds: [5], authors, '#k': [String(PACKAGE_KIND[type])] };
}

/** Where a blob of a published theme can be had, best first. */
export function blobUrl(pkg: ThemePackage, sha256: string): string | null {
  const server = pkg.servers[0];
  if (!server) return null;
  try {
    return new URL(sha256, server.endsWith('/') ? server : `${server}/`).toString();
  } catch {
    return null;
  }
}

/** A published icon theme's preview icons as URLs. */
export function iconPreviewUrls(pkg: IconPackage): { name: string; src: string }[] {
  return pkg.icons.flatMap((icon) => {
    const src = blobUrl(pkg, icon.sha256);
    return src ? [{ name: icon.name, src }] : [];
  });
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** What publishing needs from the signed-in account. */
export interface PublishDeps {
  /** Upload a file to the account's Blossom servers; resolves with NIP-94 tags. */
  upload(file: File): Promise<string[][]>;
  /** Sign and publish an event. */
  publish(template: { kind: number; content: string; tags: string[][] }): Promise<unknown>;
  /** The servers uploads go to. */
  servers: string[];
  progress?(text: string, percent?: number): void;
}

export interface PublishDetails {
  title: string;
  summary?: string;
}

function bytesOf(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer as ArrayBuffer;
}

async function uploadBlob(deps: PublishDeps, data: Uint8Array | Blob, name: string, type: string): Promise<{ sha256: string; url: string }> {
  const file = new File([data instanceof Blob ? data : bytesOf(data)], name, { type });
  const tags = await deps.upload(file);
  const sha256 = tags.find(([n]) => n === 'x')?.[1];
  const url = tags.find(([n]) => n === 'url')?.[1];
  if (!sha256 || !url) throw new Error(`The server didn’t say where ${name} went`);
  return { sha256, url };
}

/** A theme's arrow, hand, I-beam and resize cursors side by side, as a PNG. */
async function cursorStrip(previews: SystemCursorPreview[]): Promise<Blob | null> {
  if (!previews.length) return null;
  const cell = 64;
  const canvas = document.createElement('canvas');
  canvas.width = cell * previews.length;
  canvas.height = cell;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  for (const [i, preview] of previews.entries()) {
    const pixels = new Uint8ClampedArray(preview.width * preview.height * 4);
    pixels.set(preview.rgba);
    const bitmap = await createImageBitmap(new ImageData(pixels, preview.width, preview.height));
    const scale = Math.min(1, cell / Math.max(preview.width, preview.height));
    const w = preview.width * scale;
    const h = preview.height * scale;
    ctx.drawImage(bitmap, i * cell + (cell - w) / 2, (cell - h) / 2, w, h);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function commonTags(type: PackageType, id: string, details: PublishDetails, inherits: string[], servers: string[]): string[][] {
  const tags: string[][] = [['d', id], ['title', details.title]];
  if (details.summary) tags.push(['summary', details.summary]);
  tags.push(['alt', `${type === 'cursor' ? 'Cursor theme' : 'Icon theme'}: ${details.title}`]);
  for (const name of inherits) tags.push(['inherits', name]);
  for (const server of servers) tags.push(['server', server]);
  tags.push(['t', type === 'cursor' ? 'cursor-theme' : 'icon-theme']);
  return tags;
}

/** Publish an installed cursor theme as kind 34628; resolves with its `d` tag. */
export async function publishCursorTheme(id: string, details: PublishDetails, deps: PublishDeps): Promise<string> {
  const bridge = getSystemCursorBridge();
  if (!bridge) throw new Error('Cursor themes can only be published in the Din desktop app');
  deps.progress?.('Reading the cursors');
  const theme = await bridge.exportTheme(id);

  const cursorTags: string[][] = [];
  for (const [i, file] of theme.files.entries()) {
    deps.progress?.(`Uploading ${file.name}`, Math.round((i / (theme.files.length + 1)) * 100));
    const { sha256 } = await uploadBlob(deps, file.data, file.name, 'application/octet-stream');
    cursorTags.push(['cursor', file.name, sha256, String(file.data.length)]);
  }

  deps.progress?.('Uploading a picture of it', Math.round((theme.files.length / (theme.files.length + 1)) * 100));
  const strip = await cursorStrip(await bridge.preview(id, 48));
  const image = strip ? ((await uploadBlob(deps, strip, `${id}.png`, 'image/png').catch(() => null))?.url ?? null) : null;

  deps.progress?.('Publishing');
  const tags = commonTags('cursor', id, details, theme.inherits, deps.servers);
  tags.splice(tags.length - 1, 0, ...cursorTags, ...theme.links.map(([alias, target]) => ['link', alias, target]));
  if (image) tags.push(['image', image]);
  await deps.publish({ kind: CURSOR_THEME_KIND, content: '', tags });
  return id;
}

/** Publish an installed icon theme as kind 34642; resolves with its `d` tag. */
export async function publishIconTheme(id: string, details: PublishDetails, deps: PublishDeps): Promise<string> {
  const bridge = getIconThemeBridge();
  if (!bridge) throw new Error('Icon themes can only be published in the Din desktop app');
  deps.progress?.('Packing the icons');
  const theme = await bridge.exportTheme(id);

  const iconTags: string[][] = [];
  for (const [i, icon] of theme.previews.entries()) {
    deps.progress?.(`Uploading ${icon.name}`, Math.round((i / (theme.previews.length + 10)) * 100));
    // A server may refuse SVGs; the theme goes without that preview.
    const uploaded = await uploadBlob(deps, icon.data, icon.name, icon.mime).catch(() => null);
    if (uploaded) iconTags.push(['icon', icon.name, uploaded.sha256, icon.mime]);
  }

  deps.progress?.(`Uploading the icons (${formatBytes(theme.archive.length)})`, Math.round((theme.previews.length / (theme.previews.length + 10)) * 100));
  const { sha256 } = await uploadBlob(deps, theme.archive, `${id}.tar.gz`, 'application/gzip');

  deps.progress?.('Publishing');
  const tags = commonTags('icon', id, details, theme.inherits, deps.servers);
  tags.splice(tags.length - 1, 0, ['archive', sha256, 'application/gzip', String(theme.archive.length)], ...iconTags);
  await deps.publish({ kind: ICON_THEME_KIND, content: '', tags });
  return id;
}

/** The kind 5 deletion of one of the user's own published themes (NIP-09). */
export function packageDeletion(pkg: ThemePackage): { kind: number; content: string; tags: string[][] } {
  return {
    kind: 5,
    content: '',
    tags: [['e', pkg.event.id], ['a', packageCoordinate(pkg)], ['k', String(PACKAGE_KIND[pkg.type])]],
  };
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/** What installing needs: a way to ask relays. */
export interface InstallDeps {
  query(filters: NostrFilter[]): Promise<NostrEvent[]>;
  progress?(text: string): void;
}

/** Where a theme's files can be: its own servers, then its author's (BUD-03), then Din's. */
async function serversFor(pkg: ThemePackage, deps: InstallDeps): Promise<string[]> {
  let authors: string[] = [];
  try {
    const lists = await deps.query([{ kinds: [10063], authors: [pkg.pubkey], limit: 1 }]);
    const list = lists.filter((e) => e.pubkey === pkg.pubkey).sort((a, b) => b.created_at - a.created_at)[0];
    if (list) authors = parseBlossomServerList(list);
  } catch {
    // Its own servers, and Din's, are still tried.
  }
  return httpsUrls([...pkg.servers, ...authors, ...APP_BLOSSOM_SERVERS.servers]);
}

/**
 * Download and install a published theme; resolves with its directory name.
 * An icon theme's parents that aren't installed are installed too, when the
 * same author published them.
 */
export async function installThemePackage(pkg: ThemePackage, deps: InstallDeps, depth = 0): Promise<string> {
  const servers = await serversFor(pkg, deps);
  const base = {
    identifier: pkg.identifier,
    name: pkg.title,
    coordinate: packageCoordinate(pkg),
    publishedAt: pkg.createdAt,
    inherits: pkg.inherits,
    servers,
  };

  if (pkg.type === 'cursor') {
    const bridge = getSystemCursorBridge();
    if (!bridge) throw new Error('Cursor themes install in the Din desktop app');
    deps.progress?.(`Downloading ${pkg.title}`);
    return bridge.installPublished({
      ...base,
      cursors: pkg.cursors.map(({ name, sha256 }) => ({ name, sha256 })),
      links: pkg.links,
    });
  }

  const bridge = getIconThemeBridge();
  if (!bridge) throw new Error('Icon themes install in the Din desktop app');
  deps.progress?.(`Downloading ${pkg.title}`);
  const { id, missing } = await bridge.installPublished({ ...base, archive: { sha256: pkg.archive.sha256 } });
  if (missing.length && depth < 3) {
    const events = await deps.query([
      { kinds: [ICON_THEME_KIND], authors: [pkg.pubkey], '#d': missing },
      packageDeletionsFilter('icon', [pkg.pubkey]),
    ]);
    const parents = buildPackageCatalog(events.filter((e) => e.pubkey === pkg.pubkey));
    for (const parent of parents) {
      if (parent.type === 'icon' && missing.includes(parent.identifier)) await installThemePackage(parent, deps, depth + 1);
    }
  }
  return id;
}

/** One published theme by its address, the newest version not deleted, or null. */
export async function fetchThemePackage(address: PackageAddress, query: InstallDeps['query']): Promise<ThemePackage | null> {
  const coordinate = packageCoordinate(address);
  const events = await query([
    { kinds: [PACKAGE_KIND[address.type]], authors: [address.pubkey], '#d': [address.identifier] },
    { ...packageDeletionsFilter(address.type, [address.pubkey]), '#a': [coordinate] },
  ]);
  return buildPackageCatalog(events.filter((e) => e.pubkey === address.pubkey))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Installed themes
// ---------------------------------------------------------------------------

/** Publish an installed theme of either type; resolves with its `d` tag. */
export function publishThemePackage(type: PackageType, id: string, details: PublishDetails, deps: PublishDeps): Promise<string> {
  return type === 'cursor' ? publishCursorTheme(id, details, deps) : publishIconTheme(id, details, deps);
}

/** Make an installed theme the pointer's (at `size`, else the current size) or the icons'. */
export async function applyTheme(type: PackageType, id: string, size?: number): Promise<void> {
  if (type === 'cursor') {
    const bridge = getSystemCursorBridge();
    if (!bridge) throw new Error('The cursor can’t be changed here');
    await bridge.set({ theme: id, size: size ?? (await bridge.status()).size });
    return;
  }
  const bridge = getIconThemeBridge();
  if (!bridge) throw new Error('The icons can’t be changed here');
  await bridge.set(id);
}

/** Delete a theme Din installed. */
export async function removeTheme(type: PackageType, id: string): Promise<void> {
  const bridge = type === 'cursor' ? getSystemCursorBridge() : getIconThemeBridge();
  if (!bridge) throw new Error('Themes can’t be removed here');
  await bridge.removeTheme(id);
}

/** The published themes of a type by `authors`, newest first, as the App Store lists them. */
export async function fetchPackageCatalog(type: PackageType, authors: string[], query: InstallDeps['query'], limit = 100): Promise<ThemePackage[]> {
  const allowed = new Set(authors);
  const events = await query([
    { kinds: [PACKAGE_KIND[type]], authors, limit },
    packageDeletionsFilter(type, authors),
  ]);
  return buildPackageCatalog(events.filter((e) => allowed.has(e.pubkey)));
}
