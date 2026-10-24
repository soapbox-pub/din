// Din's built-in ad blocker for the Web Browser app, on Ghostery's
// open-source filter engine with EasyList, EasyPrivacy, and uBlock Origin's
// lists.
//
// Blocking has three parts:
//   - Network requests in the persistent browser session are blocked by an
//     extension Din ships (electron/adblock-extension/), through
//     chrome.webRequest. A session.webRequest listener would be simpler, but
//     it silently switches chrome.webRequest off for every extension the user
//     installs (see the warning in main.mts).
//   - Network requests in the private session go through session.webRequest
//     directly: extensions never run there, so nothing is lost.
//   - Cosmetic filters run in both: Ghostery's page preload asks this process
//     for the styles that hide ad slots, and adblock-scriptlets-preload.cjs
//     runs scriptlets before the page's own scripts (YouTube's ads need that).
//
// The filter lists are downloaded and compiled in a utility process
// (adblock-worker.mts), cached in userData, and refreshed every few hours. This
// process keeps one engine for cosmetics and private tabs, and hands the
// extension the same serialized engine.
//
// Settings (on/off, sites the user allowed ads on) live in userData and are
// changed by the shell over adblock:*.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { app, ipcMain, utilityProcess, webContents } from 'electron';
import { FiltersEngine, Request } from '@ghostery/adblocker';
import { parse as parseDomain } from 'tldts-experimental';

const require = createRequire(import.meta.url);

/** The extension's id, fixed by the `key` in its manifest. */
export const ADBLOCK_EXTENSION_ID = 'gmmdegmbkcjkjfbacghangmkafhmkoeb';
const EXTENSION_ORIGIN = `chrome-extension://${ADBLOCK_EXTENSION_ID}`;
const EXTENSION_DIR = path.join(import.meta.dirname, 'adblock-extension');
// .mts in development, the compiled .mjs in a build (scripts/build-electron.mjs).
const WORKER = path.join(import.meta.dirname, `adblock-worker${path.extname(import.meta.filename)}`);
const PRELOAD = path.join(import.meta.dirname, 'adblock-preload.cjs');
const SCRIPTLETS_PRELOAD = path.join(import.meta.dirname, 'adblock-scriptlets-preload.cjs');

/**
 * How old the cached engine may get before the lists are checked again. uBlock
 * Origin's quick fixes, where YouTube's rules live, expire this often.
 */
const ENGINE_MAX_AGE_MS = 8 * 60 * 60_000;
/**
 * How long to wait after a failed build before trying again: a minute at
 * first, since the first build usually runs at boot before Wi-Fi is up, then
 * doubling up to half an hour while the computer stays offline.
 */
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 30 * 60_000;

interface Settings {
  enabled: boolean;
  /** Hostnames the user turned blocking off for. */
  allowlist: string[];
}

let settings: Settings = { enabled: true, allowlist: [] };
let allowlist = new Set<string>();
let engine: FiltersEngine | null = null;
/** A browser tab has been opened, so the engine is wanted in memory. */
let engineWanted = false;
let building = false;
let retryMs = FIRST_RETRY_MS;

/**
 * What was blocked since each tab's page last loaded, by WebContents id. URLs,
 * not requests: a page that retries a blocked request in a loop would
 * otherwise count into the tens of thousands.
 */
const blockedUrls = new Map<number, Set<string>>();
const dirtyCounts = new Set<number>();
let countsTimer: NodeJS.Timeout | null = null;

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let isBrowserTab: (contents: Electron.WebContents) => boolean = () => false;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'adblock.json');
}

function engineFile(): string {
  return path.join(app.getPath('userData'), 'adblock-engine.bin');
}

function loadSettings(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;
    settings = {
      enabled: raw.enabled !== false,
      allowlist: Array.isArray(raw.allowlist)
        ? raw.allowlist.filter((h): h is string => typeof h === 'string')
        : [],
    };
  } catch {
    // First run, or a corrupt file: blocking on, nothing allowed.
  }
  allowlist = new Set(settings.allowlist);
}

