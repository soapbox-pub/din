// Notifications from outside the shell, for its notification center
// (src/lib/notificationCenter.ts).
//
// Linux apps' arrive over D-Bus, at the server in notification-server.mts (in
// the services host: see there for why). This side works out which installed
// app sent each one, turns its icon and image into data URLs the shell can
// show, strips the body's markup to plain text, and hands it to the shell.
// The user's clicks and dismissals go back the same way, as the
// ActionInvoked and NotificationClosed signals.
//
// Web pages' come from notification-preload.cjs, in every browser tab and
// installed web app. Only a top document whose origin the user allowed to
// notify (asked in the shell, see hardenGuestSession in main.mts) gets one
// shown; its icon is fetched here, in the page's own session. Clicks and
// closes go back to the page as its Notification's events, and its
// notifications go when the page does.
//
// Installed nsites' come from napp.mts (their pages' and service workers'
// registration.showNotification). They outlive the page; clicks and
// dismissals go back to napp.mts, which raises them in the site's worker.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { fileURLToPath } from 'node:url';
import { ipcMain, nativeImage } from 'electron';
import { appIdForPid, resolveIcon } from './native-apps.mts';
import { sessionBusAddress } from './native-display.mts';
import type { RawImage, ServerCommand, ServerMessage } from './notification-server.mts';
import { startService, type Service } from './services.mts';

/** Images are shown at 40px; this covers 2x displays with room. */
const IMAGE_TARGET = 96;
const MAX_IMAGE_BYTES = 512 * 1024;

/** A notification as the shell gets it. */
export interface SystemNotification {
  /** Opaque, unique while it lives ("dbus:12"). */
  id: string;
  appName: string;
  /** The installed app it belongs to, when known. */
  appId: string | null;
  /** The sender's icon, as a data URL. */
  icon: string | null;
  /** A picture to show beside the text, as a data URL. */
  image: string | null;
  title: string;
  body: string;
  actions: { id: string; label: string }[];
  urgency: 'low' | 'normal' | 'critical';
  /** How long it stays up, in ms; -1 is the shell's choice, 0 until dismissed. */
  timeout: number;
  /** Acting on it doesn't remove it. */
  resident: boolean;
  /** Not kept in the list once it's gone from the screen. */
  transient: boolean;
  /**
   * For a web page's: the guest it came from, and whether its permission is
   * the one Settings shows (not a private window's or Tor's).
   */
  guest: { webContentsId: number; origin: string; remembered: boolean } | null;
  /** A web page's tag: one with the same tag and origin replaces it. */
  tag: string;
  /**
   * For an installed nsite's (napp.mts): its host, and where a click opens
   * it (its `data.url`, already checked to be on the site), or null for its
   * front page.
   */
  site: { host: string; url: string | null } | null;
}

type CloseReason = 'expired' | 'dismissed' | 'closed';

const REASON_CODES: Record<CloseReason, 1 | 2 | 3> = { expired: 1, dismissed: 2, closed: 3 };

let server: Service | null = null;
let sendToShell: (channel: string, payload?: unknown) => void = () => {};

async function startServer(): Promise<void> {
  const address = await sessionBusAddress();
  if (!address) return;
  const service = startService<ServerMessage>('notifications', { busAddress: address }, {
    onMessage: (message) => {
      if (message.type === 'notify') void show(message);
      else if (message.type === 'close') sendToShell('notifications:close', `dbus:${message.id}`);
    },
    onExit: () => {
      if (server !== service) return;
      server = null;
      setTimeout(() => void startServer(), 5_000);
    },
  });
  server = service;
}

function command(message: ServerCommand): void {
  server?.postMessage(message);
}

