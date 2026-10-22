// Night light (red shift): a warm color temperature over the whole screen,
// always on or on a schedule, which the menu bar's display control and
// Settings → Display show and change.
//
// The tint is a gamma ramp held by gammastep (wlsunset as a fallback), kept
// running here: under Wayland the ramp goes when its client disconnects. The
// tool runs at one fixed temperature, and Din decides when it runs - the
// schedule is checked every half minute - so any hours work, including ones
// that don't cross midnight, which gammastep's own dawn/dusk times can't
// express. gammastep fades in when it starts and out when it's sent SIGTERM,
// so scheduled changes and the switch fade; a new temperature restarts it
// without the fade.
//
// "Sunset to sunrise" uses the time zone's coordinates from tzdata's
// zone1970.tab, which is close enough for when the sun sets without asking
// for a location.
//
// The settings are saved in the user's config, so the light comes back after
// a restart.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import { CommandError, runCommand } from './system.mts';

const TOOLS = ['gammastep', 'wlsunset'];
export const MIN_TEMPERATURE = 2500;
export const MAX_TEMPERATURE = 6500;
/** How often the schedule is checked. */
const TICK_MS = 30_000;
/** The sun's elevation at sunset and sunrise, allowing for refraction. */
const SUNSET_ELEVATION = -0.833;
/** "Sunset to sunrise" hours where the time zone has no coordinates. */
const FALLBACK_HOURS = { from: '20:00', to: '07:00' };
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ZONE_TABLES = ['zone1970.tab', 'zone.tab'];
const ZONEINFO_DIRS = ['/etc/zoneinfo', '/usr/share/zoneinfo'];

type Schedule = 'always' | 'sunset' | 'custom';

interface NightLightSettings {
  enabled: boolean;
  temperature: number;
  schedule: Schedule;
  /** Custom hours, "HH:MM" in local time. */
  from: string;
  to: string;
}

/** The night-light half of the brightness state. */
export interface NightLightState extends NightLightSettings {
  /** False when no gamma tool is installed. */
  available: boolean;
  /** Whether the screen is tinted right now. */
  active: boolean;
  /** When the schedule next turns the tint on or off (ms since the epoch), if it will. */
  nextChange: number | null;
  /** The time zone whose sunset is used, or null where it has no coordinates. */
  place: string | null;
}

const DEFAULTS: NightLightSettings = {
  enabled: false,
  temperature: 4500,
  schedule: 'sunset',
  from: '22:00',
  to: '07:00',
};

let settings: NightLightSettings = { ...DEFAULTS };
let toolName: string | null = null;
let probe: Promise<string | null> | null = null;
let proc: ChildProcess | null = null;
/** A tool fading out after SIGTERM, until it exits. */
let leaving: ChildProcess | null = null;
let lastExit: Promise<void> = Promise.resolve();
/** Set when the tool died on its own, so the schedule doesn't respawn it forever. */
let gaveUp = false;
let queue: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setInterval> | null = null;

/** Run night-light changes one at a time, in order. */
function serially<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'night-light.json');
}

/** Clamp a caller-supplied color temperature to an integer in the useful range. */
export function clampTemperature(kelvin: unknown): number {
  const n = Number(kelvin);
  if (!Number.isFinite(n)) throw new Error('Invalid temperature');
  return Math.max(MIN_TEMPERATURE, Math.min(MAX_TEMPERATURE, Math.round(n)));
}

function isSchedule(value: unknown): value is Schedule {
  return value === 'always' || value === 'sunset' || value === 'custom';
}

function readSettings(): NightLightSettings {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (!data || typeof data !== 'object') return { ...DEFAULTS };
    const saved = data as Partial<Record<keyof NightLightSettings, unknown>>;
    return {
      enabled: saved.enabled === true,
      temperature: Number.isFinite(saved.temperature) ? clampTemperature(saved.temperature) : DEFAULTS.temperature,
      schedule: isSchedule(saved.schedule) ? saved.schedule : DEFAULTS.schedule,
      from: typeof saved.from === 'string' && TIME_OF_DAY.test(saved.from) ? saved.from : DEFAULTS.from,
      to: typeof saved.to === 'string' && TIME_OF_DAY.test(saved.to) ? saved.to : DEFAULTS.to,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.warn('night light: could not save the settings:', error instanceof Error ? error.message : error);
  }
}

// --- The time zone and its coordinates. ---

