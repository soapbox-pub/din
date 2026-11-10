// The date, time and time zone: the system's, which Settings → Date & Time
// shows and changes.
//
// They're systemd-timedated's, read through timedatectl, which needs no
// privileges. Changing them does: on DinOS that's os/din-time.sh, which
// DinOS's launcher names in DIN_TIME and the shell's user runs through sudo
// without a password, like the keyboard layout's helper. Elsewhere Din runs
// timedatectl as the user, and timedated asks polkit, which asks for the
// administrator's password in Din (electron/polkit-agent.mts) or in the
// desktop's own agent.
//
// Chromium watches /etc/localtime, so Din's clock (and every page's Date)
// follows a new time zone without a restart.
//
// "Set time automatically" sets the time zone too: while it's on, Din finds
// where the computer is through GeoClue (electron/geolocation.mts: the
// nearby WiFi networks, looked up in BeaconDB), looks the place up in
// tz-lookup's map of the world's zones, and makes that the time zone, when
// Din starts, when the network comes back, after a sleep, and every hour
// (so it follows the computer when it travels). That's DinOS's alone:
// elsewhere each change could ask for a password. Picking a zone, on the map
// or the list, is for when it's off. The map asks here for the zone at the
// point clicked, so the lookup's table is only in this process.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { existsSync, readFileSync } from 'node:fs';
import tzLookup from '@photostructure/tz-lookup';
import { ipcMain, net, powerMonitor } from 'electron';
import { locateHere } from './geolocation.mts';
import { notifyFromSystem } from './notifications.mts';
import { CommandError, runCommand } from './system.mts';

const HELPER = process.env.DIN_TIME;

/** An IANA zone name, e.g. "America/New_York"; also what din-time accepts. */
const ZONE_NAME = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/;

/** A local time as timedatectl takes it. */
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

interface DateTimeStatus {
  /** IANA name of the system's time zone. */
  timeZone: string;
  /** Whether the clock is set from the network; null where that's unknown. */
  automatic: boolean | null;
  /** Whether the clock has been set from the network since it started. */
  synchronized: boolean;
  /** Whether Din can change the time zone and clock here. */
  canChange: boolean;
  /** Whether there's a network time service to turn on and off. */
  canAutomatic: boolean;
  /**
   * While it's set automatically, how finding the time zone went: not yet
   * tried, looking, found (and set), or not found (no network, or nowhere
   * GeoClue knows). Null where Din doesn't set it.
   */
  zoneDetection: 'pending' | 'detecting' | 'found' | 'failed' | null;
}

/** A zone's principal place, from tzdata's zone1970.tab. */
interface ZonePlace {
  zone: string;
  latitude: number;
  longitude: number;
  /** ISO 3166 codes of the countries it covers. */
  countries: string[];
  /** Which part of the country, where it has more than one zone. */
  comment: string;
}

/** `timedatectl show`'s Key=value lines. */
async function timedated(): Promise<Map<string, string> | null> {
  try {
    const { stdout } = await runCommand('timedatectl', ['show'], { timeout: 5_000 });
    const values = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
    }
    return values;
  } catch {
    return null;
  }
}