function saveSettings(): void {
  settings.allowlist = [...allowlist];
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
  } catch (error) {
    console.error('adblock: failed to save settings:', error);
  }
  for (const page of backgroundPages()) page.send('adblock-ext:settings', settings);
  sendToShell('adblock:settings', settings);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Whether blocking applies to what the given tab is showing. */
function activeFor(contents: Electron.WebContents): boolean {
  return settings.enabled && !!engine && !allowlist.has(hostnameOf(contents.getURL()));
}

// --- The engine ------------------------------------------------------------

function loadEngine(): boolean {
  try {
    engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(engineFile())));
    return true;
  } catch {
    engine = null;
    return false;
  }
}

function engineAge(): number {
  try {
    // An engine with no revisions beside it predates the worker reading
    // Ghostery's CDN, and was built from lists months out of date.
    fs.statSync(`${engineFile()}.revisions`);
    return Date.now() - fs.statSync(engineFile()).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** Fetch and compile the lists in the worker, then switch to the result. */
function buildEngine(): void {
  if (building) return;
  building = true;
  const child = utilityProcess.fork(WORKER, [engineFile()], {
    serviceName: 'Din ad blocker lists',
    stdio: 'inherit',
  });
  child.once('exit', (code) => {
    building = false;
    if (code === 0 || code === 2) retryMs = FIRST_RETRY_MS;
    if (code === 0 && (!engineWanted || loadEngine())) {
      for (const page of backgroundPages()) page.send('adblock-ext:engineChanged');
      sendToShell('adblock:settings', settings);
    } else if (code !== 2) {
      // (2 is the lists not having changed: the engine we have is current.)
      setTimeout(buildEngine, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    }
  });
}

/** Keep the engine fresh: rebuild once it's old, checking every hour. */
function scheduleUpdates(): void {
  const check = () => {
    if (engineAge() > ENGINE_MAX_AGE_MS) buildEngine();
  };
  check();
  setInterval(check, 60 * 60_000).unref();
}

// --- Blocked counts --------------------------------------------------------

function countBlocked(wcId: number, url: string): void {
  let urls = blockedUrls.get(wcId);
  if (!urls) blockedUrls.set(wcId, (urls = new Set()));
  if (urls.has(url)) return;
  urls.add(url);
  dirtyCounts.add(wcId);
  countsTimer ??= setTimeout(flushCounts, 250);
}

function flushCounts(): void {
  countsTimer = null;
  for (const wcId of dirtyCounts) {
    sendToShell('adblock:blocked', { wcId, count: blockedUrls.get(wcId)?.size ?? 0 });
  }
  dirtyCounts.clear();
}

// --- The extension ---------------------------------------------------------

function backgroundPages(): Electron.WebContents[] {
  return webContents
    .getAllWebContents()
    .filter((c) => !c.isDestroyed() && c.getType() === 'backgroundPage' && c.getURL().startsWith(EXTENSION_ORIGIN));
}

/** Whether an IPC message comes from the extension's own background page. */
function isExtensionSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return (
    event.sender.getType() === 'backgroundPage' &&
    !!event.senderFrame &&
    event.senderFrame.origin === EXTENSION_ORIGIN
  );
}

// --- Network blocking in the private session -------------------------------

function requestOf(details: Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails): Request {
  return Request.fromRawDetails({
    requestId: `${details.id}`,
    tabId: details.webContentsId,
    url: details.url,
    sourceUrl: details.referrer || details.frame?.url,
    type: details.resourceType || 'other',
  });
}

function blockInSession(session: Electron.Session): void {
  const tabOf = (details: { webContentsId?: number }) =>
    details.webContentsId === undefined ? undefined : webContents.fromId(details.webContentsId);

  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const tab = tabOf(details);
    if (details.resourceType === 'mainFrame' || !tab || !engine || !activeFor(tab)) {
      callback({});
      return;
    }
    const { match, redirect } = engine.match(requestOf(details));
    if (redirect) {
      countBlocked(tab.id, details.url);
      callback({ redirectURL: redirect.dataUrl });
    } else if (match) {
      countBlocked(tab.id, details.url);
      callback({ cancel: true });
    } else {
      callback({});
    }
  });

  session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    const tab = tabOf(details);
    if (
      (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') ||
      !tab || !engine || !(settings.enabled && !allowlist.has(hostnameOf(details.url)))
    ) {
      callback({});
      return;
    }
    const policy = engine.getCSPDirectives(requestOf(details));
    if (!policy) {
      callback({});
      return;
    }
    const responseHeaders = details.responseHeaders ?? {};
    responseHeaders['Content-Security-Policy'] = [
      ...(responseHeaders['Content-Security-Policy'] ?? []),
      policy,
    ];
    callback({ responseHeaders });
  });
}