/** The system's time zone: /etc/localtime's target, which follows a change at once. */
function currentZone(): string {
  try {
    const target = fs.readlinkSync('/etc/localtime');
    const at = target.lastIndexOf('zoneinfo/');
    if (at !== -1) return target.slice(at + 'zoneinfo/'.length);
  } catch {
    // Not a link (or missing); fall back to what ICU thinks.
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** An ISO 6709 coordinate from zone.tab, e.g. "+4151" or "-0873900", in degrees. */
function parseCoordinate(text: string, degreeDigits: number): number {
  const sign = text[0] === '-' ? -1 : 1;
  const digits = text.slice(1);
  const degrees = Number(digits.slice(0, degreeDigits));
  const minutes = Number(digits.slice(degreeDigits, degreeDigits + 2));
  const seconds = Number(digits.slice(degreeDigits + 2) || 0);
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

const coordinateCache = new Map<string, { lat: number; lon: number } | null>();

/** Latitude and longitude of a zone's principal city, or null. */
function zoneCoordinates(zone: string): { lat: number; lon: number } | null {
  if (coordinateCache.has(zone)) return coordinateCache.get(zone) ?? null;
  let found: { lat: number; lon: number } | null = null;
  search: for (const dir of ZONEINFO_DIRS) {
    for (const table of ZONE_TABLES) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, table), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (line.startsWith('#')) continue;
        const [, coordinates, name] = line.split('\t');
        if (name !== zone || !coordinates) continue;
        const match = coordinates.match(/^([+-]\d+)([+-]\d+)$/);
        if (!match) continue;
        found = { lat: parseCoordinate(match[1], 2), lon: parseCoordinate(match[2], 3) };
        break search;
      }
    }
  }
  coordinateCache.set(zone, found);
  return found;
}

/** The sun's elevation in degrees at a time and place (NOAA's approximation). */
function sunElevation(time: number, lat: number, lon: number): number {
  const rad = Math.PI / 180;
  const n = time / 86_400_000 + 2440587.5 - 2451545.0; // days since J2000
  const meanLongitude = (280.46 + 0.9856474 * n) % 360;
  const anomaly = ((357.528 + 0.9856003 * n) % 360) * rad;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * rad;
  const obliquity = (23.439 - 0.0000004 * n) * rad;
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const siderealHours = (18.697374558 + 24.06570982441908 * n) % 24;
  const hourAngle = (siderealHours * 15 + lon) * rad - rightAscension;
  const elevation = Math.asin(
    Math.sin(lat * rad) * Math.sin(declination) +
      Math.cos(lat * rad) * Math.cos(declination) * Math.cos(hourAngle),
  );
  return elevation / rad;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes since local midnight in a zone. */
function minuteOfDay(time: number, zone: string): number {
  let formatter = formatters.get(zone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    }
    formatters.set(zone, formatter);
  }
  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(time)) {
    if (part.type === 'hour') hour = Number(part.value);
    if (part.type === 'minute') minute = Number(part.value);
  }
  return hour * 60 + minute;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Whether local time falls in from..to, which may cross midnight. Equal ends mean all day. */
