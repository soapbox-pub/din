// Notifications from outside the shell, for its notification center
// (src/lib/notificationCenter.ts).
//
// Linux apps' arrive over D-Bus, at the server in notification-server.mts (a
// utility process: see there for why). This side works out which installed
// app sent each one, turns its icon and image into data URLs the shell can
// show, strips the body's markup to plain text, and hands it to the shell.
// The user's clicks and dismissals go back the same way, as the
// ActionInvoked and NotificationClosed signals.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, ipcMain, nativeImage, utilityProcess } from 'electron';
import { appIdForPid, resolveIcon } from './native-apps.mts';
import { sessionBusAddress } from './native-display.mts';
import type { RawImage, ServerCommand, ServerMessage } from './notification-server.mts';

const SERVER = path.join(import.meta.dirname, 'notification-server.mts');

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
}

type CloseReason = 'expired' | 'dismissed' | 'closed';

const REASON_CODES: Record<CloseReason, 1 | 2 | 3> = { expired: 1, dismissed: 2, closed: 3 };

let server: Electron.UtilityProcess | null = null;
let sendToShell: (channel: string, payload?: unknown) => void = () => {};

async function startServer(): Promise<void> {
  const address = await sessionBusAddress();
  if (!address) return;
  const child = utilityProcess.fork(SERVER, [], {
    serviceName: 'Din notifications',
    stdio: 'inherit',
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address },
  });
  server = child;
  child.on('message', (message: ServerMessage) => {
    if (message.type === 'notify') void show(message);
    else if (message.type === 'close') sendToShell('notifications:close', `dbus:${message.id}`);
  });
  child.once('exit', () => {
    if (server !== child) return;
    server = null;
    setTimeout(() => void startServer(), 5_000);
  });
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

/** Register the notifications IPC surface (window.systemNotifications) and start the server. */
export function registerNotificationHandlers(options: {
  isShellSender: (event: Electron.IpcMainEvent) => boolean;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { isShellSender } = options;
  sendToShell = options.sendToShell;

  ipcMain.on('notifications:activate', (event, id, action) => {
    if (!isShellSender(event) || typeof id !== 'string' || typeof action !== 'string') return;
    const dbusId = Number(id.startsWith('dbus:') ? id.slice(5) : NaN);
    if (Number.isInteger(dbusId)) command({ type: 'action', id: dbusId, key: action.slice(0, 256) });
  });
  ipcMain.on('notifications:closed', (event, id, reason) => {
    if (!isShellSender(event) || typeof id !== 'string') return;
    const code = REASON_CODES[reason as CloseReason] ?? 4;
    const dbusId = Number(id.startsWith('dbus:') ? id.slice(5) : NaN);
    if (Number.isInteger(dbusId)) command({ type: 'closed', id: dbusId, reason: code });
  });

  void startServer();
  app.on('will-quit', () => server?.kill());
}
