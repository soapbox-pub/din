// The system tray: apps' status icons (StatusNotifierItem), in Din's menu bar.
//
// Apps that live in a tray - chat clients, sync clients, Steam - publish a
// StatusNotifierItem on the session bus and register it with whoever owns
// org.kde.StatusNotifierWatcher. Din owns that name when nobody else does
// (DinOS; a bare X11 session), so every app's item comes here. Inside a
// desktop that already has a tray (KDE, GNOME with the AppIndicator
// extension), Din registers as one more host of that watcher instead, and
// shows the items of the apps it launched - the others belong to that
// desktop's tray.
//
// Items are drawn by the shell (src/components/desktop/TrayMenu.tsx): their
// icons as images, their menus (com.canonical.dbusmenu) as Din menus. Clicks
// go back to the app as Activate/ContextMenu/menu events.
//
// The old XEmbed tray (_NET_SYSTEM_TRAY), the only one Wine speaks, is
// hosted by the compositor on Xwayland (native/din-compositor/src/tray.rs),
// which sends each icon's pixels here; its items are listed with the
// rest, and a click on one goes back as the X click a real tray would give
// it, where the user clicked, so a Windows program's own menu opens there.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain, nativeImage } from 'electron';
import { DBusConnection, DBusError, unwrap, Variant, type MethodCall, type Message } from './dbus.mts';
import { resolveIcon } from './icon-theme.mts';
import { appIdForPid } from './native-apps.mts';
import { clickXTray, onXTray, sessionBusAddress, type XTrayMessage } from './native-display.mts';

const WATCHER = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const ITEM = 'org.kde.StatusNotifierItem';
const DEFAULT_ITEM_PATH = '/StatusNotifierItem';
const MENU = 'com.canonical.dbusmenu';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

/** RequestName: fail rather than queue; reply 1 is "now the owner". */
const DO_NOT_QUEUE = 4;
const PRIMARY_OWNER = 1;

/** Tray icons are drawn at 18px; this covers 2x displays with room. */
const ICON_TARGET = 48;
/** Largest pixmap or icon file taken, and largest data URL handed on. */
const MAX_PIXMAP_SIDE = 512;
const MAX_ICON_BYTES = 256 * 1024;
/** Items per session, and menu entries per menu: past these it's abuse. */
const MAX_ITEMS = 64;
const MAX_MENU_ENTRIES = 500;
const MAX_MENU_DEPTH = 8;
const MAX_TEXT = 256;

/** An item as the shell sees it. */
export interface TrayItem {
  /** Opaque id ("bus" or "bus/path"), as registered with the watcher. */
  id: string;
  /** The installed app it belongs to, when known. */
  appId: string | null;
  title: string;
  tooltip: string;
  status: 'Passive' | 'Active' | 'NeedsAttention';
  /** Data URL, or null when the item has no icon Din can show. */
  icon: string | null;
  /** The item has a menu (dbusmenu). */
  menu: boolean;
  /** The item is only a menu: a click opens it rather than activating. */
  itemIsMenu: boolean;
}

/** One entry of an item's menu. */
export interface TrayMenuEntry {
  id: number;
  type: 'standard' | 'separator';
  label: string;
  enabled: boolean;
  toggle: 'checkmark' | 'radio' | null;
  checked: boolean;
  icon: string | null;
  children: TrayMenuEntry[];
}

interface Item {
  key: string;
  /** Unique bus name of the app's connection. */
  owner: string;
  path: string;
  menuPath: string | null;
  public: TrayItem;
  unsubscribe: () => void;
  /** The menu's change signals, while it has one. */
  unsubscribeMenu: () => void;
  refreshTimer: NodeJS.Timeout | null;
}

