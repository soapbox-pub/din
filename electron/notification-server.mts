// The desktop's notification server (org.freedesktop.Notifications), in the
// services host (services.mts).
//
// Linux apps - Firefox, chat clients, `notify-send`, build tools - send
// notifications to whoever owns org.freedesktop.Notifications on the session
// bus. Din takes the name when nobody else has it (DinOS; a bare X11
// session), so they reach Din's notification center. Inside a desktop that
// has its own (GNOME, KDE), that one keeps them.
//
// Why not in the main process: Electron hands web notifications it shows
// itself (service workers', say) to libnotify, which calls Notify and waits
// for the answer on Electron's UI thread - the thread the main process's
// JavaScript runs on. A server there could never answer. This one answers
// from here, and the main process (notifications.mts) does the rest: works
// out which app sent each one, turns its icons into images, and shows it in
// the shell.
//
// Implements the 1.2 spec: Notify (with replaces_id, actions, the urgency,
// image and desktop-entry hints), CloseNotification, GetCapabilities,
// GetServerInformation, and the NotificationClosed and ActionInvoked signals.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { DBusConnection, DBusError, unwrap, type MethodCall } from './dbus.mts';

const NAME = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';
const IFACE = 'org.freedesktop.Notifications';

/** RequestName: fail rather than queue; reply 1 is "now the owner". */
const DO_NOT_QUEUE = 4;
const PRIMARY_OWNER = 1;

/** Past these, a notification is abuse: text is cut and images dropped. */
const MAX_TEXT = 4096;
const MAX_ACTIONS = 8;
const MAX_IMAGE_SIDE = 1024;

/** A raw image hint: (iiibiiay) width, height, rowstride, alpha, bits, channels, data. */
export interface RawImage {
  width: number;
  height: number;
  rowstride: number;
  hasAlpha: boolean;
  channels: number;
  data: Uint8Array;
}

/** What this process tells the main process. */
export type ServerMessage =
  | {
      type: 'notify';
      id: number;
      pid: number | null;
      appName: string;
      appIcon: string;
      summary: string;
      body: string;
      /** [key, label] pairs. */
      actions: [string, string][];
      urgency: 0 | 1 | 2;
      desktopEntry: string;
      image: RawImage | null;
      imagePath: string;
      resident: boolean;
      transient: boolean;
      /** ms; -1 is the server's choice, 0 never. */
      timeout: number;
    }
  | { type: 'close'; id: number };

/** What the main process tells this one. */
export type ServerCommand =
  | { type: 'closed'; id: number; reason: 1 | 2 | 3 | 4 }
  | { type: 'action'; id: number; key: string };

let bus: DBusConnection | null = null;
let port: Electron.MessagePortMain | null = null;
let busAddress: string | undefined;
let lastId = 0;
/** Ids handed out and not closed yet. */
const live = new Set<number>();

function post(message: ServerMessage): void {
  port?.postMessage(message);
}

const XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${IFACE}">
    <method name="GetCapabilities"><arg type="as" direction="out"/></method>
    <method name="Notify">
      <arg name="app_name" type="s" direction="in"/>
      <arg name="replaces_id" type="u" direction="in"/>
      <arg name="app_icon" type="s" direction="in"/>
      <arg name="summary" type="s" direction="in"/>
      <arg name="body" type="s" direction="in"/>
      <arg name="actions" type="as" direction="in"/>
      <arg name="hints" type="a{sv}" direction="in"/>
      <arg name="expire_timeout" type="i" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification"><arg name="id" type="u" direction="in"/></method>
    <method name="GetServerInformation">
      <arg name="name" type="s" direction="out"/>
      <arg name="vendor" type="s" direction="out"/>
      <arg name="version" type="s" direction="out"/>
      <arg name="spec_version" type="s" direction="out"/>
    </method>
    <signal name="NotificationClosed"><arg name="id" type="u"/><arg name="reason" type="u"/></signal>
    <signal name="ActionInvoked"><arg name="id" type="u"/><arg name="action_key" type="s"/></signal>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg type="s" direction="out"/></method>
  </interface>