async function show(message: Extract<ServerMessage, { type: 'notify' }>): Promise<void> {
  const appId = appIdForPid(message.pid) ?? (message.desktopEntry ? `native:${message.desktopEntry}` : null);
  const [icon, image] = await Promise.all([
    iconFrom(message.appIcon),
    message.image ? Promise.resolve(rawImageDataUrl(message.image)) : iconFrom(message.imagePath),
  ]);
  const notification: SystemNotification = {
    id: `dbus:${message.id}`,
    appName: message.appName,
    appId,
    icon,
    image,
    title: plainText(message.summary),
    body: plainText(message.body),
    actions: message.actions.map(([id, label]) => ({ id, label: plainText(label) || id })),
    urgency: (['low', 'normal', 'critical'] as const)[message.urgency],
    timeout: message.timeout,
    resident: message.resident,
    transient: message.transient,
    guest: null,
    tag: '',
    site: null,
  };
  sendToShell('notifications:show', notification);
}

/** A notification from DinOS itself, for the notification center. */
export function notifyFromSystem(key: string, title: string, body: string): void {
  const notification: SystemNotification = {
    id: `din:${key}`,
    appName: 'DinOS',
    appId: null,
    icon: null,
    image: null,
    title,
    body,
    actions: [],
    urgency: 'normal',
    timeout: -1,
    resident: false,
    transient: false,
    guest: null,
    tag: '',
    site: null,
  };
  sendToShell('notifications:show', notification);
}

/** An icon name, absolute path or file:// URI, as a data URL. */
async function iconFrom(icon: string): Promise<string | null> {
  if (!icon) return null;
  let name = icon;
  if (icon.startsWith('file://')) {
    try {
      name = fileURLToPath(icon);
    } catch {
      return null;
    }
  }
  return resolveIcon(name).catch(() => null);
}

/** An image hint's pixels (RGB or RGBA rows) as a PNG data URL. */
function rawImageDataUrl(raw: RawImage): string | null {
  const { width, height, rowstride, hasAlpha, channels, data } = raw;
  // RGB(A), straight alpha -> Skia's BGRA, premultiplied.
  const bgra = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = y * rowstride + x * channels;
      const to = (y * width + x) * 4;
      const a = hasAlpha ? data[from + 3] : 255;
      bgra[to] = Math.round((data[from + 2] * a) / 255);
      bgra[to + 1] = Math.round((data[from + 1] * a) / 255);
      bgra[to + 2] = Math.round((data[from] * a) / 255);
      bgra[to + 3] = a;
    }
  }
  let image = nativeImage.createFromBitmap(bgra, { width, height });
  if (image.isEmpty()) return null;
  if (Math.max(width, height) > IMAGE_TARGET) {
    image = image.resize(width >= height ? { width: IMAGE_TARGET } : { height: IMAGE_TARGET });
  }
  const png = image.toPNG();
  return png.length <= MAX_IMAGE_BYTES ? `data:image/png;base64,${png.toString('base64')}` : null;
}

/** Body markup (<b>, <i>, <a>, <img>, entities) as plain text. */
function plainText(markup: string): string {
  return markup
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, code: string) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&amp;/g, '&')
    .trim();
}

// ---------------------------------------------------------------------------
// Web pages
// ---------------------------------------------------------------------------

/** Past these, a page's notification is abuse. */
const MAX_WEB_TITLE = 256;
const MAX_WEB_BODY = 4096;
const MAX_WEB_PER_PAGE = 32;
const MAX_FETCHED_ICON_BYTES = 2 * 1024 * 1024;
const ICON_FETCH_TIMEOUT_MS = 5_000;

/** A web page's notification, by the number the page knows it by. */
const webNotifications = new Map<number, Electron.WebContents>();
let lastWebId = 0;
/** Guests already watched for going away. */
const watchedGuests = new WeakSet<Electron.WebContents>();

function webText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * A page's icon as a data URL, fetched in its own session (its cookies,
 * its nsite:// handler). Images are scaled down; SVG stays SVG, which an
 * <img> never runs scripts in. A data: URL is taken whole or not at all:
 * cut short, it decodes as just the picture's top rows.
 */
