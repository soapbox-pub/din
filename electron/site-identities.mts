// What websites the user allowed to notify call themselves, and their icons,
// so their notifications (and Settings → Notifications) say "YouTube" with
// YouTube's icon instead of "www.youtube.com" under the Web Browser's globe.
// An installed web app or nsite already has a name and icon of its own; this
// is for a site that's only ever been a tab.
//
//   userData/site-identities.json   { [origin]: { name, icon, checkedAt } }
//
// It's read from the site itself, in the persistent browser session, as a
// browser installing it would: its front page's <link rel=manifest>, then the
// manifest's short_name or name and its best icon, which is kept as a small
// data URL so it draws offline and never asks the site again to be shown.
// A site is looked up when it's allowed to notify, again every week or so
// while it keeps notifying, and forgotten when it's blocked or forgotten.
// Private windows' and Tor's sites are never looked up or kept.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fetchIcon } from './notifications.mts';

export interface SiteIdentity {
  /** What the site calls itself on a home screen, or null to go by its host. */
  name: string | null;
  /** A small raster (or SVG) data URL, or null. */
  icon: string | null;
  /** Unix ms of the last look. */
  checkedAt: number;
}

/** A site that answered is looked at again after a week; one that didn't, after a day. */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
/** Read until </head>, but no further than this (YouTube's head alone is 800KB of inline script). */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 48;
/** The icon is drawn at 14 to 32px; the smallest at least this big is fetched. */
const ICON_WANTED = 96;

let browserSession: (() => Electron.Session) | null = null;
let changed: () => void = () => {};
let cache: Map<string, SiteIdentity> | null = null;
const inFlight = new Map<string, Promise<SiteIdentity | null>>();

/** Hook up the session sites are looked up in, and who hears when one changes. */
export function configureSiteIdentities(options: { session: () => Electron.Session; onChange: () => void }): void {
  browserSession = options.session;
  changed = options.onChange;
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'site-identities.json');
}

function identities(): Map<string, SiteIdentity> {
  if (cache) return cache;
  cache = new Map();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [origin, raw] of Object.entries(parsed)) {
        if (!lookable(origin) || !raw || typeof raw !== 'object') continue;
        const { name, icon, checkedAt } = raw as Record<string, unknown>;
        cache.set(origin, {
          name: typeof name === 'string' ? name : null,
          icon: typeof icon === 'string' && icon.startsWith('data:image/') ? icon : null,
          checkedAt: typeof checkedAt === 'number' ? checkedAt : 0,
        });
      }
    }
  } catch {
    // No file yet (or corrupt): nothing looked up.
  }
  return cache;
}

function save(): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(Object.fromEntries(identities())));
  } catch {
    // Non-fatal: it's looked up again after a restart.
  }
}

/** Only websites: an nsite's name and icon come from its own files (nsiteAppInfo). */
function lookable(origin: string): boolean {
  return /^https?:\/\/[^/]+$/.test(origin);
}

function stale(identity: SiteIdentity): boolean {
  const age = Date.now() - identity.checkedAt;
  return age > (identity.name || identity.icon ? REFRESH_AFTER_MS : RETRY_AFTER_MS);
}

/** What's kept for a site, without looking it up. */
export function cachedSiteIdentity(origin: string): SiteIdentity | null {
  return lookable(origin) ? identities().get(origin) ?? null : null;
}

/**
 * A site's name and icon: what's kept, looked at again in the background if
 * it's old, or looked up now (at most `waitMs`) if nothing is kept yet.
 */
