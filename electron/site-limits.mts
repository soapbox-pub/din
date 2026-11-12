// Site limits: websites the user asked Din to keep them off, for their own
// sake (Reddit, say), in every browser tab (private and Tor too) and in
// installed web apps.
//
// A limited site has one of three modes:
//   - pause: every visit waits behind a page that counts down, then lets the
//     user in for 5 or 15 minutes (one sec's and ScreenZen's friction);
//   - daily: the site is free until it has had its minutes today, then waits
//     behind the same page for 5 minutes more at a time (Screen Time's limit);
//   - block: the page has no way through; the limit itself has to go.
// The wait grows with each try that day, and the page says how many there
// have been.
//
// This process enforces it. A guest's main-frame navigation to a limited
// site without a pass is stopped (will-navigate for links and scripts,
// will-redirect for redirects, and did-start-navigation for the loads the
// shell starts, which will-navigate doesn't see) and the shell is told to cover the guest
// with the limit's page (site-limits:block). A guest already on the site when
// its time runs out is covered and muted where it stands.
//
// Time counts while a guest on the site is on screen: not a background tab,
// a minimized window or a covered one (the shell's guestVisibility reports),
// and not while the computer sits idle.
//
// The limits and today's time live in userData/site-limits.json and are
// changed by the shell over site-limits:*. Passes are kept in memory: a
// restart ends them.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import fs from 'node:fs';
import { app, ipcMain, powerMonitor, webContents } from 'electron';
import { getDomain } from 'tldts-experimental';

export type SiteLimitMode = 'pause' | 'daily' | 'block';

export interface SiteLimit {
  /** A registrable domain (reddit.com) or a host with none (localhost); covers its subdomains. */
  site: string;
  mode: SiteLimitMode;
  /** The daily allowance, for 'daily'. */
  minutes: number;
}

interface Usage {
  /** Seconds on screen today. */
  seconds: number;
  /** Times the limit's page stopped a visit today. */
  attempts: number;
}

/** What covers a guest stopped at a limited site. */
export interface SiteLimitBlock {
  wcId: number;
  /** Where the guest was going (or was, when its time ran out there). */
  url: string;
  site: string;
  mode: SiteLimitMode;
  minutes: number;
  /** Seconds on screen today. */
  seconds: number;
  attempts: number;
  /** When the page went up, and how many seconds it holds the way through shut. */
  since: number;
  wait: number;
  /** How long a pass from the page may be, in minutes: none for 'block'. */
  passes: number[];
  /** The guest's own page isn't the site, so dismissing the cover leaves it there. */
  canStay: boolean;
}

export interface SiteLimitStatus {
  site: string;
  limit: SiteLimit | null;
  seconds: number;
  attempts: number;
  /** When the current pass ends, or null. */
  passUntil: number | null;
}

const MODES: SiteLimitMode[] = ['pause', 'daily', 'block'];
const DAILY_MINUTES = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240];
/** How often time on screen is counted. */
const TICK_MS = 5000;
/** Idle longer than this and a page on screen is no longer being looked at. */
const IDLE_SECONDS = 5 * 60;
/** How often today's time is written down while it's counting. */
const SAVE_EVERY_MS = 60_000;
/** Navigations stopped this close together are one try (a redirect, a page that retries). */
const SAME_TRY_MS = 3000;

let limits: SiteLimit[] = [];
let day = today();
let usage = new Map<string, Usage>();
/** When each site's pass ends. */
const passes = new Map<string, number>();
/** Guests covered by a limit's page. */
const blocks = new Map<number, SiteLimitBlock>();
/** Guests muted because their time ran out while a page played. */
const muted = new Set<number>();
/** When each site last stopped a visit. */
const lastTry = new Map<string, number>();
const guests = new Set<Electron.WebContents>();
let ticker: NodeJS.Timeout | null = null;
let dirtyUsage = false;
let lastSave = 0;

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let isGuestHidden: (wcId: number) => boolean = () => false;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'site-limits.json');
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function validMinutes(value: unknown): number {
  return typeof value === 'number' && DAILY_MINUTES.includes(value) ? value : 30;
}