</node>`;

/** Connect and take the name, retrying when the bus or the name's owner goes away. */
async function connect(): Promise<void> {
  const connection = await DBusConnection.connect(busAddress);
  if (!connection) {
    setTimeout(() => void connect(), 30_000);
    return;
  }
  bus = connection;
  connection.onClose = () => {
    if (bus !== connection) return;
    bus = null;
    setTimeout(() => void connect(), 5_000);
  };
  connection.export(PATH, answer);
  // Whoever has the name now may leave (a desktop's shell restarting).
  connection.subscribe(
    { sender: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged' },
    (message) => {
      const [name, , next] = message.body as [string, string, string];
      if (name === NAME && !next) void connection.bus('RequestName', 'su', [NAME, DO_NOT_QUEUE]).catch(() => {});
    },
  );
  const [reply] = await connection.bus('RequestName', 'su', [NAME, DO_NOT_QUEUE]).catch(() => [0]);
  if (reply !== PRIMARY_OWNER) console.log('notifications: another notification server is running');
}

async function answer(call: MethodCall): Promise<[string, unknown[]] | void> {
  if (call.interface === 'org.freedesktop.DBus.Introspectable' && call.member === 'Introspect') {
    return ['s', [XML]];
  }
  if (call.interface !== IFACE && call.interface !== '') {
    throw new DBusError('org.freedesktop.DBus.Error.UnknownInterface', 'No such interface');
  }
  switch (call.member) {
    case 'GetCapabilities':
      // body-markup: apps escape text as markup, and the shell strips it back
      // to plain text. Without it, some still send markup, unescaped.
      return ['as', [['actions', 'body', 'body-markup', 'icon-static', 'persistence']]];
    case 'GetServerInformation':
      return ['ssss', ['Din', 'Soapbox', '1.0', '1.2']];
    case 'CloseNotification': {
      const id = Number(call.body[0]);
      if (live.has(id)) post({ type: 'close', id });
      return;
    }
    case 'Notify':
      if (call.signature !== 'susssasa{sv}i') {
        throw new DBusError('org.freedesktop.DBus.Error.InvalidArgs', 'Notify takes (susssasa{sv}i)');
      }
      return ['u', [await notify(call)]];
  }
  throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', `No method ${call.member}`);
}

async function notify(call: MethodCall): Promise<number> {
  const [appName, replacesId, appIcon, summary, body, actions, hints, timeout] = call.body as [
    string, number, string, string, string, string[], Map<string, unknown>, number,
  ];
  const id = replacesId && live.has(replacesId) ? replacesId : nextId();
  live.add(id);
  const [pid] = bus
    ? await bus.bus('GetConnectionUnixProcessID', 's', [call.sender]).catch(() => [null])
    : [null];
  const hint = (name: string) => unwrap(hints.get(name));
  const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '');

  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < actions.length && pairs.length < MAX_ACTIONS; i += 2) {
    pairs.push([text(actions[i]), text(actions[i + 1])]);
  }
  const urgency = hint('urgency');

  post({
    type: 'notify',
    id,
    pid: typeof pid === 'number' ? pid : null,
    appName: text(appName),
    appIcon: text(appIcon),
    summary: text(summary),
    body: text(body),
    actions: pairs,
    urgency: urgency === 0 || urgency === 2 ? urgency : 1,
    desktopEntry: text(hint('desktop-entry')),
    image: rawImage(hint('image-data') ?? hint('image_data') ?? hint('icon_data')),
    imagePath: text(hint('image-path') ?? hint('image_path')),
    resident: hint('resident') === true,
    transient: hint('transient') === true,
    timeout: Number.isInteger(timeout) ? timeout : -1,
  });
  return id;
}

function nextId(): number {
  // 0 means "no notification" in replaces_id, so it's never handed out.
  lastId = (lastId % 0xffffffff) + 1;
  return lastId;
}

function rawImage(value: unknown): RawImage | null {
  if (!Array.isArray(value)) return null;
  const [width, height, rowstride, hasAlpha, bits, channels, data] = value as unknown[];
  if (
    typeof width !== 'number' || typeof height !== 'number' || typeof rowstride !== 'number' ||
    typeof channels !== 'number' || !Buffer.isBuffer(data) || bits !== 8 ||
    width <= 0 || height <= 0 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE ||
    (channels !== 3 && channels !== 4) || rowstride < width * channels ||
    data.length < rowstride * (height - 1) + width * channels
  ) {
    return null;
  }
  return { width, height, rowstride, hasAlpha: hasAlpha === true && channels === 4, channels, data };
}

/** Serve on `options.busAddress`, talking to notifications.mts on `channel`. */
export function start(channel: Electron.MessagePortMain, options: { busAddress?: string }): void {
  port = channel;
  busAddress = options.busAddress;
  channel.on('message', ({ data }: { data: ServerCommand }) => {
    if (!live.has(data.id)) return;
    if (data.type === 'action') {
      bus?.emit(PATH, IFACE, 'ActionInvoked', 'us', [data.id, data.key]);
    } else if (data.type === 'closed') {
      live.delete(data.id);
      bus?.emit(PATH, IFACE, 'NotificationClosed', 'uu', [data.id, data.reason]);
    }
  });
  void connect();
}
