// Links that native apps open, in Din's Web Browser.
//
// A native app opens a link by running xdg-open (Electron and Chromium apps,
// like Signal) or by asking the desktop portal (Flatpaks), and both hand it
// to the default handler for x-scheme-handler/https. On DinOS that's
// din-open (os/configuration.nix), which calls Open on this
// org.freedesktop.Application. The shell then opens the link the way its
// own links open (useOpenUrl): in an installed web app that owns the
// origin, or as a tab in the Web Browser. A nostr: link opens in the app
// chosen for its kind, or as a preview with an "Open with" choice.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { DBusConnection, DBusError, type MethodCall } from './dbus.mts';
import { sessionBusAddress } from './native-display.mts';

const NAME = 'pub.soapbox.Din';
const PATH = '/pub/soapbox/Din';
const IFACE = 'org.freedesktop.Application';

/** RequestName: fail rather than queue; reply 1 is "now the owner". */
const DO_NOT_QUEUE = 4;
const PRIMARY_OWNER = 1;

/** Past these, a request is abuse. */
const MAX_URIS = 16;
const MAX_URI_LENGTH = 8192;

let bus: DBusConnection | null = null;
let sendToShell: (channel: string, payload?: unknown) => void = () => {};

const XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${IFACE}">
    <method name="Activate">
      <arg type="a{sv}" name="platform_data" direction="in"/>
    </method>
    <method name="Open">
      <arg type="as" name="uris" direction="in"/>
      <arg type="a{sv}" name="platform_data" direction="in"/>
    </method>
    <method name="ActivateAction">
      <arg type="s" name="action_name" direction="in"/>
      <arg type="av" name="parameter" direction="in"/>
      <arg type="a{sv}" name="platform_data" direction="in"/>
    </method>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg type="s" direction="out"/></method>
  </interface>
</node>`;

/** Connect and take the name, retrying when the bus goes away. */
async function connect(): Promise<void> {
  const connection = await DBusConnection.connect(await sessionBusAddress());
  if (!connection) return;
  bus = connection;
  connection.onClose = () => {
    if (bus !== connection) return;
    bus = null;
    setTimeout(() => void connect(), 5_000);
  };
  connection.export(PATH, answer);
  const [reply] = await connection.bus('RequestName', 'su', [NAME, DO_NOT_QUEUE]).catch(() => [0]);
  if (reply !== PRIMARY_OWNER) console.log('open-uri: another Din has the name');
}

function answer(call: MethodCall): [string, unknown[]] | void {
  if (call.interface === 'org.freedesktop.DBus.Introspectable' && call.member === 'Introspect') {
    return ['s', [XML]];
  }
  if (call.interface !== IFACE && call.interface !== '') {
    throw new DBusError('org.freedesktop.DBus.Error.UnknownInterface', 'No such interface');
  }
  // Din is already running, and has no actions.
  if (call.member === 'Activate' || call.member === 'ActivateAction') return;
  if (call.member !== 'Open') {
    throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', `No method ${call.member}`);
  }
  if (call.signature !== 'asa{sv}') {
    throw new DBusError('org.freedesktop.DBus.Error.InvalidArgs', 'Open takes (asa{sv})');
  }
  const [uris] = call.body as [unknown[]];
  for (const uri of uris.slice(0, MAX_URIS)) {
    if (typeof uri === 'string' && uri.length <= MAX_URI_LENGTH && /^(https?|nsite|nostr):/i.test(uri)) {
      sendToShell('open-uri:open', uri);
    }
  }
}

/** Take the name, and pass the links apps open to the shell. */
export function registerOpenUri(options: { sendToShell: (channel: string, payload?: unknown) => void }): void {
  sendToShell = options.sendToShell;
  void connect();
}
