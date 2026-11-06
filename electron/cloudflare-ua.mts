// The Web Browser's user agent, and Cloudflare's challenge.
//
// Browser tabs (and installed apps, which share their session) say they're
// Chrome, as Chromium-based browsers do: Electron's default user agent names
// Electron, which sites like YouTube take as a sign of an ad blocker.
//
// Cloudflare's challenge ("Verify you are human") fails every time under that
// user agent, looping back to itself however often it's ticked: it tells
// Electron from Chrome by the page's own JavaScript, and turns away a browser
// that says it's something else. (Its frame from challenges.cloudflare.com
// also says Electron whatever the session says, since a frame in a process of
// its own takes app.userAgentFallback, not the session's user agent.) With
// the user agent Electron gives, it passes on its own, with no box to tick.
//
// So a site that answers with a challenge (its `cf-mitigated: challenge`
// header) is remembered, and its tabs are reloaded saying what they are:
// Electron's own user agent, the same one the challenge's frame gives. They
// keep saying so on that site afterwards, since the clearance Cloudflare gives
// holds only for the user agent that earned it. Sites are remembered by their
// registrable domain, as that clearance is; the persistent session's are kept
// in userData/cloudflare-sites.json, the in-memory sessions' (private
// windows', Tor's) only in memory, as their cookies are.

import fs from 'node:fs';
import path from 'node:path';
import { app, webContents } from 'electron';
import { getDomain } from 'tldts-experimental';

interface SessionState {
  /** What Electron says it is; the challenge passes with this. */
  honest: string;
  /** What the session says otherwise: Chrome. */
  chrome: string;
  sites: Set<string>;
  persist: boolean;
}

/** At most this many sites are remembered, the oldest forgotten first. */
const MAX_SITES = 1000;

const states = new Map<Electron.Session, SessionState>();
let isWebGuest: (contents: Electron.WebContents) => boolean = () => false;

function sitesFile(): string {
  return path.join(app.getPath('userData'), 'cloudflare-sites.json');
}

function loadSites(): Set<string> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(sitesFile(), 'utf8'));
    if (Array.isArray(raw)) return new Set(raw.filter((s): s is string => typeof s === 'string'));
  } catch {
    // First run, or a corrupt file: no site yet.
  }
  return new Set();
}

function saveSites(state: SessionState): void {
  if (!state.persist) return;
  try {
    fs.writeFileSync(sitesFile(), JSON.stringify([...state.sites]));
  } catch (error) {
    console.error('cloudflare-ua: failed to save sites:', error);
  }
}

/** The registrable domain a URL is on (its hostname where it has none), or null. */
function siteOf(url: string): string | null {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/** The user agent a guest should give on a URL. */
function userAgentFor(state: SessionState, url: string): string {
  const site = siteOf(url);
  return site && state.sites.has(site) ? state.honest : state.chrome;
}

function guestsOf(s: Electron.Session): Electron.WebContents[] {
  return webContents
    .getAllWebContents()
    .filter((c) => !c.isDestroyed() && c.session === s && isWebGuest(c));
}

/**
 * Has each session's tabs say they're Chrome, but say what they are on sites
 * that have shown them Cloudflare's challenge. Before the first tab.
 */
export function setupBrowserUserAgents(options: {
  sessions: { session: Electron.Session; persist: boolean }[];
  /** Web content guests: browser tabs and installed apps. */
  isWebGuest: (contents: Electron.WebContents) => boolean;
}): void {
  isWebGuest = options.isWebGuest;
  for (const { session: s, persist } of options.sessions) {
    const honest = s.getUserAgent();
    const chrome = honest.replace(/\s(Electron|din)\/\S+/gi, '');
    s.setUserAgent(chrome);
    states.set(s, { honest, chrome, sites: persist ? loadSites() : new Set(), persist });
  }
  app.on('web-contents-created', (_event, contents) => {
    // Each navigation of a guest's page takes the user agent for where it's
    // going, set as it starts, so the new document's navigator and what it
    // loads say it. Its own request has gone under the old one by then (even
    // will-navigate is too late for that), so a challenge that comes back
    // for it is loaded again at once.
    let switched = false;
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      const state = states.get(contents.session);
      if (!state || !isWebGuest(contents)) return;
      const ua = userAgentFor(state, details.url);
      switched = contents.getUserAgent() !== ua;
      if (switched) contents.setUserAgent(ua);
    });
    // The challenge's response comes before its page is the guest's, so a
    // guest that has just arrived on a site marked by it says what it is
    // from here on, and loads the page again.
    contents.on('did-navigate', (_event, url, httpResponseCode) => {
      const state = states.get(contents.session);
      const retry = switched;
      switched = false;
      if (!state || !isWebGuest(contents) || userAgentFor(state, url) !== state.honest) return;
      if (contents.getUserAgent() !== state.honest) contents.setUserAgent(state.honest);
      else if (!retry || (httpResponseCode !== 403 && httpResponseCode !== 503)) return;
      contents.reload();
    });
  });
}

/**
 * A top-level response from a guest in a session. One that's Cloudflare's
 * challenge marks its site, and reloads the guests on it that still say
 * they're Chrome, now saying what they are.
 */
export function cloudflareResponse(s: Electron.Session, url: string, mitigated: string | null): void {
  if (mitigated?.trim().toLowerCase() !== 'challenge') return;
  const state = states.get(s);
  const site = siteOf(url);
  if (!state || !site || state.honest === state.chrome) return;
  if (!state.sites.has(site)) {
    state.sites.add(site);
    while (state.sites.size > MAX_SITES) state.sites.delete(state.sites.values().next().value as string);
    saveSites(state);
  }
  for (const contents of guestsOf(s)) {
    if (siteOf(contents.getURL()) !== site || contents.getUserAgent() === state.honest) continue;
    contents.setUserAgent(state.honest);
    contents.reload();
  }
}

/**
 * Forgets that a site showed the challenge, or every site, as its cookies
 * (and with them Cloudflare's clearance) are deleted.
 */
export function forgetCloudflareSites(s: Electron.Session, url?: string): void {
  const state = states.get(s);
  if (!state) return;
  if (url === undefined) state.sites.clear();
  else {
    const site = siteOf(url);
    if (!site || !state.sites.delete(site)) return;
  }
  saveSites(state);
}