async function fetchIcon(s: Electron.Session, url: string, credentials: RequestCredentials = 'include'): Promise<string | null> {
  if (!/^(https?|nsite):/i.test(url)) {
    return /^data:image\/[a-z0-9.+-]+[;,]/i.test(url) && url.length <= MAX_IMAGE_BYTES ? url : null;
  }
  if (url.length > 4096) return null;
  try {
    const response = await s.fetch(url, { credentials, signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS) });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_FETCHED_ICON_BYTES) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_FETCHED_ICON_BYTES) return null;
    if ((response.headers.get('content-type') ?? '').startsWith('image/svg+xml')) {
      return data.length <= MAX_IMAGE_BYTES ? `data:image/svg+xml;base64,${data.toString('base64')}` : null;
    }
    let image = nativeImage.createFromBuffer(data);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    if (Math.max(width, height) > IMAGE_TARGET) {
      image = image.resize(width >= height ? { width: IMAGE_TARGET } : { height: IMAGE_TARGET });
    }
    const png = image.toPNG();
    return png.length <= MAX_IMAGE_BYTES ? `data:image/png;base64,${png.toString('base64')}` : null;
  } catch {
    return null;
  }
}

/** Tell a page one of its notifications was clicked or closed. */
function webEvent(id: number, type: 'click' | 'close'): void {
  const contents = webNotifications.get(id);
  if (!contents) return;
  if (type === 'close') webNotifications.delete(id);
  if (!contents.isDestroyed()) contents.send('notifications:web-event', id, type);
}

/** A page went away (closed, or navigated): so do its notifications. */
function dropGuest(contents: Electron.WebContents): void {
  for (const [id, owner] of webNotifications) {
    if (owner !== contents) continue;
    webNotifications.delete(id);
    sendToShell('notifications:close', `web:${id}`);
  }
}

/** The top document of a web guest, or null for anything else. */
function guestOrigin(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): string | null {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || event.sender.getType() !== 'webview') return null;
  return frame.origin && frame.origin !== 'null' ? frame.origin : null;
}