function inHours(time: number, zone: string, from: string, to: string): boolean {
  const now = minuteOfDay(time, zone);
  const start = minutesOf(from);
  const end = minutesOf(to);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** A function telling whether the schedule wants the tint at a time. */
function scheduleTest(): { test: (time: number) => boolean; place: string | null } {
  const zone = currentZone();
  if (settings.schedule === 'always') return { test: () => true, place: null };
  if (settings.schedule === 'custom') {
    return { test: (t) => inHours(t, zone, settings.from, settings.to), place: null };
  }
  const where = zoneCoordinates(zone);
  if (!where) {
    return { test: (t) => inHours(t, zone, FALLBACK_HOURS.from, FALLBACK_HOURS.to), place: null };
  }
  return { test: (t) => sunElevation(t, where.lat, where.lon) < SUNSET_ELEVATION, place: zone };
}

/** The next minute, within two days, at which the schedule changes its mind. */
function nextChange(test: (time: number) => boolean, now: number): number | null {
  const wanted = test(now);
  let t = Math.ceil(now / 60_000) * 60_000;
  for (let i = 0; i < 2 * 24 * 60; i++, t += 60_000) {
    if (test(t) !== wanted) return t;
  }
  return null;
}

// --- The gamma tool. ---

/** Find and cache the first gamma tool that's installed. */
export function ensureNightLightTool(): Promise<string | null> {
  probe ??= (async () => {
    for (const name of TOOLS) {
      try {
        await runCommand(name, ['-V'], { timeout: 3_000 });
        return name;
      } catch (error) {
        // Anything but a missing binary (an unknown flag, say) still means
        // it's there and runs.
        if (!(error instanceof CommandError && error.code === 'ENOENT')) return name;
      }
    }
    return null;
  })().then((name) => (toolName = name));
  return probe;
}

/** Argv that holds a fixed color temperature; `fade` eases it in and out. */
function toolArgs(name: string, temp: number, fade: boolean): string[] {
  if (name === 'wlsunset') {
    // wlsunset needs night < day and a schedule; pin the schedule so it stays
    // at the night temperature essentially all day.
    return ['-t', String(temp), '-T', String(temp + 500), '-S', '23:59', '-s', '00:00'];
  }
  // gammastep: a made-up location with equal day and night temperatures.
  return ['-l', '0:0', '-t', `${temp}:${temp}`, ...(fade ? [] : ['-r'])];
}

/** Stop the tool; with `fade`, it eases back to neutral first. Resolves once it's gone. */
function stopTool(fade: boolean): Promise<void> {
  const running = proc ?? leaving;
  proc = null;
  leaving = fade ? running : null;
  if (running) {
    try {
      running.kill(fade ? 'SIGTERM' : 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  return lastExit;
}

async function startTool(fade: boolean): Promise<void> {
  const name = await ensureNightLightTool();
  if (!name) return;
  // Cut short any fade-out; the output's gamma control is exclusive, so the
  // old one has to let go first.
  await stopTool(false);
  const child = spawn(name, toolArgs(name, settings.temperature, fade), { stdio: 'ignore' });
  lastExit = new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const gone = () => {
    if (leaving === child) leaving = null;
    if (proc === child) {
      proc = null;
      gaveUp = true;
    }
  };
  child.once('exit', gone);
  child.once('error', gone);
  proc = child;
}

/** Bring the tool in line with the settings and the schedule. */
async function apply(restart = false): Promise<void> {
  const wanted = settings.enabled && scheduleTest().test(Date.now());
  if (!wanted) {
    gaveUp = false;
    // Let it fade out in the background; starting again cuts that short.
    if (proc) void stopTool(true);
    return;
  }
  if (restart && proc) await startTool(false);
  else if (!proc && !gaveUp) await startTool(true);
}

export function nightLightStatus(): NightLightState {
  const { test, place } = scheduleTest();
  const now = Date.now();
  return {
    ...settings,
    available: toolName !== null,
    active: proc !== null,
    nextChange: settings.enabled && settings.schedule !== 'always' ? nextChange(test, now) : null,
    place: settings.schedule === 'sunset' ? place : null,
  };
}

export function setNightLightEnabled(enabled: boolean): Promise<void> {
  return serially(async () => {
    if (enabled && !(await ensureNightLightTool())) throw new Error('night-light-missing');
    settings = { ...settings, enabled };
    gaveUp = false;
    saveSettings();
    await apply();
  });
}

export function setNightLightTemperature(kelvin: unknown): Promise<void> {
  const temperature = clampTemperature(kelvin);
  return serially(async () => {
    settings = { ...settings, temperature };
    saveSettings();
    await apply(true);
  });
}

export function setNightLightSchedule(value: unknown): Promise<void> {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  if (!isSchedule(input.schedule)) throw new Error('Invalid schedule');
  for (const end of [input.from, input.to]) {
    if (typeof end !== 'string' || !TIME_OF_DAY.test(end)) throw new Error('Invalid time');
  }
  const schedule = input.schedule;
  const from = input.from as string;
  const to = input.to as string;
  return serially(async () => {
    settings = { ...settings, schedule, from, to };
    gaveUp = false;
    saveSettings();
    await apply();
  });
}

/** Load the saved settings and start following the schedule. */
export function startNightLight(): void {
  settings = readSettings();
  void ensureNightLightTool().then(() => serially(() => apply()));
  timer ??= setInterval(() => void serially(() => apply()), TICK_MS);
}

/** Drop the tint at once, for quitting. */
export function stopNightLight(): void {
  if (timer) clearInterval(timer);
  timer = null;
  void stopTool(false);
}
