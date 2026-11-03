/**
 * iCalendar (RFC 5545) events: reading a file's VEVENTs and writing one
 * back, as GNOME Calendar, Thunderbird and CalDAV servers do. Calendar keeps
 * one event per file (src/shared/localCalendar.ts); `din calendar` reads
 * them the same way. What this doesn't read (alarms, attendees, repeats…)
 * is kept as it came, so writing an event back loses nothing.
 */

const DAY_MS = 86_400_000;

export interface ICalEvent {
  uid: string;
  title: string;
  description: string;
  locations: string[];
  links: string[];
  /** CATEGORIES. */
  hashtags: string[];
  /** A date-based event: whole days, wherever the viewer is. */
  allDay: boolean;
  /** Milliseconds. For an all-day event, local midnight of its first day. */
  start: number;
  /** Milliseconds, exclusive. Equal to `start` for an instant. */
  end: number;
  /** The time zone its times are in; none for UTC or floating times. */
  tzid?: string;
  /** It has an RRULE or RDATE; only its first time is shown. */
  repeats: boolean;
  sequence: number;
  /** When it was made and last changed (ms); 0 when unknown. */
  created: number;
  updated: number;
  /** Lines (unfolded) and nested components this doesn't read, as they came. */
  extra: string[];
}

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
  text: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.trim() !== '');
}

function parseLine(text: string): Line | null {
  // NAME;PARAM=a;PARAM="b:c":value
  let i = 0;
  let quoted = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= text.length) return null;
  const head = text.slice(0, i);
  const value = text.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  const name = (parts[0] ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return name ? { name, params, value, text } : null;
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Split a comma-separated text list, minding escaped commas. */
function splitList(v: string): string[] {
  return (v.match(/(?:\\.|[^,])+/g) ?? []).map(unescapeText).map((s) => s.trim()).filter(Boolean);
}

/** The UTC offset (ms) of a time zone at an instant, or null if Intl doesn't know the zone. */
function zoneOffset(tz: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at / 1000) * 1000;
  } catch {
    return null;
  }
}

/** A zone name Intl knows, from a TZID (Thunderbird writes `/mozilla.org/…/Europe/Paris`). */
function knownZone(tzid: string | undefined): string | undefined {
  if (!tzid) return undefined;
  const candidates = [tzid, tzid.split('/').slice(-2).join('/'), tzid.split('/').slice(-3).join('/')];
  return candidates.find((z) => z && zoneOffset(z, 0) !== null);
}

/** The instant a wall-clock time in a zone names. */
function fromZoned(wall: number, tz: string): number {
  let t = wall - (zoneOffset(tz, wall) ?? 0);
  t = wall - (zoneOffset(tz, t) ?? 0);
  return t;
}

