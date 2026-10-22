// The desktop portal's file chooser backend
// (org.freedesktop.impl.portal.FileChooser), in the services host
// (services.mts).
//
// Apps don't draw their own Open and Save dialogs when they can ask the
// desktop portal (xdg-desktop-portal) instead: Chromium and Electron apps
// (Signal, VS Code, Chrome) do, and so does every Flatpak. The portal hands
// the dialog to whichever backend portals.conf names for it; on DinOS that's
// this one (os/configuration.nix), so the dialog is Din's own file picker
// rather than GTK's, drawn as a window in Din's display.
//
// Each request is passed to the main process (file-chooser.mts), which has
// the shell open its picker, and waits there until the user answers or the
// app gives up (the portal calls Close on the request). Out of the main
// process for the same reason as the notification server: Electron's own dialogs ask
// the portal too, and its UI thread is where the main process's JavaScript
// runs.
//
// Implements OpenFile (files or folders, one or many), SaveFile and
// SaveFiles, with filters; choices (extra checkboxes and combo boxes in the
// dialog) are ignored.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DBusConnection, DBusError, Variant, unwrap, type MethodCall } from './dbus.mts';

const NAME = 'org.freedesktop.impl.portal.desktop.din';
const PATH = '/org/freedesktop/portal/desktop';
const IFACE = 'org.freedesktop.impl.portal.FileChooser';
const REQUEST_IFACE = 'org.freedesktop.impl.portal.Request';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const VERSION = 4;

/** RequestName: fail rather than queue; reply 1 is "now the owner". */
const DO_NOT_QUEUE = 4;
const PRIMARY_OWNER = 1;

/** Portal responses. */
const SUCCESS = 0;
const CANCELLED = 1;

/** Past these, a request is abuse. */
const MAX_FILTERS = 64;
const MAX_RULES = 256;
const MAX_TEXT = 1024;

/** A filter, as the shell's picker takes it. */
export interface Filter {
  name: string;
  patterns: string[];
  mimeTypes: string[];
}

/** What the picker is asked to do. */
export interface PickRequest {
  title: string;
  confirmLabel: string | null;
  mode: 'open' | 'save';
  multiple: boolean;
  directory: boolean;
  filters: Filter[];
  currentFilter: number | null;
  currentName: string | null;
  initialPath: string | null;
}

/** What this process tells the main process. */
export type PortalMessage =
  | { type: 'open'; id: number; request: PickRequest }
  /** The app gave up waiting: close the picker. */
  | { type: 'close'; id: number };

/** What the main process tells this one: the user's answer (null: cancelled). */
export interface PortalAnswer {
  type: 'answer';
  id: number;
  paths: string[] | null;
  filter: number | null;
}

let bus: DBusConnection | null = null;
let port: Electron.MessagePortMain | null = null;
let busAddress: string | undefined;
let lastId = 0;
/** Requests waiting on the user, by id. */
const waiting = new Map<number, (answer: Omit<PortalAnswer, 'type' | 'id'>) => void>();

function post(message: PortalMessage): void {
  port?.postMessage(message);
}

const XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${IFACE}">
    <method name="OpenFile">
      <arg type="o" name="handle" direction="in"/>
      <arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/>
      <arg type="a{sv}" name="results" direction="out"/>
    </method>
    <method name="SaveFile">
      <arg type="o" name="handle" direction="in"/>
      <arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/>
      <arg type="a{sv}" name="results" direction="out"/>
    </method>
    <method name="SaveFiles">
      <arg type="o" name="handle" direction="in"/>
      <arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/>
      <arg type="a{sv}" name="results" direction="out"/>
    </method>
    <property name="version" type="u" access="read"/>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg type="s" direction="out"/></method>
  </interface>
