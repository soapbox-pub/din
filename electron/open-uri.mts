// Links that native apps open, in Din's Web Browser.
//
// A native app opens a link by running xdg-open (Electron and Chromium apps,
// like Signal) or by asking the desktop portal (Flatpaks), and both hand it
// to the default handler for x-scheme-handler/https. On DinOS that's
// din-open (os/configuration.nix), which calls Open on this
// org.freedesktop.Application. The shell then opens the link the way its
// own links open (useOpenUrl): in an installed web app that owns the
// origin, or as a tab in the Web Browser. A nostr: link opens in the app
// chosen for its kind, or as a preview with an "Open with" choice; a
// blossom: link (BUD-10) as a tab showing the file (electron/blossom.mts).
//
// Folders come the same way (din-open is the handler for inode/directory
// too) and open in Files, as do the files apps ask to show: Electron and
// Chromium apps' "Show in Folder" (Signal's, after a download) calls
// ShowItems on org.freedesktop.FileManager1, which Din answers here, and
// falls back to xdg-open on the folder when nothing does.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBusConnection, DBusError, type MethodCall, type MethodReply } from './dbus.mts';
import { sessionBusAddress } from './native-display.mts';

const NAME = 'pub.soapbox.Din';
const PATH = '/pub/soapbox/Din';
const IFACE = 'org.freedesktop.Application';

const FM_NAME = 'org.freedesktop.FileManager1';
const FM_PATH = '/org/freedesktop/FileManager1';
const FM_IFACE = 'org.freedesktop.FileManager1';

/** A path for the shell to show in Files: a folder, or a file selected in its folder. */
export interface OpenPathRequest {
  path: string;
  kind: 'directory' | 'file';
  /** Show `path`'s folder with this entry of it selected. */
  select?: boolean;
}

/** RequestName: fail rather than queue; reply 1 is "now the owner". */
const DO_NOT_QUEUE = 4;
const PRIMARY_OWNER = 1;

/** Past these, a request is abuse. */
const MAX_URIS = 16;
const MAX_URI_LENGTH = 8192;

let bus: DBusConnection | null = null;
let sendToShell: (channel: string, payload?: unknown) => void = () => {};

const INTROSPECTABLE = `  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg type="s" direction="out"/></method>
  </interface>`;

const FM_XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${FM_IFACE}">
    <method name="ShowFolders">
      <arg type="as" name="URIs" direction="in"/>
      <arg type="s" name="StartupId" direction="in"/>
    </method>
    <method name="ShowItems">
      <arg type="as" name="URIs" direction="in"/>
      <arg type="s" name="StartupId" direction="in"/>
    </method>
    <method name="ShowItemProperties">
      <arg type="as" name="URIs" direction="in"/>
      <arg type="s" name="StartupId" direction="in"/>
    </method>
  </interface>
${INTROSPECTABLE}
</node>`;

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
${INTROSPECTABLE}
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
  connection.export(FM_PATH, answerFileManager);
  const [reply] = await connection.bus('RequestName', 'su', [NAME, DO_NOT_QUEUE]).catch(() => [0]);
  if (reply !== PRIMARY_OWNER) console.log('open-uri: another Din has the name');
  // Another file manager may have it (Din as a desktop on a NixOS with
  // Nautilus): it keeps it.
  const [fm] = await connection.bus('RequestName', 'su', [FM_NAME, DO_NOT_QUEUE]).catch(() => [0]);
  if (fm !== PRIMARY_OWNER) console.log('open-uri: another file manager has FileManager1');
}

/** A local file: URI's (or absolute path's) path, or null. */
function localPath(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH) return null;
  try {
    const file = uri.startsWith('/') ? uri : /^file:/i.test(uri) ? fileURLToPath(uri) : null;
    return file && path.isAbsolute(file) ? path.normalize(file) : null;
  } catch {
    // file://host/... and malformed escapes.
    return null;
  }
}

/** Send the shell what a path is, for Files (or, a file, the app for its kind). */
async function showPath(file: string, select: boolean): Promise<void> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return;
  const request: OpenPathRequest = { path: file, kind: stat.isDirectory() ? 'directory' : 'file' };
  // The root has no folder to be selected in.
  if (select && file !== '/') request.select = true;
  sendToShell('open-uri:path', request);
}

function answerFileManager(call: MethodCall): MethodReply {
  if (call.interface === 'org.freedesktop.DBus.Introspectable' && call.member === 'Introspect') {
    return ['s', [FM_XML]];
  }
  if (call.interface !== FM_IFACE && call.interface !== '') {
    throw new DBusError('org.freedesktop.DBus.Error.UnknownInterface', 'No such interface');
  }
  if (!['ShowFolders', 'ShowItems', 'ShowItemProperties'].includes(call.member)) {
    throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', `No method ${call.member}`);
  }
  if (call.signature !== 'ass') {
    throw new DBusError('org.freedesktop.DBus.Error.InvalidArgs', `${call.member} takes (ass)`);
  }
  const [uris] = call.body as [unknown[]];
  // Files shows one folder per window: the first of them, as other file
  // managers open one window per folder but apps ask for just one.
  for (const uri of uris.slice(0, MAX_URIS)) {
    const file = localPath(uri);
    if (!file) continue;
    // ShowFolders opens the folder; the others show the item in its own.
    void showPath(file, call.member !== 'ShowFolders');
    return;
  }
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
    if (typeof uri === 'string' && uri.length <= MAX_URI_LENGTH && /^(https?|nsite|nostr|blossom):/i.test(uri)) {
      sendToShell('open-uri:open', uri);
      continue;
    }
    // xdg-open on a folder (din-open is its handler) or a local file.
    const file = localPath(uri);
    if (file) void showPath(file, false);
  }
}

/** Take the name, and pass the links apps open to the shell. */
export function registerOpenUri(options: { sendToShell: (channel: string, payload?: unknown) => void }): void {
  sendToShell = options.sendToShell;
  void connect();
}