export async function siteIdentity(origin: string, waitMs = 6_000): Promise<SiteIdentity | null> {
  if (!lookable(origin)) return null;
  const kept = identities().get(origin);
  if (kept) {
    if (stale(kept)) void refreshSiteIdentity(origin);
    return kept;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([refreshSiteIdentity(origin), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Look a site up now (once at a time), keeping what it says. */
export function refreshSiteIdentity(origin: string): Promise<SiteIdentity | null> {
  if (!lookable(origin) || !browserSession) return Promise.resolve(null);
  let pending = inFlight.get(origin);
  if (!pending) {
    const s = browserSession();
    pending = lookUp(s, origin)
      .catch(() => ({ name: null, icon: null }))
      .then((found) => {
        inFlight.delete(origin);
        const previous = identities().get(origin);
        // A site that can't be reached now keeps what it said before.
        if (!found.name && !found.icon && previous && (previous.name || previous.icon)) {
          previous.checkedAt = Date.now() - REFRESH_AFTER_MS + RETRY_AFTER_MS;
          save();
          return previous;
        }
        const identity: SiteIdentity = { ...found, checkedAt: Date.now() };
        identities().set(origin, identity);
        save();
        if (previous?.name !== identity.name || previous?.icon !== identity.icon) changed();
        return identity;
      });
    inFlight.set(origin, pending);
  }
  return pending;
}

/** Forget a site (it was blocked, or forgotten). */
export function forgetSiteIdentity(origin: string): void {
  if (!identities().delete(origin)) return;
  save();
  changed();
}

/** Look a site up only if nothing is kept for it (sites allowed before this cache existed). */
export function ensureSiteIdentity(origin: string): void {
  if (lookable(origin) && !identities().has(origin)) void refreshSiteIdentity(origin);
}

// ---------------------------------------------------------------------------
// Reading the site
// ---------------------------------------------------------------------------

interface IconCandidate {
  url: string;
  score: number;
}

async function lookUp(s: Electron.Session, origin: string): Promise<{ name: string | null; icon: string | null }> {
  const page = await fetchText(s, `${origin}/`, MAX_PAGE_BYTES, 'text/html,application/xhtml+xml', /<\/head\s*>|<body[\s>]/i);
  if (!page) return { name: null, icon: await fetchIcon(s, `${origin}/favicon.ico`) };
  const head = parseHead(page.text);
  const base = page.url;

  let manifest: Record<string, unknown> = {};
  let manifestBase = base;
  const manifestHref = resolve(head.manifest, base);
  if (manifestHref) {
    const fetched = await fetchText(s, manifestHref, MAX_MANIFEST_BYTES, 'application/manifest+json,application/json');
    if (fetched) {
      try {
        const parsed: unknown = JSON.parse(fetched.text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          manifest = parsed as Record<string, unknown>;
          manifestBase = fetched.url;
        }
      } catch {
        // Not JSON: go by the page alone.
      }
    }
  }

  const name =
    tidy(head.meta['apple-mobile-web-app-title']) ??
    tidy(manifest.short_name) ??
    tidy(manifest.name) ??
    tidy(head.meta['application-name']) ??
    tidy(head.meta['og:site_name']);

  const candidates = [...manifestIcons(manifest.icons, manifestBase), ...head.icons.flatMap((link) => {
    const url = resolve(link.href, base);
    return url ? [{ url, score: link.score }] : [];
  })].sort((a, b) => b.score - a.score);
  candidates.push({ url: `${origin}/favicon.ico`, score: -Infinity });

  let icon: string | null = null;
  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (tried.has(candidate.url) || tried.size >= 3) continue;
    tried.add(candidate.url);
    icon = await fetchIcon(s, candidate.url);
    if (icon) break;
  }
  return { name, icon };
}

/** A text resource, read no further than `max` bytes, or than where `stopAt` matches. */
async function fetchText(
  s: Electron.Session,
  url: string,
  max: number,
  accept: string,
  stopAt?: RegExp,
): Promise<{ text: string; url: string } | null> {
  if (!/^https?:/i.test(url)) return null;
  try {
    const response = await s.fetch(url, {
      credentials: 'include',
      headers: { accept },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      const from = Math.max(0, text.length - 8);
      text += decoder.decode(value, { stream: true });
      if (stopAt && stopAt.test(text.slice(from))) break;
    }
    void reader.cancel().catch(() => {});
    return { text, url: response.url || url };
  } catch {
    return null;
  }
}

/** The <link> and <meta> tags a page's head names itself with. */
function parseHead(html: string): {
  manifest: string | null;
  icons: { href: string; score: number }[];
  meta: Record<string, string>;
} {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = end > 0 ? html.slice(0, end) : html;
  let manifest: string | null = null;
  const icons: { href: string; score: number }[] = [];
  const meta: Record<string, string> = {};
  for (const [, tag, attrText] of head.matchAll(/<(link|meta)\b([^>]*)>/gi)) {
    const attrs = attributes(attrText);
    if (tag.toLowerCase() === 'meta') {
      const key = (attrs.name ?? attrs.property ?? '').toLowerCase();
      if (key && attrs.content !== undefined && !(key in meta)) meta[key] = attrs.content;
      continue;
    }
    const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    const href = attrs.href?.trim();
    if (!href) continue;
    if (rels.includes('manifest')) manifest ??= href;
    else if (rels.includes('apple-touch-icon') || rels.includes('apple-touch-icon-precomposed')) {
      icons.push({ href, score: sizeScore(attrs.sizes ?? '180x180', attrs.type ?? href) });
    } else if (rels.includes('icon')) {
      icons.push({ href, score: sizeScore(attrs.sizes ?? '', attrs.type ?? href) - 0.5 });
    }
  }
  return { manifest, icons, meta };
}

function attributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, name, , dq, sq, bare] of text.matchAll(/([^\s=/>]+)\s*(=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[name.toLowerCase()] = decodeEntities(dq ?? sq ?? bare ?? '');
  }
  return attrs;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, code: string) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&amp;/g, '&');
}

/** A manifest's icons, as candidates; a maskable-only one is padded for a mask, so it loses to a plain one. */
function manifestIcons(icons: unknown, base: string): IconCandidate[] {
  if (!Array.isArray(icons)) return [];
  const candidates: IconCandidate[] = [];
  for (const icon of icons.slice(0, 64)) {
    if (!icon || typeof icon !== 'object') continue;
    const { src, sizes, type, purpose } = icon as Record<string, unknown>;
    const url = typeof src === 'string' ? resolve(src, base) : null;
    if (!url) continue;
    const purposes = typeof purpose === 'string' ? purpose.toLowerCase().split(/\s+/) : ['any'];
    if (!purposes.includes('any') && !purposes.includes('maskable')) continue;
    const score = sizeScore(typeof sizes === 'string' ? sizes : '', typeof type === 'string' ? type : src as string);
    candidates.push({ url, score: score + 1 - (purposes.includes('any') ? 0 : 2) });
  }
  return candidates;
}

/**
 * How well an icon's size suits: SVG best, then the smallest at least
 * ICON_WANTED, then the largest below it; an unsized one comes last.
 */
function sizeScore(sizes: string, typeOrHref: string): number {
  if (/svg/i.test(typeOrHref) || /\bany\b/i.test(sizes)) return 100;
  const largest = Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/gi)].map((m) => Math.min(Number(m[1]), Number(m[2]))));
  if (!largest) return 0;
  return largest >= ICON_WANTED ? 50 - Math.log2(largest / ICON_WANTED) : 10 + largest / ICON_WANTED;
}

function resolve(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return /^(https?|data):$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function tidy(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= MAX_NAME_LENGTH ? text : null;
}