// --- Cosmetic filtering ----------------------------------------------------

/**
 * Ghostery's page preload asks for a page's cosmetics through these, but its
 * scriptlets come from adblock-scriptlets-preload.cjs, which has to have them
 * before the page runs anything.
 */
function registerCosmeticHandlers(): void {
  // Setting returnValue sends the reply there and then, so it's set once.
  ipcMain.on('adblock:scriptlets', (event, url: unknown) => {
    const contents = event.sender;
    if (!isBrowserTab(contents) || !engine || !activeFor(contents) || typeof url !== 'string') {
      event.returnValue = [];
      return;
    }
    const { hostname, domain } = parseDomain(url);
    event.returnValue = engine.getCosmeticsFilters({
      url,
      hostname: hostname || '',
      domain: domain || '',
      getBaseRules: false,
      getInjectionRules: true,
      getExtendedRules: false,
      getRulesFromHostname: true,
      getRulesFromDOM: false,
    }).scripts;
  });
  ipcMain.handle(
    '@ghostery/adblocker/inject-cosmetic-filters',
    (event, url: unknown, msg?: { classes?: string[]; hrefs?: string[]; ids?: string[]; lifecycle?: string }) => {
      const contents = event.sender;
      if (!isBrowserTab(contents) || !engine || !activeFor(contents)) return;
      if (typeof url !== 'string') return;
      const { hostname, domain } = parseDomain(url);
      const first = msg === undefined;
      const { active, styles } = engine.getCosmeticsFilters({
        url,
        hostname: hostname || '',
        domain: domain || '',
        classes: msg?.classes,
        hrefs: msg?.hrefs,
        ids: msg?.ids,
        getBaseRules: first,
        getInjectionRules: false,
        getExtendedRules: false,
        getRulesFromHostname: first,
        getRulesFromDOM: !first,
        callerContext: { frameId: event.frameId, processId: event.processId, lifecycle: msg?.lifecycle },
      });
      if (!active) return;
      if (styles.length > 0) contents.insertCSS(styles, { cssOrigin: 'user' }).catch(() => {});
    },
  );
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) => {
    return isBrowserTab(event.sender) && !!engine && engine.config.enableMutationObserver;
  });
}

// --- Wiring ----------------------------------------------------------------

/** Track a browser tab's blocked count from page load to page load. */
export function attachAdblock(contents: Electron.WebContents): void {
  contents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    blockedUrls.delete(contents.id);
    sendToShell('adblock:blocked', { wcId: contents.id, count: 0 });
  });
  contents.once('destroyed', () => {
    blockedUrls.delete(contents.id);
    dirtyCounts.delete(contents.id);
  });
}

/**
 * Load the filter engine (~7 MB in memory) if it isn't yet. Called as the
 * first browser tab attaches, before it loads anything, so a session that
 * never browses never holds it.
 */
export function ensureAdblockEngine(): void {
  if (engineWanted) return;
  engineWanted = true;
  loadEngine();
}

/** Whether an installed extension is the ad blocker (hidden from the list). */
export function isAdblockExtension(id: string): boolean {
  return id === ADBLOCK_EXTENSION_ID;
}