async function status(): Promise<DateTimeStatus> {
  const values = await timedated();
  const zone = values?.get('Timezone');
  const canAutomatic = values?.get('CanNTP') === 'yes';
  return {
    timeZone: zone && ZONE_NAME.test(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    automatic: values?.has('NTP') ? values.get('NTP') === 'yes' : null,
    synchronized: values?.get('NTPSynchronized') === 'yes',
    canChange: values !== null,
    canAutomatic,
    zoneDetection: HELPER && values !== null ? detection : null,
  };
}

let zoneList: Promise<string[]> | null = null;

/** Every time zone there is, as timedatectl knows them (or, failing that, ICU). */
function timeZones(): Promise<string[]> {
  zoneList ??= (async () => {
    try {
      const { stdout } = await runCommand('timedatectl', ['list-timezones', '--no-pager'], { timeout: 5_000 });
      const zones = stdout.split('\n').map((line) => line.trim()).filter((zone) => ZONE_NAME.test(zone));
      if (zones.length > 0) return zones;
    } catch {
      // fall back to ICU's
    }
    return Intl.supportedValuesOf('timeZone');
  })();
  return zoneList;
}

const TZ_DIRS = [process.env.TZDIR, '/etc/zoneinfo', '/usr/share/zoneinfo'].filter(Boolean) as string[];

/** zone.tab's ±DDMM[SS]: degrees, minutes and maybe seconds. */
function coordinate(text: string, degreeDigits: number): number {
  const sign = text[0] === '-' ? -1 : 1;
  const digits = text.slice(1);
  const degrees = Number(digits.slice(0, degreeDigits));
  const minutes = Number(digits.slice(degreeDigits, degreeDigits + 2));
  const seconds = Number(digits.slice(degreeDigits + 2) || 0);
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

let placeList: ZonePlace[] | null = null;

/** Where each zone is, for the map; empty where tzdata's table isn't found. */
function zonePlaces(): ZonePlace[] {
  if (placeList) return placeList;
  for (const dir of TZ_DIRS) {
    let text: string;
    try {
      text = readFileSync(`${dir}/zone1970.tab`, 'utf8');
    } catch {
      continue;
    }
    const places: ZonePlace[] = [];
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [countries, coords, zone, comment = ''] = line.split('\t');
      const match = /^([+-]\d{4,6})([+-]\d{5,7})$/.exec(coords ?? '');
      if (!match || !zone || !ZONE_NAME.test(zone)) continue;
      places.push({
        zone,
        latitude: coordinate(match[1], 2),
        longitude: coordinate(match[2], 3),
        countries: countries.split(','),
        comment,
      });
    }
    placeList = places;
    return places;
  }
  placeList = [];
  return placeList;
}

/**
 * The time zone at a point, or null. The sea's Etc/GMT±N zones become the
 * nearest place's, as nobody's clock is set to them.
 */
async function zoneAt(latitude: number, longitude: number): Promise<string | null> {
  let zone: string;
  try {
    zone = tzLookup(latitude, longitude);
  } catch {
    return null;
  }
  const zones = await timeZones();
  if (zone && !zone.startsWith('Etc/') && zones.includes(zone)) return zone;
  let nearest: string | null = null;
  let best = Infinity;
  const cos = Math.cos((latitude * Math.PI) / 180);
  for (const place of zonePlaces()) {
    let dLon = Math.abs(place.longitude - longitude);
    if (dLon > 180) dLon = 360 - dLon;
    const d = (place.latitude - latitude) ** 2 + (dLon * cos) ** 2;
    if (d < best && zones.includes(place.zone)) {
      best = d;
      nearest = place.zone;
    }
  }
  return nearest;
}

/** timedatectl's arguments for what din-time is asked, off DinOS. */
function timedatectlArgs([action, value]: string[]): string[] {
  switch (action) {
    case 'zone':
      return ['set-timezone', value];
    case 'automatic':
      return ['set-ntp', value === 'on' ? 'true' : 'false'];
    case 'set':
      return ['set-time', value];
    default:
      throw new Error('Din doesn’t set the time zone by itself on this system');
  }
}

/** Long enough to type a password into polkit's prompt. */
const POLKIT_TIMEOUT_MS = 10 * 60_000;

async function helper(args: string[]): Promise<void> {
  try {
    if (HELPER) await runCommand('sudo', ['-n', HELPER, ...args], { timeout: 15_000 });
    else await runCommand('timedatectl', timedatectlArgs(args), { timeout: POLKIT_TIMEOUT_MS });
  } catch (error) {
    // The helper, and timedatectl, say what went wrong on its last line.
    const reason = error instanceof CommandError ? error.stderr.trim().split('\n').pop() : '';
    throw reason ? new Error(reason) : error;
  }
}

// Finding the time zone while it's set automatically.

/** Set by din-time while the clock and time zone are set by hand. */
const MANUAL_FILE = '/var/lib/din/manual-time';
const CHECK_EVERY_MS = 30_000;
const RECHECK_FOUND_MS = 60 * 60_000;
const RETRY_FAILED_MS = 2 * 60_000;

let detection: 'pending' | 'detecting' | 'found' | 'failed' = 'pending';
let nextAttempt = 0;
let wasOffline = false;
let detecting: Promise<void> | null = null;

/** Tell the user the clock moved, as a phone does when it lands somewhere new. */
function notifyZoneChanged(zone: string): void {
  const city = zone.split('/').pop()?.replace(/_/g, ' ') ?? zone;
  let time = '';
  let name = '';
  try {
    const now = new Date();
    time = new Intl.DateTimeFormat([], { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(now);
    name = new Intl.DateTimeFormat([], { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    // just the city, then
  }
  notifyFromSystem(
    'time-zone',
    `Time zone changed to ${city}`,
    time ? `It's ${time}${name ? `, ${name}` : ''}.` : 'The clock follows where you are.',
  );
}

/** Find where the computer is and set the time zone there, once. */
function detectZone(): Promise<void> {
  detecting ??= (async () => {
    detection = 'detecting';
    try {
      const fix = await locateHere();
      const zone = await zoneAt(fix.latitude, fix.longitude);
      if (!zone) throw new Error('No time zone there');
      // Turned off while GeoClue was looking.
      if (existsSync(MANUAL_FILE)) return;
      const current = (await timedated())?.get('Timezone');
      if (zone !== current) {
        await helper(['detected-zone', zone]);
        console.log(`[datetime] time zone set automatically to ${zone}`);
        notifyZoneChanged(zone);
      }
      detection = 'found';
      nextAttempt = Date.now() + RECHECK_FOUND_MS;
    } catch (error) {
      detection = 'failed';
      nextAttempt = Date.now() + RETRY_FAILED_MS;
      console.warn(`[datetime] couldn't find the time zone: ${error instanceof Error ? error.message : String(error)}`);
    }
  })().finally(() => {
    detecting = null;
  });
  return detecting;
}

function tick(): void {
  if (existsSync(MANUAL_FILE)) {
    detection = 'pending';
    return;
  }
  if (!net.isOnline()) {
    wasOffline = true;
    return;
  }
  if (wasOffline || Date.now() >= nextAttempt) {
    wasOffline = false;
    void detectZone();
  }
}

function startZoneDetection(): void {
  if (!HELPER) return;
  // Let the WiFi connect first.
  nextAttempt = Date.now() + 10_000;
  setInterval(tick, CHECK_EVERY_MS).unref();
  setTimeout(tick, 10_000).unref();
  powerMonitor.on('resume', () => {
    nextAttempt = Date.now() + 10_000;
    setTimeout(tick, 10_000).unref();
  });
}

export function registerDateTimeHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  ipcMain.handle('datetime:status', async (event) => {
    assertShellSender(event);
    return status();
  });

  ipcMain.handle('datetime:zones', async (event) => {
    assertShellSender(event);
    return timeZones();
  });

  ipcMain.handle('datetime:places', async (event) => {
    assertShellSender(event);
    return zonePlaces();
  });

  ipcMain.handle('datetime:zone-at', async (event, latitude: unknown, longitude: unknown) => {
    assertShellSender(event);
    if (typeof latitude !== 'number' || typeof longitude !== 'number'
      || !(Math.abs(latitude) <= 90) || !(Math.abs(longitude) <= 180)) {
      throw new Error('Not a place');
    }
    return zoneAt(latitude, longitude);
  });

  ipcMain.handle('datetime:set-zone', async (event, zone: unknown) => {
    assertShellSender(event);
    if (typeof zone !== 'string' || !ZONE_NAME.test(zone) || !(await timeZones()).includes(zone)) {
      throw new Error('Unknown time zone');
    }
    await helper(['zone', zone]);
  });

  ipcMain.handle('datetime:set-automatic', async (event, automatic: unknown) => {
    assertShellSender(event);
    if (typeof automatic !== 'boolean') throw new Error('automatic must be a boolean');
    await helper(['automatic', automatic ? 'on' : 'off']);
    // Off DinOS the system's own time zone is left alone (startZoneDetection).
    if (automatic && HELPER) {
      wasOffline = false;
      detection = 'pending';
      nextAttempt = 0;
      setTimeout(tick, 0);
    }
  });

  ipcMain.handle('datetime:set-time', async (event, time: unknown) => {
    assertShellSender(event);
    if (typeof time !== 'string' || !LOCAL_TIME.test(time)) throw new Error('Not a time');
    await helper(['set', time]);
  });

  startZoneDetection();
}
