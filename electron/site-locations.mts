// Onion-Location and Nsite-Location (window.dinos.siteLocations - see preload.cjs
// and the Web Browser's address bar): an https site can name its onion
// service, and the nsite it's also published as, in a response header or a
// <meta http-equiv>, and the address bar offers to go there, as Tor Browser
// does for onions. The headers reach this module from whichever listener sees
// the session's responses (the ad blocker's extension in the persistent
// session, popups.mts's in the private ones); the meta tags are read from an
// isolated world once the page's DOM is ready.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain } from 'electron';
import * as nip19 from 'nostr-tools/nip19';
import { NSITE_NAMED_KIND, NSITE_ROOT_KIND, parseCanonicalHost } from './nsite-store.mts';
import { isOnionUrl } from './tor.mts';

/** Where else a page says it can be found. */
export interface SiteLocations {
  /** Its onion service (Onion-Location). */
  onion: string | null;
  /** Its nsite (Nsite-Location). */
  nsite: string | null;
}

type AssertSender = (event: Electron.IpcMainInvokeEvent) => void;

const NONE: SiteLocations = { onion: null, nsite: null };

let sendToShell: (channel: string, payload?: unknown) => void = () => {};

/** A v3 onion service's address, with any subdomains. */
const ONION_HOST = /(^|\.)[a-z2-7]{56}\.onion$/;

/**
 * Whether a page may name other places to find it, as Tor Browser takes
 * Onion-Location: only an https page that isn't on an onion service itself.
 */
function canNameLocations(pageUrl: string): boolean {
  try {
    return new URL(pageUrl).protocol === 'https:' && !isOnionUrl(pageUrl);
  } catch {
    return false;
  }
}

/** An http(s) address on an onion service, or null. */
function onionFor(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const target = new URL(value.trim());
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (target.username || target.password || !ONION_HOST.test(target.hostname.toLowerCase())) return null;
    return target.href;
  } catch {
    return null;
  }
}

/** Whether an nsite URL's host names a site: its canonical host, or an naddr of a site manifest. */
function isNsiteHost(host: string): boolean {
  if (parseCanonicalHost(host)) return true;
  if (!host.startsWith('naddr1')) return false;
  try {
    const decoded = nip19.decode(host);
    return decoded.type === 'naddr' && (decoded.data.kind === NSITE_ROOT_KIND || decoded.data.kind === NSITE_NAMED_KIND);
  } catch {
    return false;
  }
}

/** An nsite:// address of a site, or null. */
function nsiteFor(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const target = new URL(value.trim());
    if (target.protocol !== 'nsite:' || target.username || target.password) return null;
    return isNsiteHost(target.hostname) ? target.href : null;
  } catch {
    return null;
  }
}

function locationsFor(pageUrl: string, onion: unknown, nsite: unknown): SiteLocations {
  if (!canNameLocations(pageUrl)) return NONE;
  return { onion: onionFor(onion), nsite: nsiteFor(nsite) };
}

function isNone(locations: SiteLocations): boolean {
  return !locations.onion && !locations.nsite;
}

/** A URL as the response and the committed page both have it. */
function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

/** What recent top-level responses' headers named, by response URL. */
const headerLocations = new Map<string, { locations: SiteLocations; at: number }>();
const HEADER_TTL_MS = 60_000;
/** What each browser tab's page names, if anything. */
const tabLocations = new Map<number, SiteLocations>();
const tabs = new Set<Electron.WebContents>();

function setLocations(contents: Electron.WebContents, locations: SiteLocations): void {
  const current = tabLocations.get(contents.id) ?? NONE;
  if (current.onion === locations.onion && current.nsite === locations.nsite) return;
  if (isNone(locations)) tabLocations.delete(contents.id);
  else tabLocations.set(contents.id, locations);
  sendToShell('site-locations:changed', { wcId: contents.id, ...locations });
}

/**
 * A top-level response in a browser session, with its Onion-Location and
 * Nsite-Location headers (null without them). It may come in before the
 * page commits or, from the extension, just after.
 */
export function siteLocationResponse(url: string, onion: string | null, nsite: string | null): void {
  const now = Date.now();
  for (const [key, entry] of headerLocations) if (now - entry.at > HEADER_TTL_MS) headerLocations.delete(key);
  const locations = locationsFor(url, onion, nsite);
  if (isNone(locations)) return;
  const key = withoutHash(url);
  headerLocations.set(key, { locations, at: now });
  for (const tab of tabs) {
    if (!tab.isDestroyed() && withoutHash(tab.getURL()) === key) setLocations(tab, locations);
  }
}

/** A header among a response's headers, whatever its case. */
export function responseHeader(headers: Record<string, string[]> | undefined, name: string): string | null {
  for (const [key, values] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return values[0] ?? null;
  }
  return null;
}

/** An isolated world of its own, so the page's scripts can't stand in for the DOM's. */
const META_WORLD_ID = 1_337;
const READ_META = `(() => {
  const read = (name) => document.querySelector('meta[http-equiv="' + name + '" i]')?.getAttribute('content') ?? null;
  return { onion: read('onion-location'), nsite: read('nsite-location') };
})()`;

/** Follow a browser tab's pages for the other places they name. */
export function attachSiteLocations(contents: Electron.WebContents): void {
  tabs.add(contents);
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) setLocations(contents, NONE);
  });
  contents.on('did-navigate', (_event, url) => {
    const entry = headerLocations.get(withoutHash(url));
    if (entry) setLocations(contents, entry.locations);
  });
  contents.on('dom-ready', () => {
    const url = contents.getURL();
    const current = tabLocations.get(contents.id) ?? NONE;
    if ((current.onion && current.nsite) || !canNameLocations(url)) return;
    contents
      .executeJavaScriptInIsolatedWorld(META_WORLD_ID, [{ code: READ_META }])
      .then((meta: unknown) => {
        if (contents.isDestroyed() || contents.getURL() !== url || typeof meta !== 'object' || !meta) return;
        const found = locationsFor(url, (meta as SiteLocations).onion, (meta as SiteLocations).nsite);
        // The headers' say wins over the page's.
        const now = tabLocations.get(contents.id) ?? NONE;
        setLocations(contents, { onion: now.onion ?? found.onion, nsite: now.nsite ?? found.nsite });
      })
      .catch(() => {});
  });
  contents.once('destroyed', () => {
    tabs.delete(contents);
    tabLocations.delete(contents.id);
  });
}

export function registerSiteLocationHandlers(options: {
  assertShellSender: AssertSender;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;

  ipcMain.handle('site-locations:get', (event, wcId: unknown) => {
    assertShellSender(event);
    return typeof wcId === 'number' ? (tabLocations.get(wcId) ?? NONE) : NONE;
  });
}