export function setupAdblock(options: {
  /** The persistent session, where the extension blocks. */
  browserSession: Electron.Session;
  /** The private session, blocked here in the main process. */
  privateSession: Electron.Session;
  isBrowserTab: (contents: Electron.WebContents) => boolean;
  assertShellSender: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  /**
   * A top-level response in the persistent session, with its
   * Cross-Origin-Opener-Policy. The extension is the one thing there that may
   * watch responses (see popups.mts), so it passes them on.
   */
  onTopLevelResponse: (url: string, coop: string | null) => void;
}): void {
  sendToShell = options.sendToShell;
  isBrowserTab = options.isBrowserTab;
  const { assertShellSender } = options;

  loadSettings();
  // The engine itself loads with the first browser tab (ensureAdblockEngine).
  scheduleUpdates();

  // The extension's line to this process (adblock-preload.cjs).
  options.browserSession.registerPreloadScript({ id: 'din-adblock-extension', type: 'frame', filePath: PRELOAD });
  ipcMain.handle('adblock-ext:settings', (event) => {
    if (!isExtensionSender(event)) throw new Error('adblock: unauthorized sender');
    return settings;
  });
  ipcMain.handle('adblock-ext:engine', (event) => {
    if (!isExtensionSender(event)) throw new Error('adblock: unauthorized sender');
    try {
      return new Uint8Array(fs.readFileSync(engineFile()));
    } catch {
      return null;
    }
  });
  // The extension can't tell tabs apart (see its background.js), only sites,
  // so what it blocked counts for every tab on that site.
  ipcMain.on('adblock-ext:blocked', (event, reports: unknown) => {
    if (!isExtensionSender(event) || !Array.isArray(reports)) return;
    const tabs = webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed() && c.session === options.browserSession && isBrowserTab(c));
    for (const entry of reports) {
      if (!Array.isArray(entry)) continue;
      const [site, urls] = entry;
      if (typeof site !== 'string' || !Array.isArray(urls)) continue;
      for (const tab of tabs) {
        if (hostnameOf(tab.getURL()) !== site) continue;
        for (const url of urls) if (typeof url === 'string') countBlocked(tab.id, url);
      }
    }
  });
  ipcMain.on('adblock-ext:document', (event, url: unknown, coop: unknown) => {
    if (!isExtensionSender(event) || typeof url !== 'string') return;
    options.onTopLevelResponse(url, typeof coop === 'string' ? coop : null);
  });
  options.browserSession.extensions.loadExtension(EXTENSION_DIR).catch((error) => {
    console.error('adblock: failed to load the extension:', error);
  });

  blockInSession(options.privateSession);

  // Cosmetic filtering in both sessions.
  const cosmeticPreload = require.resolve('@ghostery/adblocker-electron-preload');
  for (const s of [options.browserSession, options.privateSession]) {
    s.registerPreloadScript({ id: 'din-adblock-scriptlets', type: 'frame', filePath: SCRIPTLETS_PRELOAD });
    s.registerPreloadScript({ id: 'din-adblock-cosmetics', type: 'frame', filePath: cosmeticPreload });
  }
  registerCosmeticHandlers();

  // The shell's controls.
  ipcMain.handle('adblock:getSettings', (event) => {
    assertShellSender(event);
    return settings;
  });
  ipcMain.handle('adblock:setEnabled', (event, enabled: unknown) => {
    assertShellSender(event);
    settings.enabled = enabled === true;
    saveSettings();
  });
  ipcMain.handle('adblock:setSiteAllowed', (event, hostname: unknown, allowed: unknown) => {
    assertShellSender(event);
    if (typeof hostname !== 'string' || !/^[a-z0-9.:[\]-]{1,253}$/i.test(hostname)) {
      throw new Error('Invalid hostname');
    }
    if (allowed === true) allowlist.add(hostname.toLowerCase());
    else allowlist.delete(hostname.toLowerCase());
    saveSettings();
  });
  ipcMain.handle('adblock:blockedCount', (event, wcId: unknown) => {
    assertShellSender(event);
    return typeof wcId === 'number' ? (blockedUrls.get(wcId)?.size ?? 0) : 0;
  });
}