/** A DATE or DATE-TIME value as milliseconds, and whether it was a date. */
function parseTime(line: Line): { time: number; date: boolean; tzid?: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(line.value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (m[4] === undefined || line.params.VALUE === 'DATE') return { time: new Date(y, mo, d).getTime(), date: true };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (m[7]) return { time: Date.UTC(y, mo, d, h, mi, s), date: false };
  const zone = knownZone(line.params.TZID);
  if (zone) return { time: fromZoned(Date.UTC(y, mo, d, h, mi, s), zone), date: false, tzid: zone };
  // Floating: the same wall time wherever the viewer is.
  return { time: new Date(y, mo, d, h, mi, s).getTime(), date: false };
}

/** An RFC 5545 DURATION in milliseconds (`P1D`, `PT1H30M`, `-P1W`…). */
function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const ms = ((n(2) * 7 + n(3)) * 24 * 3600 + n(4) * 3600 + n(5) * 60 + n(6)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const MANAGED = new Set(['UID', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'CATEGORIES', 'DTSTART', 'DTEND', 'DURATION', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE']);

function parseEvent(lines: string[]): ICalEvent | null {
  const event: ICalEvent = {
    uid: '', title: '', description: '', locations: [], links: [], hashtags: [],
    allDay: false, start: 0, end: 0, repeats: false, sequence: 0, created: 0, updated: 0, extra: [],
  };
  let start: ReturnType<typeof parseTime> = null;
  let end: ReturnType<typeof parseTime> = null;
  let duration: number | null = null;
  let depth = 0;
  for (const text of lines) {
    const line = parseLine(text);
    if (!line) continue;
    // Alarms and other components inside the event are kept whole.
    if (line.name === 'BEGIN') depth++;
    if (depth > 0) {
      event.extra.push(text);
      if (line.name === 'END') depth--;
      continue;
    }
    switch (line.name) {
      case 'UID': event.uid = line.value.trim(); break;
      case 'SUMMARY': event.title = unescapeText(line.value).trim(); break;
      case 'DESCRIPTION': event.description = unescapeText(line.value); break;
      case 'LOCATION': if (unescapeText(line.value).trim()) event.locations.push(unescapeText(line.value).trim()); break;
      case 'URL': if (line.value.trim()) event.links.push(line.value.trim()); break;
      case 'CATEGORIES': event.hashtags.push(...splitList(line.value)); break;
      case 'DTSTART': start = parseTime(line); break;
      case 'DTEND': end = parseTime(line); break;
      case 'DURATION': duration = parseDuration(line.value); break;
      case 'SEQUENCE': event.sequence = Number.parseInt(line.value, 10) || 0; break;
      case 'CREATED': event.created = parseTime(line)?.time ?? 0; break;
      case 'LAST-MODIFIED': event.updated = parseTime(line)?.time ?? 0; break;
      case 'DTSTAMP': if (!event.updated) event.updated = parseTime(line)?.time ?? 0; break;
      default:
        if (line.name === 'RRULE' || line.name === 'RDATE') event.repeats = true;
        if (!MANAGED.has(line.name)) event.extra.push(text);
    }
  }
  if (!start || !event.uid) return null;
  event.allDay = start.date;
  event.start = start.time;
  event.tzid = start.tzid;
  if (end && end.time > start.time) event.end = end.time;
  else if (duration !== null && duration > 0) event.end = start.time + duration;
  else if (start.date) {
    const s = new Date(start.time);
    event.end = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1).getTime();
  } else event.end = start.time;
  if (!event.title) event.title = 'Untitled event';
  return event;
}

/**
 * The events in an iCalendar file: one each per UID, the main one (not an
 * override of one time of a repeating event, which has a RECURRENCE-ID).
 */
export function parseICalendar(text: string): ICalEvent[] {
  const lines = unfold(text);
  const out: ICalEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^BEGIN:VEVENT$/i.test(lines[i].trim())) continue;
    let depth = 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^BEGIN:/i.test(lines[j])) depth++;
      else if (/^END:/i.test(lines[j])) {
        if (depth === 0) break;
        depth--;
      }
    }
    const body = lines.slice(i + 1, j);
    i = j;
    if (body.some((l) => /^RECURRENCE-ID[;:]/i.test(l))) continue;
    const event = parseEvent(body);
    if (event) out.push(event);
  }
  return out;
}

/** Fold a content line at 75 octets, as RFC 5545 asks. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function utcStamp(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function dateValue(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** `;TZID=Zone:YYYYMMDDTHHMMSS` for a zone Intl knows, else UTC. */
function timeProperty(name: string, t: number, tzid?: string): string {
  const offset = tzid ? zoneOffset(tzid, t) : null;
  if (!tzid || offset === null) return `${name}:${utcStamp(t)}`;
  return `${name};TZID=${tzid}:${utcStamp(t + offset).slice(0, -1)}`;
}

/** One event as a whole iCalendar file. */
export function serializeICalendar(e: ICalEvent): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Din//Calendar//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT'];
  lines.push(`UID:${e.uid}`);
  lines.push(`DTSTAMP:${utcStamp(e.updated || Date.now())}`);
  if (e.created) lines.push(`CREATED:${utcStamp(e.created)}`);
  if (e.updated) lines.push(`LAST-MODIFIED:${utcStamp(e.updated)}`);
  if (e.sequence) lines.push(`SEQUENCE:${e.sequence}`);
  if (e.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateValue(e.start)}`);
    lines.push(`DTEND;VALUE=DATE:${dateValue(Math.max(e.end, e.start + DAY_MS))}`);
  } else {
    lines.push(timeProperty('DTSTART', e.start, e.tzid));
    if (e.end > e.start) lines.push(timeProperty('DTEND', e.end, e.tzid));
  }
  lines.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  for (const l of e.locations) if (l.trim()) lines.push(`LOCATION:${escapeText(l.trim())}`);
  for (const u of e.links) if (u.trim()) lines.push(`URL:${u.trim()}`);
  if (e.hashtags.length) lines.push(`CATEGORIES:${e.hashtags.map(escapeText).join(',')}`);
  lines.push(...e.extra);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/**
 * A file's text without the event of this UID (and any overrides of its
 * times), everything else as it was; null when no event is left in it.
 */
export function removeEvent(text: string, uid: string): string | null {
  const lines = unfold(text);
  const out: string[] = [];
  let left = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^BEGIN:VEVENT$/i.test(lines[i].trim())) {
      out.push(lines[i]);
      continue;
    }
    let depth = 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^BEGIN:/i.test(lines[j])) depth++;
      else if (/^END:/i.test(lines[j])) {
        if (depth === 0) break;
        depth--;
      }
    }
    const block = lines.slice(i, j + 1);
    const own = block.some((l) => parseLine(l)?.name === 'UID' && parseLine(l)?.value.trim() === uid);
    if (!own) {
      out.push(...block);
      left++;
    }
    i = j;
  }
  return left ? `${out.map(fold).join('\r\n')}\r\n` : null;
}
