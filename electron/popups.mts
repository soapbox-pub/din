// Pop-ups for web pages: a Chrome-style pop-up blocker, and the link between
// a page and the window it opened.
//
// Blocking. A page may open a window (window.open, target=_blank, a form)
// only right after the user clicked, tapped or pressed a key in it, and each
// such press opens one window - Chrome's "transient user activation". Without
// one the window is blocked and the shell shows it in the address bar, where
// the user can open it or allow the site to open pop-ups from then on. Sites
// allowed that way live in userData/popups.json and are changed by the shell
// over popups:*.
//
// Openers. Din's tabs are <webview> guests, and a guest can't adopt a window
// Chromium creates for it, so every window.open is denied and the URL opens
// as a tab instead (see setWindowOpenHandler in main.mts). That cuts the two
// pages apart: window.open returns null and the tab's window.opener is null,
// which breaks pop-up sign-in (Google, Apple, Firebase, MSAL...). They post
// their result to window.opener and watch the pop-up's `closed`.
//
// popup-preload.cjs puts that link back. In the page it opens from,
// window.open returns a stand-in for the new tab's window; in the tab,
// window.opener is a stand-in for the page. Both carry postMessage, close,
// focus, closed and location, relayed through here. This process stamps every
// message with the origin of the frame that really sent it and delivers it
// only to a frame whose origin matches the sender's targetOrigin, as
// postMessage does.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { app, ipcMain, webContents, webFrameMain } from 'electron';

const PRELOAD = path.join(import.meta.dirname, 'popup-preload.cjs');

/** How long a press lets the page open a window, as in Chromium. */
const ACTIVATION_MS = 5000;
/** How long an opened tab has to show up before its link is dropped. */
const ATTACH_TIMEOUT_MS = 30_000;
/** Blocked pop-ups remembered per page. */
const MAX_BLOCKED = 20;

interface Settings {
  /** Hostnames allowed to open pop-ups without a click. */
  allowlist: string[];
}

interface FrameRef {
  processId: number;
  routingId: number;
}

/** A window a page opened, and the frame that opened it. */
interface PopupLink {
  id: string;
  openerWcId: number;
  openerFrame: FrameRef;
  /** The tab's guest, once the shell has made it. */
  popupWcId: number | null;
  /** The URL the tab is opening, until it attaches. Null: not opened yet. */
  pendingUrl: string | null;
}

let allowlist = new Set<string>();
let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let isWebGuest: (contents: Electron.WebContents) => boolean = () => false;

/** When each guest last had a press that may open a window. */
const activations = new Map<number, number>();
/** Pop-ups blocked since each guest's page loaded. */
const blocked = new Map<number, string[]>();
/** A window.open the preload announced, waiting for the open handler. */
const announced = new Map<number, { id: string; frame: FrameRef }>();
const links = new Map<string, PopupLink>();
/** The link whose tab is attaching (will-attach-webview -> web-contents-created). */
let attachingLink: PopupLink | null = null;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'popups.json');
}

function loadSettings(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;
    if (Array.isArray(raw.allowlist)) {
      allowlist = new Set(raw.allowlist.filter((h): h is string => typeof h === 'string'));
    }
  } catch {
    // First run, or a corrupt file: no site allowed.
  }
}

function settings(): Settings {
  return { allowlist: [...allowlist] };
}

function saveSettings(): void {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings()));
  } catch (error) {
    console.error('popups: failed to save settings:', error);
  }
  sendToShell('popups:settings', settings());
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

function frameOf(ref: FrameRef): Electron.WebFrameMain | null {
  const frame = webFrameMain.fromId(ref.processId, ref.routingId);
  return frame && !frame.isDestroyed() ? frame : null;
}

function liveContents(wcId: number | null): Electron.WebContents | null {
  if (wcId === null) return null;
  const contents = webContents.fromId(wcId);
  return contents && !contents.isDestroyed() ? contents : null;
}

// --- Blocking ----------------------------------------------------------------

/**
 * Whether a guest may open a window now, using up the press that allows it.
 * A blocked one is recorded and shown in the shell.
 */
export function mayOpenWindow(contents: Electron.WebContents, url: string): boolean {
  const pressed = activations.get(contents.id);
  if (pressed !== undefined && Date.now() - pressed <= ACTIVATION_MS) {
    activations.delete(contents.id);
    return true;
  }
  if (allowlist.has(hostnameOf(contents.getURL()))) return true;
  // An empty window is only worth showing once it goes somewhere.
  if (!/^(https|nsite):/i.test(url)) return false;

  const list = blocked.get(contents.id) ?? [];
  if (!list.includes(url)) {
    list.push(url);
    if (list.length > MAX_BLOCKED) list.shift();
  }
  blocked.set(contents.id, list);
  sendToShell('popups:blocked', { wcId: contents.id, urls: list });
  return false;
}