let bus: DBusConnection | null = null;
/** Whether Din owns the watcher name (else it's a host of someone else's). */
let isWatcher = false;
/** Registration order is display order. */
const items = new Map<string, Item>();
let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let changedTimer: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/** Connect, and become the watcher or a host. Retries if the bus goes away. */
async function start(): Promise<void> {
  const connection = await DBusConnection.connect(await sessionBusAddress());
  if (!connection) return;
  bus = connection;
  connection.onClose = () => {
    if (bus !== connection) return;
    bus = null;
    isWatcher = false;
    for (const item of items.values()) dropItem(item);
    items.clear();
    changed();
    setTimeout(() => void start(), 5_000);
  };

  connection.subscribe(
    { sender: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged' },
    onNameOwnerChanged,
  );
  connection.export(WATCHER_PATH, answerWatcher);
  // Hosts are announced by name; the watcher's own host needs none, but a
  // name of ours costs nothing and some apps look for one.
  await connection.bus('RequestName', 'su', [`org.kde.StatusNotifierHost-${process.pid}`, DO_NOT_QUEUE]).catch(() => {});
  await becomeWatcherOrHost();
}

async function becomeWatcherOrHost(): Promise<void> {
  const connection = bus;
  if (!connection) return;
  const [reply] = await connection.bus('RequestName', 'su', [WATCHER, DO_NOT_QUEUE]).catch(() => [0]);
  if (reply === PRIMARY_OWNER) {
    isWatcher = true;
    // Apps that came up before Din wait for this to register.
    connection.emit(WATCHER_PATH, WATCHER, 'StatusNotifierHostRegistered');
    return;
  }
  isWatcher = false;
  const [owner] = await connection.bus('GetNameOwner', 's', [WATCHER]).catch(() => [null]);
  if (typeof owner !== 'string') return;
  connection.subscribe({ sender: owner, path: WATCHER_PATH, interface: WATCHER }, (message) => {
    const key = message.body[0];
    if (typeof key !== 'string') return;
    if (message.member === 'StatusNotifierItemRegistered') void addItem(key, null);
    else if (message.member === 'StatusNotifierItemUnregistered') removeItem(key);
  });
  await connection
    .call({
      destination: WATCHER,
      path: WATCHER_PATH,
      interface: WATCHER,
      member: 'RegisterStatusNotifierHost',
      signature: 's',
      body: [`org.kde.StatusNotifierHost-${process.pid}`],
    })
    .catch(() => {});
  const [registered] = await connection
    .call({
      destination: WATCHER,
      path: WATCHER_PATH,
      interface: PROPERTIES,
      member: 'Get',
      signature: 'ss',
      body: [WATCHER, 'RegisteredStatusNotifierItems'],
    })
    .catch(() => [null]);
  const keys = unwrap(registered);
  if (Array.isArray(keys)) for (const key of keys) if (typeof key === 'string') void addItem(key, null);
}

function onNameOwnerChanged(message: Message): void {
  const [name, , next] = message.body as [string, string, string];
  if (next) return;
  // An app left the bus: its items go with it.
  for (const item of [...items.values()]) if (item.owner === name) removeItem(item.key);
  // The desktop's tray went away (its shell restarted, say): Din takes over.
  if (name === WATCHER && !isWatcher) {
    for (const item of items.values()) dropItem(item);
    items.clear();
    changed();
    void becomeWatcherOrHost();
  }
}

// ---------------------------------------------------------------------------
// The watcher, when Din is it
// ---------------------------------------------------------------------------

const WATCHER_XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${WATCHER}">
    <method name="RegisterStatusNotifierItem"><arg name="service" type="s" direction="in"/></method>
    <method name="RegisterStatusNotifierHost"><arg name="service" type="s" direction="in"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
    <method name="GetAll"><arg type="s" direction="in"/><arg type="a{sv}" direction="out"/></method>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg type="s" direction="out"/></method>
  </interface>
</node>`;

function watcherProperties(): Map<string, Variant> {
  return new Map([
    ['RegisteredStatusNotifierItems', new Variant('as', [...items.keys()])],
    ['IsStatusNotifierHostRegistered', new Variant('b', true)],
    ['ProtocolVersion', new Variant('i', 0)],
  ]);
}

async function answerWatcher(call: MethodCall): Promise<[string, unknown[]] | void> {
  if (call.interface === 'org.freedesktop.DBus.Introspectable' && call.member === 'Introspect') {
    return ['s', [WATCHER_XML]];
  }
  if (call.interface === PROPERTIES) {
    if (call.body[0] !== WATCHER) throw new DBusError('org.freedesktop.DBus.Error.UnknownInterface', 'No such interface');
    if (call.member === 'GetAll') return ['a{sv}', [watcherProperties()]];
    if (call.member === 'Get') {
      const value = watcherProperties().get(String(call.body[1]));
      if (!value) throw new DBusError('org.freedesktop.DBus.Error.UnknownProperty', 'No such property');
      return ['v', [value]];
    }
  }
  if (call.interface === WATCHER || call.interface === '') {
    if (call.member === 'RegisterStatusNotifierHost') return;
    if (call.member === 'RegisterStatusNotifierItem' && typeof call.body[0] === 'string') {
      const service = call.body[0];
      // An object path means "on my own connection"; else it's a bus name
      // with the item at the default path.
      const key = service.startsWith('/') ? call.sender + service : service;
      await addItem(key, call.sender);
      return;
    }
  }
  throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', `No method ${call.member}`);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Split a registered item into its bus name and object path. */
function parseKey(key: string): { name: string; path: string } {
  const slash = key.indexOf('/');
  return slash < 0 ? { name: key, path: DEFAULT_ITEM_PATH } : { name: key.slice(0, slash), path: key.slice(slash) };
}

/**
 * Start tracking an item. `sender` is who registered it (watcher mode). The
 * item is read after this returns: an app may be blocked on its register
 * call, and would never answer.
 */
async function addItem(key: string, sender: string | null): Promise<void> {
  const connection = bus;
  if (!connection || items.has(key) || items.size >= MAX_ITEMS) return;
  const { name, path: objectPath } = parseKey(key);
  if (!name || !/^\/[\w/]*$/.test(objectPath)) {
    if (sender) throw new DBusError('org.freedesktop.DBus.Error.InvalidArgs', 'Bad item');
    return;
  }
  const [owner] = await connection.bus('GetNameOwner', 's', [name]).catch(() => [null]);
  if (typeof owner !== 'string') {
    if (sender) throw new DBusError('org.freedesktop.DBus.Error.ServiceUnknown', `${name} isn't on the bus`);
    return;
  }
  const [pid] = await connection.bus('GetConnectionUnixProcessID', 's', [owner]).catch(() => [null]);
  const appId = typeof pid === 'number' ? appIdForPid(pid) : null;
  // A host of another desktop's tray shows only the apps Din launched.
  if (!isWatcher && !appId) return;
  if (items.has(key) || bus !== connection) return;

  const item: Item = {
    key,
    owner,
    path: objectPath,
    menuPath: null,
    public: { id: key, appId, title: '', tooltip: '', status: 'Active', icon: null, menu: false, itemIsMenu: false },
    unsubscribe: () => {},
    unsubscribeMenu: () => {},
    refreshTimer: null,
  };
  items.set(key, item);
  // NewIcon, NewTitle, NewStatus, NewToolTip, ...: re-read everything.
  item.unsubscribe = connection.subscribe({ sender: owner, path: objectPath, interface: ITEM }, () =>
    scheduleRefresh(item),
  );
  if (isWatcher) connection.emit(WATCHER_PATH, WATCHER, 'StatusNotifierItemRegistered', 's', [key]);
  setImmediate(() => void refresh(item));
}

