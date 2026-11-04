// Web pages' navigator.geolocation, answered by GeoClue.
//
// Chromium on Linux finds a location only by asking Google's geolocation
// service, which needs an API key Din doesn't have (and would tell Google
// where the user is). So pages get a navigator.geolocation of Din's own
// (geolocation-preload.cjs), and the location comes from GeoClue on the
// system bus. On DinOS it looks the nearby WiFi networks up in BeaconDB
// (services.geoclue2 in os/configuration.nix); anywhere without GeoClue,
// every request fails as "position unavailable", as Chromium's did.
//
// Only a top document whose origin the user allowed gets a location: asked
// in the shell the first time, like the camera (see hardenGuestSession in
// main.mts), and checked again here for every request.
//
// Din asks too, for the time zone while it's set automatically (locateHere).
//
// One GeoClue client serves every page. It starts on the first request and
// keeps running while pages keep asking, so a watch sees the location as
// GeoClue updates it; a minute after the last request it stops.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain } from 'electron';
import { DBusConnection, DBusError, Variant, unwrap } from './dbus.mts';

const SYSTEM_BUS = process.env.DBUS_SYSTEM_BUS_ADDRESS || 'unix:path=/run/dbus/system_bus_socket';
const GEOCLUE = 'org.freedesktop.GeoClue2';
const MANAGER_PATH = '/org/freedesktop/GeoClue2/Manager';
const MANAGER = 'org.freedesktop.GeoClue2.Manager';
const CLIENT = 'org.freedesktop.GeoClue2.Client';
const LOCATION = 'org.freedesktop.GeoClue2.Location';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const AGENT = 'org.freedesktop.GeoClue2.Agent';
const AGENT_PATH = '/org/freedesktop/GeoClue2/Agent';

/** The desktop ID GeoClue's configuration authorizes (os/configuration.nix). */
const DESKTOP_ID = 'din';
/** GCLUE_ACCURACY_LEVEL_EXACT: whatever the best source can do. */
const ACCURACY_EXACT = 8;
/** How long a first fix may take: a WiFi scan plus a BeaconDB lookup. */
const FIX_TIMEOUT_MS = 30_000;
/** How long the client keeps running after the last request. */
const IDLE_STOP_MS = 60_000;

/** A position, as GeolocationPosition carries it. */
export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
  /** When GeoClue found it, in ms since the epoch. */
  timestamp: number;
}

/** What a page's request gets: a position, or a GeolocationPositionError code. */
export type GeoResult = { fix: GeoFix } | { error: 1 | 2; message: string };

class Unavailable extends Error {}

/** A running GeoClue client. */
interface GeoSession {
  bus: DBusConnection;
  client: string;
  fix: GeoFix | null;
  /** Waiting for the first fix. */
  waiters: Set<(fix: GeoFix) => void>;
}