// --- Openers -----------------------------------------------------------------

/**
 * The open handler let a window open (its tab is on the way, or for
 * about:blank, not yet: `url` is null). Link it to its opener if the page's
 * window.open asked for one.
 */
export function windowOpened(contents: Electron.WebContents, url: string | null): void {
  const announcement = announced.get(contents.id);
  if (!announcement) return;
  announced.delete(contents.id);
  const link: PopupLink = {
    id: announcement.id,
    openerWcId: contents.id,
    openerFrame: announcement.frame,
    popupWcId: null,
    pendingUrl: url,
  };
  links.set(link.id, link);
  if (url) expireUnattached(link);
}

function expireUnattached(link: PopupLink): void {
  setTimeout(() => {
    if (links.get(link.id) === link && link.popupWcId === null && link.pendingUrl) closeLink(link);
  }, ATTACH_TIMEOUT_MS);
}

/** A <webview> is attaching with this src: it may be a linked window's tab. */
export function popupAttaching(src: string): void {
  attachingLink = null;
  for (const link of links.values()) {
    if (link.popupWcId === null && link.pendingUrl && sameUrl(link.pendingUrl, src)) {
      attachingLink = link;
      return;
    }
  }
}

/** The guest of the <webview> announced to popupAttaching. */
export function popupAttached(contents: Electron.WebContents): void {
  const link = attachingLink;
  attachingLink = null;
  if (!link || links.get(link.id) !== link) return;
  link.popupWcId = contents.id;
  link.pendingUrl = null;
  contents.on('did-navigate', () => reportLocation(link));
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) reportLocation(link);
  });
  contents.once('destroyed', () => {
    if (links.get(link.id) === link) closeLink(link);
  });
}

/**
 * Tell the opener where its window is - only while that's its own origin, as
 * a cross-origin window's location can't be read.
 */
function reportLocation(link: PopupLink): void {
  const popup = liveContents(link.popupWcId);
  const opener = frameOf(link.openerFrame);
  if (!popup || !opener) return;
  const sameOrigin = popup.mainFrame.origin === opener.origin;
  opener.send('popup-bridge:location', { id: link.id, href: sameOrigin ? popup.getURL() : null });
}

/** The window is gone (or never came): its opener sees it closed. */
function closeLink(link: PopupLink): void {
  links.delete(link.id);
  frameOf(link.openerFrame)?.send('popup-bridge:closed', { id: link.id });
}

/** The link whose window sent this, if it came from a linked tab's top frame. */
function linkOfPopup(event: Electron.IpcMainEvent): PopupLink | null {
  if (!event.senderFrame || event.senderFrame.parent) return null;
  for (const link of links.values()) {
    if (link.popupWcId === event.sender.id) return link;
  }
  return null;
}

/** A link this frame's page opened. */
function linkOpenedBy(event: Electron.IpcMainEvent, id: unknown): PopupLink | null {
  if (typeof id !== 'string') return null;
  const link = links.get(id);
  return link && link.openerWcId === event.sender.id ? link : null;
}

/** Whether a page may receive a message sent to `targetOrigin` by `source`. */
function originMatches(frame: Electron.WebFrameMain, targetOrigin: unknown, source: string): boolean {
  if (targetOrigin === '*') return true;
  if (targetOrigin === '/') return frame.origin === source;
  if (typeof targetOrigin !== 'string') return false;
  try {
    return new URL(targetOrigin).origin === frame.origin;
  } catch {
    return false;
  }
}

/** A window's new location: web URLs only, resolved by the page. */
function webUrl(url: unknown): string | null {
  return typeof url === 'string' && /^(https|nsite):\/\//i.test(url) ? url : null;
}