function loadSettings(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;
    if (Array.isArray(raw.limits)) {
      limits = raw.limits.flatMap((entry: unknown) => {
        const { site, mode, minutes } = (entry ?? {}) as Record<string, unknown>;
        if (typeof site !== 'string' || !MODES.includes(mode as SiteLimitMode)) return [];
        return [{ site, mode: mode as SiteLimitMode, minutes: validMinutes(minutes) }];
      });
    }
    if (raw.day === day && raw.usage && typeof raw.usage === 'object') {
      for (const [site, value] of Object.entries(raw.usage as Record<string, unknown>)) {
        const { seconds, attempts } = (value ?? {}) as Record<string, unknown>;
        usage.set(site, {
          seconds: typeof seconds === 'number' ? seconds : 0,
          attempts: typeof attempts === 'number' ? attempts : 0,
        });
      }
    }
  } catch {
    // First run, or a corrupt file: no limits.
  }
}

function saveSettings(): void {
  dirtyUsage = false;
  lastSave = Date.now();
  try {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ limits, day, usage: Object.fromEntries(usage) }),
    );
  } catch (error) {
    console.error('site-limits: failed to save:', error);
  }
}

/** The limits and today's time, as the shell shows them. */
function snapshot() {
  return { limits, usage: Object.fromEntries(usage) };
}

function changed(): void {
  saveSettings();
  sendToShell('site-limits:settings', snapshot());
}

/** A new day starts everyone's time and tries over. */
function rollDay(): void {
  const now = today();
  if (now === day) return;
  day = now;
  usage = new Map();
  lastTry.clear();
  changed();
}

function hostnameOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) && hostname ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The site a limit on this host covers: its registrable domain, or the host. */
function siteOfHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return getDomain(host, { allowPrivateDomains: false }) ?? host;
}

/** The limit covering a host, if any. */
function limitFor(hostname: string): SiteLimit | null {
  for (const limit of limits) {
    if (hostname === limit.site || hostname.endsWith(`.${limit.site}`)) return limit;
  }
  return null;
}

function usageOf(site: string): Usage {
  let entry = usage.get(site);
  if (!entry) {
    entry = { seconds: 0, attempts: 0 };
    usage.set(site, entry);
  }
  return entry;
}

function hasPass(site: string): boolean {
  const until = passes.get(site);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  passes.delete(site);
  return false;
}

/** Whether a limit keeps its site shut right now. */
function isShut(limit: SiteLimit): boolean {
  if (hasPass(limit.site)) return false;
  if (limit.mode === 'daily') return (usage.get(limit.site)?.seconds ?? 0) >= limit.minutes * 60;
  return true;
}

/** How long the page holds the way through shut, by the day's tries. */
function waitFor(limit: SiteLimit, attempts: number): number {
  const tries = Math.max(0, attempts - 1);
  return limit.mode === 'daily' ? Math.min(120, 30 + 10 * tries) : Math.min(60, 10 + 5 * tries);
}

function passesFor(mode: SiteLimitMode): number[] {
  return mode === 'pause' ? [5, 15] : mode === 'daily' ? [5] : [];
}

/** Cover a guest with a limit's page, counting a try unless it's part of the last one. */
function block(contents: Electron.WebContents, url: string, limit: SiteLimit, isTry: boolean): void {
  rollDay();
  const entry = usageOf(limit.site);
  const now = Date.now();
  if (isTry && now - (lastTry.get(limit.site) ?? 0) > SAME_TRY_MS) {
    entry.attempts += 1;
    changed();
  }
  if (isTry) lastTry.set(limit.site, now);
  const previous = blocks.get(contents.id);
  // The same page again (a redirect, a retry) keeps its countdown.
  const since = previous?.site === limit.site ? previous.since : now;
  const host = hostnameOf(contents.getURL());
  const info: SiteLimitBlock = {
    wcId: contents.id,
    url,
    site: limit.site,
    mode: limit.mode,
    minutes: limit.minutes,
    seconds: Math.round(entry.seconds),
    attempts: entry.attempts,
    since,
    wait: waitFor(limit, entry.attempts),
    passes: passesFor(limit.mode),
    canStay: !!host && limitFor(host) !== limit,
  };
  blocks.set(contents.id, info);
  sendToShell('site-limits:block', { wcId: contents.id, block: info });
}