let session: GeoSession | null = null;
let starting: Promise<GeoSession> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function finite(value: unknown): number | null {
  const n = unwrap(value);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

async function readFix(bus: DBusConnection, owner: string, path: string): Promise<GeoFix | null> {
  const [props] = await bus.call({
    destination: owner,
    path,
    interface: PROPERTIES,
    member: 'GetAll',
    signature: 's',
    body: [LOCATION],
  });
  if (!(props instanceof Map)) return null;
  const latitude = finite(props.get('Latitude'));
  const longitude = finite(props.get('Longitude'));
  const accuracy = finite(props.get('Accuracy'));
  if (latitude === null || longitude === null || accuracy === null) return null;
  // GeoClue says "unknown" with -DBL_MAX for altitude and -1 for the others.
  const altitude = finite(props.get('Altitude'));
  const speed = finite(props.get('Speed'));
  const heading = finite(props.get('Heading'));
  const stamp = unwrap(props.get('Timestamp'));
  const seconds = Array.isArray(stamp) && typeof stamp[0] === 'number' ? stamp[0] : 0;
  return {
    latitude,
    longitude,
    accuracy,
    altitude: altitude !== null && altitude > -1e300 ? altitude : null,
    speed: speed !== null && speed >= 0 ? speed : null,
    heading: heading !== null && heading >= 0 ? heading : null,
    timestamp: seconds > 0 ? seconds * 1000 : Date.now(),
  };
}

/**
 * Be the user's GeoClue agent, which GeoClue wants before it answers any
 * client. Its only say here is the accuracy it allows: Din's client is
 * authorized by configuration, and sites are asked in Din's own prompt.
 * Other apps that would need the agent's authorization are refused.
 */
function exportAgent(bus: DBusConnection): void {
  const props = new Map([['MaxAccuracyLevel', new Variant('u', ACCURACY_EXACT)]]);
  bus.export(AGENT_PATH, (call) => {
    if (call.interface === PROPERTIES && call.member === 'GetAll') {
      return ['a{sv}', [call.body[0] === AGENT ? props : new Map()]];
    }
    if (call.interface === PROPERTIES && call.member === 'Get' && call.body[0] === AGENT) {
      const value = props.get(call.body[1] as string);
      if (value) return ['v', [value]];
      throw new DBusError('org.freedesktop.DBus.Error.UnknownProperty', String(call.body[1]));
    }
    if (call.interface === AGENT && call.member === 'AuthorizeApp') return ['bu', [false, 0]];
    throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', call.member);
  });
}

async function start(): Promise<GeoSession> {
  const bus = await DBusConnection.connect(SYSTEM_BUS);
  if (!bus) throw new Unavailable('No system bus');
  try {
    const [owner] = await bus.bus('GetNameOwner', 's', [GEOCLUE]).catch(() => {
      // Activates the service if it isn't running yet.
      return bus.bus('StartServiceByName', 'su', [GEOCLUE, 0]).then(() => bus.bus('GetNameOwner', 's', [GEOCLUE]));
    });
    if (typeof owner !== 'string') throw new Unavailable('GeoClue is not running');
    exportAgent(bus);
    await bus.call({ destination: owner, path: MANAGER_PATH, interface: MANAGER, member: 'AddAgent', signature: 's', body: [DESKTOP_ID] });
    const [client] = await bus.call({ destination: owner, path: MANAGER_PATH, interface: MANAGER, member: 'CreateClient' });
    if (typeof client !== 'string') throw new Unavailable('GeoClue gave no client');
    const set = (name: string, value: Variant) =>
      bus.call({ destination: owner, path: client, interface: PROPERTIES, member: 'Set', signature: 'ssv', body: [CLIENT, name, value] });
    await set('DesktopId', new Variant('s', DESKTOP_ID));
    await set('RequestedAccuracyLevel', new Variant('u', ACCURACY_EXACT));

    const s: GeoSession = { bus, client, fix: null, waiters: new Set() };
    bus.subscribe({ sender: owner, path: client, interface: CLIENT, member: 'LocationUpdated' }, (message) => {
      const path = message.body[1];
      if (typeof path !== 'string') return;
      void readFix(bus, owner, path)
        .then((fix) => {
          if (!fix || session !== s) return;
          s.fix = fix;
          for (const resolve of s.waiters) resolve(fix);
          s.waiters.clear();
        })
        .catch(() => {});
    });
    bus.onClose = () => {
      if (session === s) session = null;
    };
    await bus.call({ destination: owner, path: client, interface: CLIENT, member: 'Start' });
    return s;
  } catch (error) {
    bus.close();
    throw error;
  }
}

function stop(): void {
  idleTimer = null;
  const s = session;
  session = null;
  // Closing the connection is enough: GeoClue drops a client whose owner left.
  s?.bus.close();
}

/** The current position, starting GeoClue's client if it isn't running. */
async function locate(): Promise<GeoFix> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_STOP_MS);
  if (!session) {
    starting ??= start().finally(() => {
      starting = null;
    });
    session = await starting;
  }
  const s = session;
  if (s.fix) return s.fix;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.waiters.delete(done);
      reject(new Unavailable('No location found'));
    }, FIX_TIMEOUT_MS);
    const done = (fix: GeoFix) => {
      clearTimeout(timer);
      resolve(fix);
    };
    s.waiters.add(done);
  });
}

/**
 * Where the computer is, for Din itself: the automatic time zone
 * (electron/datetime.mts). Rejects when GeoClue can't say.
 */
export function locateHere(): Promise<GeoFix> {
  return locate();
}

/** The top document of a web guest, or null for anything else. */
function guestOrigin(event: Electron.IpcMainInvokeEvent): string | null {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || event.sender.getType() !== 'webview') return null;
  return frame.origin && frame.origin !== 'null' ? frame.origin : null;
}

const DENIED: GeoResult = { error: 1, message: 'User denied Geolocation' };

/** Register the geolocation IPC surface for geolocation-preload.cjs. */
export function registerGeolocationHandlers(options: {
  /** Ask (or recall) whether a site may know the user's location. */
  request: (s: Electron.Session, origin: string) => Promise<boolean>;
  /** Whether the user has allowed a site to know their location. */
  allowed: (s: Electron.Session, origin: string) => boolean;
}): void {
  ipcMain.handle('geolocation:request', async (event): Promise<boolean> => {
    const origin = guestOrigin(event);
    return origin !== null && (await options.request(event.sender.session, origin));
  });

  ipcMain.handle('geolocation:locate', async (event): Promise<GeoResult> => {
    const origin = guestOrigin(event);
    if (!origin || !options.allowed(event.sender.session, origin)) return DENIED;
    try {
      const fix = await locate();
      // The user may have changed their mind while GeoClue was looking.
      if (event.sender.isDestroyed() || !options.allowed(event.sender.session, origin)) return DENIED;
      return { fix };
    } catch (error) {
      const message = error instanceof Unavailable ? error.message : 'Location is unavailable';
      return { error: 2, message };
    }
  });
}