function registerBridge(): void {
  // Every handler answers web guests only; anything else gets nothing.
  const fromGuest = (event: Electron.IpcMainEvent): boolean =>
    isWebGuest(event.sender) && !!event.senderFrame;

  // A page's top frame asks, as it loads, whether it has an opener.
  ipcMain.on('popup-bridge:hello', (event) => {
    event.returnValue = fromGuest(event) && !!linkOfPopup(event);
  });

  // A page is about to call window.open; the open handler links what opens.
  ipcMain.on('popup-bridge:will-open', (event) => {
    const frame = event.senderFrame;
    if (!fromGuest(event) || !frame) {
      event.returnValue = null;
      return;
    }
    const id = crypto.randomUUID();
    announced.set(event.sender.id, { id, frame: { processId: frame.processId, routingId: frame.routingId } });
    event.returnValue = id;
  });

  // window.open returned: did a linked window open?
  ipcMain.on('popup-bridge:did-open', (event, id: unknown) => {
    if (announced.get(event.sender.id)?.id === id) announced.delete(event.sender.id);
    event.returnValue = fromGuest(event) && !!linkOpenedBy(event, id);
  });

  // postMessage. `id` names the window a page opened; null is the opener.
  ipcMain.on('popup-bridge:post', (event, id: unknown, data: unknown, targetOrigin: unknown) => {
    if (!fromGuest(event) || !event.senderFrame) return;
    const source = event.senderFrame.origin;
    if (id === null) {
      const link = linkOfPopup(event);
      const opener = link && frameOf(link.openerFrame);
      if (link && opener && originMatches(opener, targetOrigin, source)) {
        opener.send('popup-bridge:message', { id: link.id, data, origin: source });
      }
      return;
    }
    const link = linkOpenedBy(event, id);
    const popup = link && liveContents(link.popupWcId);
    if (popup && originMatches(popup.mainFrame, targetOrigin, source)) {
      popup.mainFrame.send('popup-bridge:message', { id: null, data, origin: source });
    }
  });

  // close(): the opener closing its window, or a window closing itself.
  ipcMain.on('popup-bridge:close', (event, id: unknown) => {
    if (!fromGuest(event)) return;
    const link = id === null ? linkOfPopup(event) : linkOpenedBy(event, id);
    if (!link) return;
    if (link.popupWcId === null) closeLink(link);
    else sendToShell('crx:removeTab', { wcId: link.popupWcId });
  });

  // focus(): bring the other page's tab forward.
  ipcMain.on('popup-bridge:focus', (event, id: unknown) => {
    if (!fromGuest(event)) return;
    if (id === null) {
      const link = linkOfPopup(event);
      if (link) sendToShell('crx:selectTab', { wcId: link.openerWcId });
      return;
    }
    const link = linkOpenedBy(event, id);
    if (link?.popupWcId != null) sendToShell('crx:selectTab', { wcId: link.popupWcId });
  });

  // Setting the location of a window the page opened.
  ipcMain.on('popup-bridge:navigate', (event, id: unknown, rawUrl: unknown) => {
    const link = fromGuest(event) ? linkOpenedBy(event, id) : null;
    const url = webUrl(rawUrl);
    if (!link || !url) return;
    const popup = liveContents(link.popupWcId);
    if (popup) {
      popup.loadURL(url).catch(() => {});
    } else if (!link.pendingUrl) {
      // Opened as about:blank: the tab opens now, where it's going.
      link.pendingUrl = url;
      expireUnattached(link);
      sendToShell('crx:openTab', { url, openerWcId: link.openerWcId });
    }
  });
}

// --- Wiring ------------------------------------------------------------------

/** Track a web guest's presses, its blocked pop-ups, and the windows it opened. */
export function attachPopups(contents: Electron.WebContents): void {
  const pressed = () => activations.set(contents.id, Date.now());
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') pressed();
  });
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key !== 'Escape') pressed();
  });
  contents.on('input-event', (_event, input) => {
    if (input.type === 'touchEnd' || input.type === 'gestureTap') pressed();
  });
  contents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    if (!blocked.has(contents.id)) return;
    blocked.delete(contents.id);
    sendToShell('popups:blocked', { wcId: contents.id, urls: [] });
  });
  contents.once('destroyed', () => {
    activations.delete(contents.id);
    blocked.delete(contents.id);
    announced.delete(contents.id);
    for (const link of [...links.values()]) {
      if (link.openerWcId !== contents.id) continue;
      links.delete(link.id);
      liveContents(link.popupWcId)?.mainFrame.send('popup-bridge:closed', { id: null });
    }
  });
}

export function setupPopups(options: {
  /** Sessions whose pages get window.opener and the window.open stand-in. */
  sessions: Electron.Session[];
  /** Web content guests: browser tabs and installed apps. */
  isWebGuest: (contents: Electron.WebContents) => boolean;
  assertShellSender: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  sendToShell = options.sendToShell;
  isWebGuest = options.isWebGuest;
  const { assertShellSender } = options;

  loadSettings();
  for (const s of options.sessions) {
    s.registerPreloadScript({ id: 'din-popups', type: 'frame', filePath: PRELOAD });
  }
  registerBridge();

  ipcMain.handle('popups:getSettings', (event) => {
    assertShellSender(event);
    return settings();
  });
  ipcMain.handle('popups:setSiteAllowed', (event, hostname: unknown, allowed: unknown) => {
    assertShellSender(event);
    if (typeof hostname !== 'string' || !/^[a-z0-9.:[\]-]{1,253}$/i.test(hostname)) {
      throw new Error('Invalid hostname');
    }
    if (allowed === true) allowlist.add(hostname.toLowerCase());
    else allowlist.delete(hostname.toLowerCase());
    saveSettings();
  });
  ipcMain.handle('popups:blocked', (event, wcId: unknown) => {
    assertShellSender(event);
    return typeof wcId === 'number' ? (blocked.get(wcId) ?? []) : [];
  });
}
