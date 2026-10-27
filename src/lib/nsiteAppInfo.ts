/**
 * How an nsite presents itself as an app — its name, icon, and color — read
 * from the site's own files. Ported from Tenna's `useNsiteApp`.
 *
 * Everything comes out of one pass over `/index.html` and the web app manifest
 * it links, preferring the declarations meant for a home screen over the ones
 * meant for a browser tab. The files are read from Din's nsite store, so they
 * are hash-verified against the signed manifest, and the HTML is parsed inert
 * (DOMParser never runs scripts or loads subresources).
 */

import { normalizeThemeColor } from '@/lib/themeColor';
import type { NsiteAppInfo, NsiteStore, NsiteSummary } from '@/lib/nsiteStore';

/**
 * Where an icon came from, ranked. An apple-touch-icon is drawn to be a home
 * screen icon, a web app manifest icon is the same thing by another name, and
 * a favicon is a glyph meant to be read at 16px in a tab. Higher wins.
 */
const RANK = { appleTouch: 300, manifest: 200, favicon: 100 } as const;

interface IconCandidate {
  /** URL as the site wrote it — absolute, root-relative or relative. */
  href: string;
  /** Path the href is relative to. */
  base: string;
  score: number;
}

/** Largest edge named in a `sizes` attribute; vector art sorts above any raster. */
function parseSizes(sizes: string | null | undefined, href: string): number {
  if (/\.svg($|[?#])/i.test(href) || sizes?.trim().toLowerCase() === 'any') return 1024;
  if (!sizes) return 0;
  let best = 0;
  for (const token of sizes.trim().split(/\s+/)) {
    const [w, h] = token.toLowerCase().split('x').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) best = Math.max(best, w, h);
  }
  return best;
}

/** Rank within a class by declared size, without ever outranking the class above. */
function score(rank: number, size: number): number {
  return rank + Math.min(size, 1024) / 1025;
}

/**
 * The color a site names for its own chrome. Of a light and a dark variant,
 * the unconditional one wins, then the first.
 */
function pickThemeColor(doc: Document): string | null {
  const metas = [...doc.querySelectorAll('meta[name="theme-color"][content]')];
  const unconditional = metas.find((meta) => !meta.getAttribute('media')?.trim());
  return normalizeThemeColor((unconditional ?? metas[0])?.getAttribute('content'));
}

/** Resolve an href against a base path, keeping only the pathname. */
function toPathname(href: string, base: string): string | null {
  try {
    const url = new URL(href, `https://nsite.invalid${base}`);
    // Anything absolute that points elsewhere isn't one of the site's files.
    if (url.origin !== 'https://nsite.invalid') return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

/** Every icon the document declares. */
function collectFromDocument(doc: Document): IconCandidate[] {
  const candidates: IconCandidate[] = [];
  for (const link of doc.querySelectorAll('link[rel][href]')) {
    const href = link.getAttribute('href')?.trim();
    if (!href) continue;
    const rels = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const size = parseSizes(link.getAttribute('sizes'), href);
    if (rels.some((rel) => rel.startsWith('apple-touch-icon'))) {
      candidates.push({ href, base: '/', score: score(RANK.appleTouch, size) });
    } else if (rels.includes('icon')) {
      candidates.push({ href, base: '/', score: score(RANK.favicon, size) });
    }
  }
  return candidates;
}

/**
 * Icons named by a web app manifest, resolved relative to the manifest itself.
 * A `monochrome`-only icon is a stencil meant to be tinted, never artwork.
 */
function collectFromWebManifest(json: unknown, base: string): IconCandidate[] {
  if (typeof json !== 'object' || json === null) return [];
  const { icons } = json as { icons?: unknown };
  if (!Array.isArray(icons)) return [];

  const candidates: IconCandidate[] = [];
  for (const icon of icons) {
    if (typeof icon !== 'object' || icon === null) continue;
    const { src, sizes, purpose } = icon as Record<string, unknown>;
    if (typeof src !== 'string' || !src.trim()) continue;
    const purposes = typeof purpose === 'string' ? purpose.toLowerCase().split(/\s+/) : [];
    if (purposes.length > 0 && purposes.every((p) => p === 'monochrome')) continue;
    const size = parseSizes(typeof sizes === 'string' ? sizes : null, src);
    candidates.push({ href: src.trim(), base, score: score(RANK.manifest, size) });
  }
  return candidates;
}

/** Files at the conventional names, for sites that ship an icon without linking it. */
const CONVENTIONAL: Array<[path: string, score: number]> = [
  ['/apple-touch-icon.png', RANK.appleTouch],
  ['/icon.svg', RANK.favicon + 0.9],
  ['/icon.png', RANK.favicon + 0.8],
  ['/favicon.svg', RANK.favicon + 0.7],
  ['/favicon.png', RANK.favicon + 0.6],
  ['/favicon.ico', RANK.favicon + 0.5],
];

/** Favicon files at the conventional names, in order of preference. */
const CONVENTIONAL_FAVICONS = [
  '/favicon.svg',
  '/icon.svg',
  '/favicon.png',
  '/icon.png',
  '/favicon.ico',
];

/**
 * How well a favicon suits the title bar: vector art, then the smallest
 * raster at least FAVICON_SIZE, then the largest of the rest. One that names
 * no size is taken on trust over a smaller one.
 */
function faviconScore(href: string, sizes: string | null): number {
  const size = parseSizes(sizes, href);
  if (size >= 1024) return 3000;
  if (size >= FAVICON_SIZE) return 2000 - size;
  if (size === 0) return 1000;
  return size;
}

/**
 * The favicons a site has: what the document links as `rel=icon`, then the
 * conventional files. Apple touch icons and manifest icons are launcher art,
 * not favicons.
 */
function collectFavicons(doc: Document, paths: Record<string, string>): IconCandidate[] {
  const candidates: IconCandidate[] = [];
  for (const link of doc.querySelectorAll('link[rel][href]')) {
    const href = link.getAttribute('href')?.trim();
    if (!href) continue;
    const rels = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (!rels.includes('icon')) continue;
    candidates.push({ href, base: '/', score: faviconScore(href, link.getAttribute('sizes')) });
  }
  CONVENTIONAL_FAVICONS.forEach((path, i) => {
    if (paths[path]) candidates.push({ href: path, base: '/', score: faviconScore(path, null) - 1 - i });
  });
  return candidates.sort((a, b) => b.score - a.score);
}

/** Collapse whitespace and refuse anything too long to sit under an icon. */
function tidyLabel(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= limit ? text : null;
}

/**
 * What the site calls itself on a home screen, asked for in the order a phone
 * asks: `apple-mobile-web-app-title`, then the manifest's `short_name`, then
 * its `name`. The document title is deliberately not a fallback — it is
 * written for a tab strip, not a launcher; callers fall back to the nsite
 * manifest's own `title` tag instead.
 */
function pickLabel(doc: Document, webManifest: unknown): string | null {
  const manifest = (
    typeof webManifest === 'object' && webManifest !== null ? webManifest : {}
  ) as Record<string, unknown>;
  return (
    tidyLabel(
      doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content'),
      48,
    ) ??
    tidyLabel(manifest.short_name, 48) ??
    tidyLabel(manifest.name, 48)
  );
}

const MIME_BY_EXTENSION: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

/** Edge of the stored icon: a launcher tile's worth at 3x. */
const ICON_SIZE = 256;

/** Edge of the stored favicon: a 16px title-bar glyph at up to 4x. */
const FAVICON_SIZE = 64;

/**
 * Bumped whenever the derivation changes what it produces, so info stored by
 * an older Din is derived again (3: full-bleed icons are cut to a squircle;
 * 4: favicons are kept too).
 */
export const NSITE_APP_INFO_VERSION = 4;

/**
 * Margin left around a squircle-cut icon, so it sits at the same visual size
 * as Din's own icons, whose artwork stops just short of the edge.
 */
const SQUIRCLE_INSET = 10;

/** Superellipse exponent: 2 is a circle, higher is squarer. iOS-like at 5. */
const SQUIRCLE_EXPONENT = 5;

/** Trace a squircle filling the square at (x, y) with edge `size`. */
function traceSquircle(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const r = size / 2;
  const cx = x + r;
  const cy = y + r;
  const steps = 128;
  ctx.beginPath();
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const px = cx + r * Math.sign(cos) * Math.abs(cos) ** (2 / SQUIRCLE_EXPONENT);
    const py = cy + r * Math.sign(sin) * Math.abs(sin) ** (2 / SQUIRCLE_EXPONENT);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Whether artwork runs edge to edge: almost none of the pixels around its
 * border are transparent. That is a square picture drawn for a launcher to
 * cut into its own shape (an apple-touch-icon, a maskable manifest icon), and
 * left as it is it sits among Din's icons as a hard-cornered square. Artwork
 * with a transparent border has a shape of its own and keeps it.
 */
function isFullBleed(ctx: CanvasRenderingContext2D, size: number): boolean {
  const { data } = ctx.getImageData(0, 0, size, size);
  const edge = Math.max(1, Math.round(size / 64));
  let ring = 0;
  let clear = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x >= edge && y >= edge && x < size - edge && y < size - edge) continue;
      ring++;
      if (data[(y * size + x) * 4 + 3] < 128) clear++;
    }
  }
  return ring > 0 && clear / ring < 0.05;
}

/**
 * Rasterize icon bytes into a small data URL. SVG is drawn through an <img>,
 * which never runs its scripts, and the result is plain pixels either way.
 * A launcher icon's full-bleed artwork comes out cut to a squircle (see
 * isFullBleed); a favicon is kept as drawn.
 */
async function rasterize(
  bytes: Uint8Array,
  path: string,
  kind: 'icon' | 'favicon' = 'icon',
): Promise<string | null> {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const type = MIME_BY_EXTENSION[ext];
  if (!type) return null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const size = kind === 'favicon' ? FAVICON_SIZE : ICON_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size, size);
    if (kind === 'icon' && isFullBleed(ctx, ICON_SIZE)) {
      const inner = ICON_SIZE - SQUIRCLE_INSET * 2;
      ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
      ctx.save();
      traceSquircle(ctx, SQUIRCLE_INSET, SQUIRCLE_INSET, inner);
      ctx.clip();
      ctx.drawImage(img, SQUIRCLE_INSET, SQUIRCLE_INSET, inner, inner);
      ctx.restore();
    }
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A site's files, wherever they are read from: Din's nsite store for a site it
 * keeps, or Blossom for one the App Store is only showing. Either way every
 * read is checked against the hash in the signed manifest.
 */
export interface NsiteFileSource {
  /** Path -> sha256 of the manifest being read. */
  paths: Record<string, string>;
  read(path: string): Promise<Uint8Array | null>;
}

/** Read and parse a JSON file of the site, or null. */
async function readJson(files: NsiteFileSource, path: string): Promise<unknown> {
  const bytes = await files.read(path);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** How a site presents itself, plus the blurb the App Store shows for it. */
export interface NsiteAppDetails extends NsiteAppInfo {
  /** The site's own description of itself, from its page or manifest. */
  description: string | null;
  /** Whether it meets the browsers' bar for an installable web app (isInstallable). */
  installable: boolean;
}

const INSTALLABLE_DISPLAY = new Set(['fullscreen', 'standalone', 'minimal-ui', 'window-controls-overlay']);

/**
 * Whether a web app manifest meets Chrome's install criteria, the bar other
 * browsers hold web apps to as well: a name, a start URL, an app-like display
 * mode, no redirect to a native app, and icons at 192px and 512px. The icons
 * have to be files the site ships, and a scalable one covers both sizes.
 */
function isInstallable(json: unknown, base: string, paths: Record<string, string>): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const manifest = json as Record<string, unknown>;
  const named = [manifest.name, manifest.short_name].some(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  if (!named) return false;
  if (typeof manifest.start_url !== 'string') return false;
  if (typeof manifest.display !== 'string' || !INSTALLABLE_DISPLAY.has(manifest.display)) return false;
  if (manifest.prefer_related_applications === true) return false;
  if (!Array.isArray(manifest.icons)) return false;

  let has192 = false;
  let has512 = false;
  for (const icon of manifest.icons) {
    if (typeof icon !== 'object' || icon === null) continue;
    const { src, sizes, purpose } = icon as Record<string, unknown>;
    if (typeof src !== 'string' || !src.trim()) continue;
    // Chrome only counts icons meant to be shown as they are.
    const purposes = typeof purpose === 'string' ? purpose.toLowerCase().split(/\s+/) : ['any'];
    if (!purposes.includes('any')) continue;
    const path = toPathname(src.trim(), base);
    if (!path || !paths[path]) continue;
    const size = parseSizes(typeof sizes === 'string' ? sizes : null, src);
    if (size >= 192) has192 = true;
    if (size >= 512) has512 = true;
  }
  return has192 && has512;
}

/** What the site says it is, for a site whose manifest has no `description`. */
function pickDescription(doc: Document, webManifest: unknown): string | null {
  const manifest = (
    typeof webManifest === 'object' && webManifest !== null ? webManifest : {}
  ) as Record<string, unknown>;
  return (
    tidyLabel(doc.querySelector('meta[name="description"]')?.getAttribute('content'), 500) ??
    tidyLabel(
      doc.querySelector('meta[property="og:description"]')?.getAttribute('content'),
      500,
    ) ??
    tidyLabel(manifest.description, 500)
  );
}

/**
 * Derive how a site presents itself as an app from its files, as of the
 * manifest event `from`.
 */
export async function deriveNsiteAppDetails(
  files: NsiteFileSource,
  from: string,
): Promise<NsiteAppDetails> {
  const { paths } = files;
  const info: NsiteAppDetails = {
    from,
    version: NSITE_APP_INFO_VERSION,
    name: null,
    icon: null,
    favicon: null,
    themeColor: null,
    description: null,
    installable: false,
  };

  const index = paths['/index.html'] ? await files.read('/index.html') : null;
  const doc = new DOMParser().parseFromString(
    index ? new TextDecoder().decode(index) : '',
    'text/html',
  );

  const candidates = collectFromDocument(doc);
  info.themeColor = pickThemeColor(doc);
  let webManifest: unknown = null;

  const manifestHref = doc
    .querySelector('link[rel~="manifest"][href]')
    ?.getAttribute('href')
    ?.trim();
  const manifestPath = manifestHref ? toPathname(manifestHref, '/') : null;
  if (manifestPath && paths[manifestPath]) {
    webManifest = await readJson(files, manifestPath);
    const manifestBase = manifestPath.replace(/[^/]*$/, '');
    candidates.push(...collectFromWebManifest(webManifest, manifestBase));
    info.installable = isInstallable(webManifest, manifestBase, paths);
    // Only if the document named no color of its own.
    if (!info.themeColor && typeof webManifest === 'object' && webManifest !== null) {
      const { theme_color } = webManifest as { theme_color?: unknown };
      info.themeColor = normalizeThemeColor(typeof theme_color === 'string' ? theme_color : null);
    }
  }

  info.name = pickLabel(doc, webManifest);
  info.description = pickDescription(doc, webManifest);

  for (const [path, rank] of CONVENTIONAL) {
    if (paths[path]) candidates.push({ href: path, base: '/', score: rank });
  }
  candidates.sort((a, b) => b.score - a.score);

  // Only icons shipped with the site: a hotlinked one would be a request to a
  // third party on the site's behalf, made by the OS.
  const firstRasterized = async (
    list: IconCandidate[],
    kind: 'icon' | 'favicon',
  ): Promise<{ path: string; data: string } | null> => {
    for (const candidate of list) {
      const path = toPathname(candidate.href, candidate.base);
      if (!path || !paths[path]) continue;
      const bytes = await files.read(path);
      if (!bytes) continue;
      const data = await rasterize(bytes, path, kind);
      if (data) return { path, data };
    }
    return null;
  };

  const icon = await firstRasterized(candidates, 'icon');
  info.icon = icon?.data ?? null;
  // A favicon that is the icon's own file adds nothing the icon doesn't.
  const favicon = await firstRasterized(collectFavicons(doc, paths), 'favicon');
  info.favicon = favicon && favicon.path !== icon?.path ? favicon.data : null;

  return info;
}

/**
 * Derive how a stored site presents itself as an app, from the manifest
 * version in `summary`.
 */
export async function deriveNsiteAppInfo(
  store: NsiteStore,
  summary: NsiteSummary,
): Promise<NsiteAppInfo> {
  const { description: _description, installable: _installable, ...info } = await deriveNsiteAppDetails(
    { paths: summary.paths, read: (path) => store.read(summary.host, path) },
    summary.eventId,
  );
  return info;
}

/** Derivations in flight, by manifest event id. */
const deriving = new Map<string, Promise<NsiteAppInfo | null>>();

/**
 * The stored site's app info, deriving and storing it first when it's
 * missing, or was derived from an older manifest or by an older Din. Concurrent calls for the
 * same manifest share one derivation.
 */
export function ensureNsiteAppInfo(
  store: NsiteStore,
  summary: NsiteSummary,
): Promise<NsiteAppInfo | null> {
  const { app } = summary;
  if (app?.from === summary.eventId && app.version === NSITE_APP_INFO_VERSION) {
    return Promise.resolve(app);
  }
  let promise = deriving.get(summary.eventId);
  if (!promise) {
    promise = deriveNsiteAppInfo(store, summary)
      .then(async (info) => {
        await store.setAppInfo(summary.host, info);
        return info;
      })
      .catch(() => null)
      .finally(() => deriving.delete(summary.eventId));
    deriving.set(summary.eventId, promise);
  }
  return promise;
}