function registerWebHandlers(
  permission: (s: Electron.Session, origin: string) => NotificationPermission,
  remembered: (s: Electron.Session) => boolean,
): void {
  ipcMain.on('notifications:web-permission', (event) => {
    const origin = guestOrigin(event);
    event.returnValue = origin ? permission(event.sender.session, origin) : 'denied';
  });

  ipcMain.handle('notifications:web-show', async (event, options) => {
    const contents = event.sender;
    const origin = guestOrigin(event);
    if (!origin || permission(contents.session, origin) !== 'granted') return null;
    if ([...webNotifications.values()].filter((owner) => owner === contents).length >= MAX_WEB_PER_PAGE) return null;
    const opts = typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {};
    const icon = await fetchIcon(contents.session, typeof opts.icon === 'string' ? opts.icon : '');
    if (contents.isDestroyed()) return null;

    const id = ++lastWebId;
    webNotifications.set(id, contents);
    if (!watchedGuests.has(contents)) {
      watchedGuests.add(contents);
      contents.once('destroyed', () => dropGuest(contents));
      contents.on('did-navigate', () => dropGuest(contents));
    }
    const notification: SystemNotification = {
      id: `web:${id}`,
      appName: new URL(origin).host,
      appId: null,
      icon: null,
      image: icon,
      title: webText(opts.title, MAX_WEB_TITLE),
      body: webText(opts.body, MAX_WEB_BODY),
      actions: [],
      urgency: 'normal',
      timeout: opts.requireInteraction === true ? 0 : -1,
      resident: false,
      transient: false,
      guest: { webContentsId: contents.id, origin, remembered: remembered(contents.session) },
      tag: webText(opts.tag, 256),
      site: null,
    };
    sendToShell('notifications:show', notification);
    return id;
  });

  ipcMain.on('notifications:web-close', (event, id) => {
    if (typeof id === 'number' && webNotifications.get(id) === event.sender) {
      sendToShell('notifications:close', `web:${id}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Installed nsites (napp.mts)
// ---------------------------------------------------------------------------

/** What napp.mts hears back about the notifications it showed. */
export interface SiteNotificationHandlers {
  activate: (id: number, action: string) => void;
  closed: (id: number, reason: CloseReason) => void;
}

let siteHandlers: SiteNotificationHandlers | null = null;

export function setSiteNotificationHandlers(handlers: SiteNotificationHandlers): void {
  siteHandlers = handlers;
}

/**
 * Show an installed nsite's notification (from its page or its service
 * worker; napp.mts has checked it may). The icon is fetched without
 * cookies: a site's own path through its nsite:// handler, or an https URL.
 */
export async function showSiteNotification(
  s: Electron.Session,
  notification: {
    id: number;
    host: string;
    title: string;
    body: string;
    icon: string;
    tag: string;
    actions: { action: string; title: string }[];
    requireInteraction: boolean;
    silent: boolean;
    url: string | null;
  },
): Promise<void> {
  const image = notification.icon ? await fetchIcon(s, notification.icon, 'omit') : null;
  const shown: SystemNotification = {
    id: `napp:${notification.id}`,
    appName: notification.host,
    appId: null,
    icon: null,
    image,
    title: notification.title.slice(0, MAX_WEB_TITLE),
    body: notification.body.slice(0, MAX_WEB_BODY),
    actions: notification.actions.slice(0, 3).map((a) => ({ id: a.action, label: a.title })),
    urgency: notification.silent ? 'low' : 'normal',
    timeout: notification.requireInteraction ? 0 : -1,
    resident: false,
    transient: false,
    guest: null,
    tag: notification.tag,
    site: { host: notification.host, url: notification.url },
  };
  sendToShell('notifications:show', shown);
}

/** Take down an installed nsite's notification. */
export function closeSiteNotification(id: number): void {
  sendToShell('notifications:close', `napp:${id}`);
}

/** The id behind an opaque shell id, by kind. */
function parseId(id: unknown): { kind: 'dbus' | 'web' | 'napp'; id: number } | null {
  if (typeof id !== 'string') return null;
  const match = /^(dbus|web|napp):(\d+)$/.exec(id);
  return match ? { kind: match[1] as 'dbus' | 'web' | 'napp', id: Number(match[2]) } : null;
}

/** Register the notifications IPC surface (window.systemNotifications) and start the server. */
export function registerNotificationHandlers(options: {
  isShellSender: (event: Electron.IpcMainEvent) => boolean;
  sendToShell: (channel: string, payload?: unknown) => void;
  /** Whether a site may show notifications, as the user answered. */
  webPermission: (s: Electron.Session, origin: string) => NotificationPermission;
  /** Whether a session's answers are the remembered ones. */
  remembersPermission: (s: Electron.Session) => boolean;
}): void {
  const { isShellSender } = options;
  sendToShell = options.sendToShell;

  ipcMain.on('notifications:activate', (event, id, action) => {
    const target = parseId(id);
    if (!isShellSender(event) || !target || typeof action !== 'string') return;
    if (target.kind === 'dbus') command({ type: 'action', id: target.id, key: action.slice(0, 256) });
    else if (target.kind === 'napp') siteHandlers?.activate(target.id, action.slice(0, 256));
    else if (action === 'default') webEvent(target.id, 'click');
  });
  ipcMain.on('notifications:closed', (event, id, reason) => {
    const target = parseId(id);
    if (!isShellSender(event) || !target) return;
    if (target.kind === 'dbus') command({ type: 'closed', id: target.id, reason: REASON_CODES[reason as CloseReason] ?? 4 });
    else if (target.kind === 'napp') siteHandlers?.closed(target.id, reason in REASON_CODES ? (reason as CloseReason) : 'closed');
    else webEvent(target.id, 'close');
  });

  registerWebHandlers(options.webPermission, options.remembersPermission);
  void startServer();
}
