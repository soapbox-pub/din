// Native apps' media players, over MPRIS on the session bus.
//
// Linux players (mpv, VLC, Firefox, Spotify, Chromium-based apps) publish
// themselves as org.mpris.MediaPlayer2.* with what's playing and Play, Pause,
// Next and Previous methods. This lists them for the volume menu's media
// controls (media.mts) and passes the controls on.
//
// Chromium publishes one for Din itself, standing for whichever of its pages
// last took audio focus. Din has better sources for its own media - the Media
// Player, the shell's own elements, each web page on its own (media.mts) - so
// players owned by Din's process are left out.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { DBusConnection, unwrap, type Message } from './dbus.mts';
import { sessionBusAddress } from './native-display.mts';

const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

export interface MprisPlayer {
  /** The player's bus name. */
  name: string;
  identity: string;
  status: 'Playing' | 'Paused' | 'Stopped';
  title: string;
  artist: string;
  /** mpris:artUrl, when it's a file or https URL. */
  artUrl: string | null;
  canPlay: boolean;
  canGoNext: boolean;
  canGoPrevious: boolean;
  /** When it started playing or paused, rather than stopped (ms since epoch). */
  since: number;
}

export type MprisAction = 'play' | 'pause' | 'nexttrack' | 'previoustrack';

let bus: DBusConnection | null = null;
/** Players by bus name. */
const players = new Map<string, MprisPlayer>();
/** Bus name by unique name, for telling whose signal it is. */
const owners = new Map<string, string>();
let onChange: () => void = () => {};

function str(value: unknown): string {
  const v = unwrap(value);
  return typeof v === 'string' ? v : '';
}

function bool(value: unknown): boolean {
  return unwrap(value) === true;
}

function artistOf(value: unknown): string {
  const v = unwrap(value);
  if (Array.isArray(v)) return v.filter((a): a is string => typeof a === 'string').join(', ');
  return typeof v === 'string' ? v : '';
}

async function getAll(connection: DBusConnection, name: string, iface: string): Promise<Map<string, unknown>> {
  const [props] = await connection.call({
    destination: name,
    path: PATH,
    interface: PROPS_IFACE,
    member: 'GetAll',
    signature: 's',
    body: [iface],
    timeout: 3_000,
  });
  return props instanceof Map ? (props as Map<string, unknown>) : new Map();
}

async function refresh(connection: DBusConnection, name: string): Promise<void> {
  try {
    const props = await getAll(connection, name, PLAYER_IFACE);
    const metadata = unwrap(props.get('Metadata'));
    const meta = metadata instanceof Map ? (metadata as Map<string, unknown>) : new Map<string, unknown>();
    const status = str(props.get('PlaybackStatus'));
    const previous = players.get(name);
    const identity = previous?.identity ?? str((await getAll(connection, name, ROOT_IFACE).catch(() => new Map())).get('Identity'));
    // It may have left the bus while we asked.
    if (![...owners.values()].includes(name)) return;
    const art = str(meta.get('mpris:artUrl'));
    players.set(name, {
      name,
      identity: identity || name.slice(PREFIX.length).split('.')[0],
      status: status === 'Playing' || status === 'Paused' ? status : 'Stopped',
      title: str(meta.get('xesam:title')),
      artist: artistOf(meta.get('xesam:artist')),
      artUrl: /^(file|https):/.test(art) ? art : null,
      canPlay: props.has('CanPlay') ? bool(props.get('CanPlay')) : true,
      canGoNext: bool(props.get('CanGoNext')),
      canGoPrevious: bool(props.get('CanGoPrevious')),
      since: previous && previous.status !== 'Stopped' ? previous.since : Date.now(),
    });
  } catch {
    players.delete(name);
  }
  onChange();
}

async function add(connection: DBusConnection, name: string, owner?: string): Promise<void> {
  try {
    const [pid] = await connection.bus('GetConnectionUnixProcessID', 's', [name]);
    if (pid === process.pid) return;
    const unique = owner ?? ((await connection.bus('GetNameOwner', 's', [name]))[0] as string);
    owners.set(unique, name);
  } catch {
    return;
  }
  await refresh(connection, name);
}

function remove(name: string): void {
  for (const [unique, owned] of owners) if (owned === name) owners.delete(unique);
  if (players.delete(name)) onChange();
}

async function connect(): Promise<void> {
  const connection = await DBusConnection.connect(await sessionBusAddress());
  if (!connection) return;
  bus = connection;
  connection.onClose = () => {
    if (bus !== connection) return;
    bus = null;
    players.clear();
    owners.clear();
    onChange();
    setTimeout(() => void connect(), 5_000);
  };
  connection.subscribe(
    { sender: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged' },
    (message: Message) => {
      const [name, , next] = message.body as [string, string, string];
      if (!name.startsWith(PREFIX)) return;
      remove(name);
      if (next) void add(connection, name, next);
    },
  );
  connection.subscribe(
    { path: PATH, interface: PROPS_IFACE, member: 'PropertiesChanged' },
    (message: Message) => {
      const name = message.sender ? owners.get(message.sender) : undefined;
      if (name) void refresh(connection, name);
    },
  );
  const [names] = await connection.bus('ListNames').catch(() => [[]]);
  for (const name of names as string[]) {
    if (name.startsWith(PREFIX)) void add(connection, name);
  }
}

/** Start watching for players; `changed` runs whenever the list changes. */
export function startMpris(changed: () => void): void {
  onChange = changed;
  void connect();
}

/** The players with something to play or pause. */
export function mprisPlayers(): MprisPlayer[] {
  return [...players.values()].filter((player) => player.status !== 'Stopped');
}

export async function mprisControl(name: string, action: MprisAction): Promise<void> {
  if (!bus || !players.has(name)) return;
  const member = {
    play: 'Play',
    pause: 'Pause',
    nexttrack: 'Next',
    previoustrack: 'Previous',
  }[action];
  await bus.call({ destination: name, path: PATH, interface: PLAYER_IFACE, member, timeout: 3_000 }).catch(() => {});
}