function unblock(contents: Electron.WebContents): void {
  if (muted.delete(contents.id) && !contents.isDestroyed()) contents.setAudioMuted(false);
  if (!blocks.delete(contents.id)) return;
  sendToShell('site-limits:block', { wcId: contents.id, block: null });
}

/** Where a guest's main frame is going: stop it there if it's a shut site's. */
function guard(contents: Electron.WebContents, url: string, stop: () => void): void {
  const host = hostnameOf(url);
  const limit = host ? limitFor(host) : null;
  if (!limit || !isShut(limit)) {
    unblock(contents);
    return;
  }
  stop();
  block(contents, url, limit, true);
}

/**
 * Cover the guests on a site whose time just ran out (its daily minutes, or
 * a pass), where they stand. Media would play on under the cover: mute it.
 */
function shutOpenPages(): void {
  for (const contents of guests) {
    if (contents.isDestroyed() || blocks.has(contents.id)) continue;
    const url = contents.getURL();
    const host = hostnameOf(url);
    const limit = host ? limitFor(host) : null;
    if (!limit || !isShut(limit)) continue;
    if (!contents.isAudioMuted()) {
      contents.setAudioMuted(true);
      muted.add(contents.id);
    }
    block(contents, url, limit, false);
  }
}

/** Count a tick on screen for each limited site showing, and shut what ran out. */
function tick(): void {
  rollDay();
  const state = powerMonitor.getSystemIdleState(IDLE_SECONDS);
  // 'unknown' where the compositor can't say: count then.
  if (state !== 'idle' && state !== 'locked') {
    const showing = new Set<string>();
    for (const contents of guests) {
      if (contents.isDestroyed() || blocks.has(contents.id) || isGuestHidden(contents.id)) continue;
      const host = hostnameOf(contents.getURL());
      const limit = host ? limitFor(host) : null;
      if (limit) showing.add(limit.site);
    }
    for (const site of showing) {
      usageOf(site).seconds += TICK_MS / 1000;
      dirtyUsage = true;
    }
    if (showing.size > 0) sendToShell('site-limits:settings', snapshot());
  }
  shutOpenPages();
  if (dirtyUsage && Date.now() - lastSave >= SAVE_EVERY_MS) saveSettings();
}

/** Count only while there's something to count. */
function updateTicker(): void {
  const wanted = limits.length > 0 && guests.size > 0;
  if (wanted && !ticker) {
    ticker = setInterval(tick, TICK_MS);
  } else if (!wanted && ticker) {
    clearInterval(ticker);
    ticker = null;
    if (dirtyUsage) saveSettings();
  }
}

/** Watch a web guest (a browser tab or an installed app's window). */
export function attachSiteLimits(contents: Electron.WebContents): void {
  guests.add(contents);
  updateTicker();
  // A link or a script, stopped before it starts; did-start-navigation never
  // sees it then.
  contents.on('will-navigate', (event) => {
    if (event.isMainFrame) guard(contents, event.url, () => event.preventDefault());
  });
  // Everything else, the shell's own loads too.
  contents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    // Not from inside the event: stopping a navigation as it starts trips a
    // CHECK in Chromium and takes the whole browser process down. A turn
    // later it's still pending, and stops cleanly.
    guard(contents, event.url, () => setImmediate(() => {
      if (contents.isDestroyed()) return;
      contents.stop();
      // One that committed at once (from the back/forward cache) stays
      // under the cover: keep it quiet there.
      const host = hostnameOf(contents.getURL());
      if (host && limitFor(host) && blocks.has(contents.id) && !contents.isAudioMuted()) {
        contents.setAudioMuted(true);
        muted.add(contents.id);
      }
    }));
  });
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame) guard(contents, event.url, () => event.preventDefault());
  });
  contents.once('destroyed', () => {
    guests.delete(contents);
    blocks.delete(contents.id);
    muted.delete(contents.id);
    updateTicker();
  });
}