function dropItem(item: Item): void {
  item.unsubscribe();
  item.unsubscribeMenu();
  if (item.refreshTimer) clearTimeout(item.refreshTimer);
}

function removeItem(key: string): void {
  const item = items.get(key);
  if (!item) return;
  items.delete(key);
  dropItem(item);
  if (isWatcher) bus?.emit(WATCHER_PATH, WATCHER, 'StatusNotifierItemUnregistered', 's', [key]);
  changed();
}

/** Apps send several New* signals at once; read the item once for them. */
function scheduleRefresh(item: Item): void {
  if (item.refreshTimer) return;
  item.refreshTimer = setTimeout(() => {
    item.refreshTimer = null;
    void refresh(item);
  }, 50);
}

/** Read an item's properties into its public record. */
async function refresh(item: Item): Promise<void> {
  const connection = bus;
  if (!connection) return;
  const [all] = await connection
    .call({ destination: item.owner, path: item.path, interface: PROPERTIES, member: 'GetAll', signature: 's', body: [ITEM] })
    .catch(() => [null]);
  if (!(all instanceof Map) || items.get(item.key) !== item) return;
  const prop = (name: string) => unwrap(all.get(name));
  const text = (name: string) => {
    const value = prop(name);
    return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
  };

  const status = text('Status');
  const attention = status === 'NeedsAttention';
  const themePath = text('IconThemePath');
  const icon =
    (attention ? await iconFrom(text('AttentionIconName'), prop('AttentionIconPixmap'), themePath) : null) ??
    (await iconFrom(text('IconName'), prop('IconPixmap'), themePath));

  const tooltip = prop('ToolTip');
  let tooltipText = '';
  if (Array.isArray(tooltip)) {
    const [, , title, body] = tooltip as unknown[];
    tooltipText = [title, body]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .map(plainText)
      .join('\n')
      .slice(0, MAX_TEXT);
  }

  const menuPath = prop('Menu');
  const nextMenu = typeof menuPath === 'string' && menuPath !== '/' && menuPath.startsWith('/') ? menuPath : null;
  if (nextMenu !== item.menuPath) {
    item.unsubscribeMenu();
    item.unsubscribeMenu = () => {};
    item.menuPath = nextMenu;
    if (nextMenu) {
      // An open menu re-reads itself when the app changes it.
      item.unsubscribeMenu = connection.subscribe({ sender: item.owner, path: nextMenu, interface: MENU }, (message) => {
        if (message.member === 'LayoutUpdated' || message.member === 'ItemsPropertiesUpdated') {
          sendToShell('tray:menu-changed', item.key);
        }
      });
    }
  }
  item.public = {
    ...item.public,
    title: text('Title') || text('Id'),
    tooltip: tooltipText,
    status: status === 'Passive' || attention ? status : 'Active',
    icon,
    menu: item.menuPath !== null,
    itemIsMenu: prop('ItemIsMenu') === true,
  };
  changed();
}