</node>`;

/** Connect and take the name, retrying when the bus goes away. */
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
    // The requests were the old connection's; their callers are gone with it.
    for (const resolve of waiting.values()) resolve({ paths: null, filter: null });
    setTimeout(() => void connect(), 5_000);
  };
  connection.export(PATH, answer);
  const [reply] = await connection.bus('RequestName', 'su', [NAME, DO_NOT_QUEUE]).catch(() => [0]);
  if (reply !== PRIMARY_OWNER) console.log('file chooser: another Din has the portal backend name');
}

async function answer(call: MethodCall): Promise<[string, unknown[]] | void> {
  if (call.interface === 'org.freedesktop.DBus.Introspectable' && call.member === 'Introspect') {
    return ['s', [XML]];
  }
  if (call.interface === PROPERTIES_IFACE) {
    if (call.member === 'Get' && call.body[1] === 'version') return ['v', [new Variant('u', VERSION)]];
    if (call.member === 'GetAll') return ['a{sv}', [new Map([['version', new Variant('u', VERSION)]])]];
    throw new DBusError('org.freedesktop.DBus.Error.InvalidArgs', 'No such property');
  }
  if (call.interface !== IFACE && call.interface !== '') {
    throw new DBusError('org.freedesktop.DBus.Error.UnknownInterface', 'No such interface');
  }
  if (call.member !== 'OpenFile' && call.member !== 'SaveFile' && call.member !== 'SaveFiles') {
    throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', `No method ${call.member}`);
  }
  if (call.signature !== 'osssa{sv}') {
    throw new DBusError('org.freedesktop.DBus.Error.InvalidArgs', `${call.member} takes (osssa{sv})`);
  }
  const [handle, , , title, options] = call.body as [string, string, string, string, Map<string, unknown>];
  return ['ua{sv}', await choose(call.member, handle, text(title), options)];
}

/** Have the user choose, and reply as the portal expects. */
async function choose(
  method: 'OpenFile' | 'SaveFile' | 'SaveFiles',
  handle: string,
  title: string,
  options: Map<string, unknown>,
): Promise<unknown[]> {
  const option = (name: string) => unwrap(options.get(name));
  const filters = parseFilters(option('filters'));
  let currentFilter: number | null = null;
  const current = parseFilter(option('current_filter'));
  if (current) {
    // Alone, it's the filter; with a list, it picks one from it.
    const index = filters.findIndex((f) => f.name === current.name);
    if (index !== -1) currentFilter = index;
    else if (filters.length === 0) {
      filters.push(current);
      currentFilter = 0;
    }
  }
  const currentFile = method === 'SaveFile' ? bytePath(option('current_file')) : null;
  // SaveFiles saves files of their own names into a folder the user picks.
  const saveNames = method === 'SaveFiles' ? byteNames(option('files')) : [];

  const request: PickRequest = {
    title,
    confirmLabel: typeof option('accept_label') === 'string' ? withoutMnemonic(text(option('accept_label'))) : null,
    mode: method === 'SaveFile' ? 'save' : 'open',
    multiple: method === 'OpenFile' && option('multiple') === true,
    directory: method === 'SaveFiles' || (method === 'OpenFile' && option('directory') === true),
    filters: method === 'SaveFiles' ? [] : filters,
    currentFilter,
    currentName:
      typeof option('current_name') === 'string'
        ? path.basename(text(option('current_name')))
        : currentFile
          ? path.basename(currentFile)
          : null,
    initialPath: bytePath(option('current_folder')) ?? (currentFile ? path.dirname(currentFile) : null),
  };

  const id = ++lastId;
  const result = new Promise<Omit<PortalAnswer, 'type' | 'id'>>((resolve) => waiting.set(id, resolve));
  // The app can give up before the user answers.
  bus?.export(handle, (call) => {
    if (call.interface === REQUEST_IFACE && call.member === 'Close') {
      waiting.get(id)?.({ paths: null, filter: null });
      post({ type: 'close', id });
      return;
    }
    throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', `No method ${call.member}`);
  });
  post({ type: 'open', id, request });
  const { paths, filter } = await result;
  waiting.delete(id);
  bus?.unexport(handle);

  if (!paths || paths.length === 0) return [CANCELLED, new Map()];
  const files =
    method === 'SaveFiles' ? saveNames.map((name) => path.join(paths[0], name)) : paths;
  const results = new Map<string, Variant>([
    ['uris', new Variant('as', files.map((file) => pathToFileURL(file).href))],
  ]);
  const chosen = filter !== null ? request.filters[filter] : undefined;
  if (chosen) {
    results.set(
      'current_filter',
      new Variant('(sa(us))', [
        chosen.name,
        [...chosen.patterns.map((p) => [0, p]), ...chosen.mimeTypes.map((m) => [1, m])],
      ]),
    );
  }
  return [SUCCESS, results];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

/** GTK-style labels mark their access key with an underscore ("_Open"). */
function withoutMnemonic(label: string): string {
  return label.replace(/_(_?)/g, (_match, escaped: string) => escaped);
}

/** A filter, (sa(us)): a name, and rules of glob (0) or MIME type (1). */
function parseFilter(value: unknown): Filter | null {
  if (!Array.isArray(value) || typeof value[0] !== 'string' || !Array.isArray(value[1])) return null;
  const filter: Filter = { name: text(value[0]), patterns: [], mimeTypes: [] };
  for (const rule of (value[1] as unknown[]).slice(0, MAX_RULES)) {
    if (!Array.isArray(rule) || typeof rule[1] !== 'string') continue;
    if (rule[0] === 0) filter.patterns.push(text(rule[1]));
    else if (rule[0] === 1) filter.mimeTypes.push(text(rule[1]));
  }
  return filter;
}

function parseFilters(value: unknown): Filter[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_FILTERS)
    .map(parseFilter)
    .filter((f): f is Filter => f !== null);
}

/** A NUL-terminated byte string (ay). */
function byteString(value: unknown): string | null {
  if (!Buffer.isBuffer(value)) return null;
  const end = value.indexOf(0);
  return value.subarray(0, end === -1 ? value.length : end).toString('utf8');
}

/** A byte string holding an absolute path. */
function bytePath(value: unknown): string | null {
  const decoded = byteString(value);
  return decoded && path.isAbsolute(decoded) ? path.normalize(decoded) : null;
}

/** The names in an aay of file names (or paths). */
function byteNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => path.basename(byteString(item) ?? ''))
    .filter((name) => name && name !== '.' && name !== '..');
}

/** Serve on `options.busAddress`, talking to file-chooser.mts on `channel`. */
export function start(channel: Electron.MessagePortMain, options: { busAddress?: string }): void {
  port = channel;
  busAddress = options.busAddress;
  channel.on('message', ({ data }: { data: PortalAnswer }) => {
    if (data.type !== 'answer') return;
    waiting.get(data.id)?.({
      paths: Array.isArray(data.paths) ? data.paths.filter((p) => typeof p === 'string' && path.isAbsolute(p)) : null,
      filter: typeof data.filter === 'number' ? data.filter : null,
    });
  });
  void connect();
}
