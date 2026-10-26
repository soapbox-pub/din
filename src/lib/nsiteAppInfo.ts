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

/**
 * Rasterize icon bytes into a small data URL. SVG is drawn through an <img>,
 * which never runs its scripts, and the result is plain pixels either way.
 */
async function rasterize(bytes: Uint8Array, path: string): Promise<string | null> {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const type = MIME_BY_EXTENSION[ext];
  if (!type) return null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Read and parse a JSON file of the site, or null. */
async function readJson(store: NsiteStore, host: string, path: string): Promise<unknown> {
  const bytes = await store.read(host, path);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Derive how a stored site presents itself as an app, from the manifest
 * version in `summary`.
 */
export async function deriveNsiteAppInfo(
  store: NsiteStore,
  summary: NsiteSummary,
): Promise<NsiteAppInfo> {
  const { host, paths } = summary;
  const info: NsiteAppInfo = { from: summary.eventId, name: null, icon: null, themeColor: null };

  const index = paths['/index.html'] ? await store.read(host, '/index.html') : null;
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
    webManifest = await readJson(store, host, manifestPath);
    candidates.push(...collectFromWebManifest(webManifest, manifestPath.replace(/[^/]*$/, '')));
    // Only if the document named no color of its own.
    if (!info.themeColor && typeof webManifest === 'object' && webManifest !== null) {
      const { theme_color } = webManifest as { theme_color?: unknown };
      info.themeColor = normalizeThemeColor(typeof theme_color === 'string' ? theme_color : null);
    }
  }

  info.name = pickLabel(doc, webManifest);

  for (const [path, rank] of CONVENTIONAL) {
    if (paths[path]) candidates.push({ href: path, base: '/', score: rank });
  }
  candidates.sort((a, b) => b.score - a.score);

  // Only icons shipped with the site: a hotlinked one would be a request to a
  // third party on the site's behalf, made by the OS.
  for (const candidate of candidates) {
    const path = toPathname(candidate.href, candidate.base);
    if (!path || !paths[path]) continue;
    const bytes = await store.read(host, path);
    if (!bytes) continue;
    const icon = await rasterize(bytes, path);
    if (icon) {
      info.icon = icon;
      break;
    }
  }

  return info;
}

/** Derivations in flight, by manifest event id. */
const deriving = new Map<string, Promise<NsiteAppInfo | null>>();

/**
 * The stored site's app info, deriving and storing it first when it's
 * missing or was derived from an older manifest. Concurrent calls for the
 * same manifest share one derivation.
 */
export function ensureNsiteAppInfo(
  store: NsiteStore,
  summary: NsiteSummary,
): Promise<NsiteAppInfo | null> {
  if (summary.app?.from === summary.eventId) return Promise.resolve(summary.app);
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