/** Tooltips may carry a little HTML markup; Din shows plain text. */
function plainText(markup: string): string {
  return markup
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** An item's icon: by name (its own theme path first), else its pixmaps. */
async function iconFrom(name: string, pixmaps: unknown, themePath: string): Promise<string | null> {
  if (name) {
    const own = themePath ? iconInThemePath(themePath, name) : null;
    const url = own ?? (await resolveIcon(name).catch(() => null));
    if (url) return url;
  }
  return pixmapDataUrl(pixmaps);
}

/**
 * Look an icon up in the directory an item names. Chromium-based apps write
 * their icon there under a fresh file name whenever it changes, so nothing
 * here is cached.
 */
function iconInThemePath(dir: string, name: string): string | null {
  if (!path.isAbsolute(dir) || name.includes('/')) return null;
  const candidates: string[] = [];
  const walk = (current: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && (entry.name === `${name}.png` || entry.name === `${name}.svg` || entry.name === name)) {
        candidates.push(full);
      }
    }
  };
  walk(dir, 0);
  // Several sizes: the biggest file is usually the biggest icon.
  const sized = candidates
    .map((file) => ({ file, size: fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0 }))
    .filter(({ size }) => size > 0 && size <= 4 * 1024 * 1024)
    .sort((a, b) => b.size - a.size);
  for (const { file } of sized) {
    const url = fileDataUrl(file);
    if (url) return url;
  }
  return null;
}

function fileDataUrl(file: string): string | null {
  try {
    if (file.endsWith('.svg')) {
      const data = fs.readFileSync(file);
      return data.length <= MAX_ICON_BYTES ? `data:image/svg+xml;base64,${data.toString('base64')}` : null;
    }
    let image = nativeImage.createFromPath(file);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    if (Math.max(width, height) > ICON_TARGET * 2) {
      image = image.resize(width >= height ? { width: ICON_TARGET * 2 } : { height: ICON_TARGET * 2 });
    }
    const png = image.toPNG();
    return png.length <= MAX_ICON_BYTES ? `data:image/png;base64,${png.toString('base64')}` : null;
  } catch {
    return null;
  }
}

/**
 * The best of an item's pixmaps (`a(iiay)`: width, height, ARGB32 in network
 * byte order) as a PNG data URL: the smallest at least ICON_TARGET wide,
 * else the largest.
 */
function pixmapDataUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const pixmaps = value
    .filter((entry): entry is [number, number, Buffer] => {
      if (!Array.isArray(entry)) return false;
      const [width, height, data] = entry as unknown[];
      return (
        typeof width === 'number' && typeof height === 'number' && Buffer.isBuffer(data) &&
        width > 0 && height > 0 && width <= MAX_PIXMAP_SIDE && height <= MAX_PIXMAP_SIDE &&
        data.length >= width * height * 4
      );
    })
    .sort((a, b) => a[0] - b[0]);
  const best = pixmaps.find(([width]) => width >= ICON_TARGET) ?? pixmaps[pixmaps.length - 1];
  if (!best) return null;
  const [width, height, data] = best;
  // ARGB, straight alpha -> Skia's BGRA, premultiplied.
  const bgra = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bgra.length; i += 4) {
    const a = data[i];
    bgra[i] = Math.round((data[i + 3] * a) / 255);
    bgra[i + 1] = Math.round((data[i + 2] * a) / 255);
    bgra[i + 2] = Math.round((data[i + 1] * a) / 255);
    bgra[i + 3] = a;
  }
  let image = nativeImage.createFromBitmap(bgra, { width, height });
  if (image.isEmpty()) return null;
  if (width > ICON_TARGET * 2) image = image.resize({ width: ICON_TARGET * 2 });
  const png = image.toPNG();
  return png.length <= MAX_ICON_BYTES ? `data:image/png;base64,${png.toString('base64')}` : null;
}

// ---------------------------------------------------------------------------
// Menus (com.canonical.dbusmenu)
// ---------------------------------------------------------------------------

/** "_Open" -> "Open", "Save __as" -> "Save _as". */
function stripMnemonic(label: string): string {
  return label.replace(/__|_/g, (match) => (match === '__' ? '_' : ''));
}

async function menuOf(item: Item): Promise<TrayMenuEntry[] | null> {
  const connection = bus;
  if (!connection || !item.menuPath) return null;
  const target = { destination: item.owner, path: item.menuPath, interface: MENU };
  // Apps fill some menus in lazily, when told they're about to show.
  await connection.call({ ...target, member: 'AboutToShow', signature: 'i', body: [0], timeout: 2_000 }).catch(() => {});
  const reply = await connection
    .call({ ...target, member: 'GetLayout', signature: 'iias', body: [0, -1, []] })
    .catch(() => null);
  const layout = reply?.[1];
  if (!Array.isArray(layout)) return null;
  let budget = MAX_MENU_ENTRIES;
  const icons: Promise<void>[] = [];

  const convert = (node: unknown, depth: number): TrayMenuEntry | null => {
    if (!Array.isArray(node) || budget <= 0) return null;
    const [id, props, children] = node as [unknown, unknown, unknown];
    if (typeof id !== 'number' || !(props instanceof Map)) return null;
    const prop = (name: string) => unwrap(props.get(name));
    if (prop('visible') === false) return null;
    budget -= 1;
    const toggle = prop('toggle-type');
    const iconName = prop('icon-name');
    const iconData = prop('icon-data');
    const entry: TrayMenuEntry = {
      id,
      type: prop('type') === 'separator' ? 'separator' : 'standard',
      label: typeof prop('label') === 'string' ? stripMnemonic(prop('label') as string).slice(0, MAX_TEXT) : '',
      enabled: prop('enabled') !== false,
      toggle: toggle === 'checkmark' || toggle === 'radio' ? toggle : null,
      checked: prop('toggle-state') === 1,
      icon: null,
      children: [],
    };
    if (Buffer.isBuffer(iconData) && iconData.length <= MAX_ICON_BYTES && iconData.subarray(0, 4).toString('latin1') === '\x89PNG') {
      entry.icon = `data:image/png;base64,${iconData.toString('base64')}`;
    } else if (typeof iconName === 'string' && iconName) {
      icons.push(resolveIcon(iconName).then((url) => void (entry.icon = url)).catch(() => {}));
    }
    if (Array.isArray(children) && depth < MAX_MENU_DEPTH) {
      for (const child of children) {
        const converted = convert(unwrap(child), depth + 1);
        if (converted) entry.children.push(converted);
      }
    }
    return entry;
  };

  const root = convert(layout, 0);
  await Promise.all(icons);
  return root?.children ?? [];
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

function list(): TrayItem[] {
  return [...[...items.values()].map((item) => item.public), ...xItems.values()];
}

// ---------------------------------------------------------------------------
// The X tray's icons
// ---------------------------------------------------------------------------

/** Their items, by key ("x11:<window>"), as the compositor reports them. */
const xItems = new Map<string, TrayItem>();
const X_PREFIX = 'x11:';

function onXTrayMessage(message: XTrayMessage): void {
  if (message.type === 'tray-reset') {
    if (xItems.size === 0) return;
    xItems.clear();
    changed();
    return;
  }
  const key = `${X_PREFIX}${message.tray}`;
  if (message.type === 'tray-gone') {
    if (xItems.delete(key)) changed();
    return;
  }
  const { width, height } = message;
  const pixels = Buffer.from(message.bgra, 'base64');
  if (width < 1 || height < 1 || width > MAX_PIXMAP_SIDE || height > MAX_PIXMAP_SIDE || pixels.length !== width * height * 4) return;
  if (!xItems.has(key) && items.size + xItems.size >= MAX_ITEMS) return;
  const icon = nativeImage.createFromBitmap(pixels, { width, height }).toDataURL();
  // Wine's explorer draws every Windows program's icon, so which program
  // one is for isn't known.
  const windows = message.class.toLowerCase() === 'explorer.exe';
  const title = windows ? 'Windows program' : message.class.slice(0, MAX_TEXT) || 'App';
  xItems.set(key, { id: key, appId: null, title, tooltip: title, status: 'Active', icon: icon.length <= MAX_ICON_BYTES * 2 ? icon : null, menu: false, itemIsMenu: false });
  changed();
}

/** Click an X tray icon: Activate is button 1, SecondaryActivate 2, ContextMenu 3. */
function clickX(key: string, button: number, x: unknown, y: unknown): boolean {
  if (!xItems.has(key)) return false;
  clickXTray(Number(key.slice(X_PREFIX.length)), button, int(x), int(y));
  return true;
}

/** Tell the shell, once per burst of changes. */
function changed(): void {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    sendToShell('tray:changed', list());
  }, 16);
}