/** A hostname from the shell or a command: a plausible one, lowercased. */
function hostArg(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid site');
  let host = value.trim().toLowerCase();
  // A pasted address works too.
  if (/^[a-z]+:\/\//.test(host)) host = hostnameOf(host) ?? '';
  host = host.replace(/\/.*$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(host) || (!host.includes('.') && host !== 'localhost')) {
    throw new Error('Invalid site');
  }
  return host;
}

function status(host: string): SiteLimitStatus {
  rollDay();
  const limit = limitFor(host);
  const site = limit?.site ?? siteOfHost(host);
  const entry = usage.get(site);
  return {
    site,
    limit,
    seconds: Math.round(entry?.seconds ?? 0),
    attempts: entry?.attempts ?? 0,
    passUntil: hasPass(site) ? (passes.get(site) ?? null) : null,
  };
}

export function setupSiteLimits(options: {
  /** Whether the shell is hiding a guest (a background tab, a minimized window). */
  isGuestHidden: (wcId: number) => boolean;
  assertShellSender: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  sendToShell = options.sendToShell;
  isGuestHidden = options.isGuestHidden;
  const { assertShellSender } = options;

  loadSettings();
  app.on('before-quit', () => {
    if (dirtyUsage) saveSettings();
  });

  ipcMain.handle('site-limits:get', (event) => {
    assertShellSender(event);
    rollDay();
    return snapshot();
  });

  ipcMain.handle('site-limits:status', (event, hostname: unknown) => {
    assertShellSender(event);
    return status(hostArg(hostname));
  });

  // Limit a site, change its limit, or (null) lift it. Returns the site it
  // covers, which is the host's registrable domain unless a limit already
  // covered it.
  ipcMain.handle('site-limits:set', (event, hostname: unknown, raw: unknown) => {
    assertShellSender(event);
    const host = hostArg(hostname);
    const existing = limitFor(host);
    const site = existing?.site ?? siteOfHost(host);
    limits = limits.filter((l) => l !== existing);
    if (raw !== null) {
      const { mode, minutes } = (raw ?? {}) as Record<string, unknown>;
      if (!MODES.includes(mode as SiteLimitMode)) throw new Error('Invalid limit');
      limits.push({ site, mode: mode as SiteLimitMode, minutes: validMinutes(minutes) });
      limits.sort((a, b) => a.site.localeCompare(b.site));
      passes.delete(site);
    } else {
      passes.delete(site);
      // Nothing holds its pages shut any more.
      for (const contents of guests) {
        const info = blocks.get(contents.id);
        if (info?.site === site) unblock(contents);
      }
    }
    changed();
    updateTicker();
    shutOpenPages();
    return site;
  });

  ipcMain.handle('site-limits:blockOf', (event, wcId: unknown) => {
    assertShellSender(event);
    return typeof wcId === 'number' ? (blocks.get(wcId) ?? null) : null;
  });

  // The way through a limit's page, once its countdown has run: a pass for
  // the site, and the guest goes where it was going.
  ipcMain.handle('site-limits:allow', (event, wcId: unknown, minutes: unknown) => {
    assertShellSender(event);
    const info = typeof wcId === 'number' ? blocks.get(wcId) : undefined;
    const contents = typeof wcId === 'number' ? webContents.fromId(wcId) : undefined;
    if (!info || !contents || contents.isDestroyed()) throw new Error('Nothing is limited there');
    if (typeof minutes !== 'number' || !info.passes.includes(minutes)) throw new Error('Invalid time');
    if (Date.now() < info.since + info.wait * 1000) throw new Error('Not yet');
    passes.set(info.site, Date.now() + minutes * 60_000);
    // Every page waiting on the site opens: the user chose to go there.
    for (const guest of guests) {
      const waiting = blocks.get(guest.id);
      if (waiting?.site !== info.site) continue;
      const here = hostnameOf(guest.getURL());
      const there = here ? limitFor(here) : null;
      unblock(guest);
      if (there?.site !== info.site) guest.loadURL(waiting.url).catch(() => {});
    }
  });

  // Leave a limit's page for the page under it, when that isn't the site.
  ipcMain.handle('site-limits:dismiss', (event, wcId: unknown) => {
    assertShellSender(event);
    const contents = typeof wcId === 'number' ? webContents.fromId(wcId) : undefined;
    const info = typeof wcId === 'number' ? blocks.get(wcId) : undefined;
    if (!contents || contents.isDestroyed() || !info?.canStay) return;
    unblock(contents);
  });
}