/** Call a method on an item; resolves whether the app took it. */
async function callItem(key: unknown, member: string, signature: string, body: unknown[]): Promise<boolean> {
  if (typeof key === 'string' && key.startsWith(X_PREFIX)) {
    const button = { Activate: 1, SecondaryActivate: 2, ContextMenu: 3 }[member];
    return button !== undefined && clickX(key, button, body[0], body[1]);
  }
  const item = typeof key === 'string' ? items.get(key) : undefined;
  if (!item || !bus) return false;
  try {
    await bus.call({ destination: item.owner, path: item.path, interface: ITEM, member, signature, body, timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

/** Register the tray IPC surface (window.dinos.tray in the preload) and start it. */
export function registerTrayHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;

  ipcMain.handle('tray:list', (event) => {
    assertShellSender(event);
    return list();
  });
  // Coordinates are the click's, in the viewport - which is the screen the
  // apps see, so a menu an app pops up itself lands under the pointer.
  ipcMain.handle('tray:activate', (event, key, x, y) => {
    assertShellSender(event);
    return callItem(key, 'Activate', 'ii', [int(x), int(y)]);
  });
  ipcMain.handle('tray:secondaryActivate', (event, key, x, y) => {
    assertShellSender(event);
    return callItem(key, 'SecondaryActivate', 'ii', [int(x), int(y)]);
  });
  ipcMain.handle('tray:contextMenu', (event, key, x, y) => {
    assertShellSender(event);
    return callItem(key, 'ContextMenu', 'ii', [int(x), int(y)]);
  });
  ipcMain.handle('tray:scroll', (event, key, delta, orientation) => {
    assertShellSender(event);
    return callItem(key, 'Scroll', 'is', [int(delta), orientation === 'horizontal' ? 'horizontal' : 'vertical']);
  });
  ipcMain.handle('tray:menu', (event, key) => {
    assertShellSender(event);
    const item = typeof key === 'string' ? items.get(key) : undefined;
    return item ? menuOf(item) : null;
  });
  ipcMain.handle('tray:menuEvent', async (event, key, entryId) => {
    assertShellSender(event);
    const item = typeof key === 'string' ? items.get(key) : undefined;
    if (!item?.menuPath || !bus || typeof entryId !== 'number') return;
    await bus
      .call({
        destination: item.owner,
        path: item.menuPath,
        interface: MENU,
        member: 'Event',
        signature: 'isvu',
        body: [int(entryId), 'clicked', new Variant('i', 0), Math.floor(Date.now() / 1000) >>> 0],
        timeout: 3_000,
      })
      .catch(() => {});
  });

  onXTray(onXTrayMessage);
  // Up before the user can launch anything: apps look for a tray once, as
  // they start.
  void start();
  app.on('will-quit', () => bus?.close());
}
