/**
 * NIP-52 calendar events, calendars and RSVPs: reading them off relays and
 * writing them back. Calendar and the `din calendar` command share it, so
 * what one makes the other reads the same way.
 */
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

export const DATE_KIND = 31922;
export const TIME_KIND = 31923;
export const CALENDAR_KIND = 31924;
export const RSVP_KIND = 31925;
export const EVENT_KINDS = [DATE_KIND, TIME_KIND];

const DAY_MS = 86_400_000;

export interface Participant {
  pubkey: string;
  relay?: string;
  role?: string;
}

/** A calendar event (kind 31922 or 31923), as the calendar draws it. */
export interface CalendarEvent {
  /** The newest revision seen. */
  event: NostrEvent;
  /** `kind:pubkey:d`, what RSVPs and calendars point at. */
  coord: string;
  kind: number;
  pubkey: string;
  d: string;
  title: string;
  summary: string;
  description: string;
  image?: string;
  locations: string[];
  hashtags: string[];
  links: string[];
  participants: Participant[];
  /** Calendars (31924 coordinates) it asks to be in. */
  calendars: string[];
  /** A date-based event: whole days, wherever the viewer is. */
  allDay: boolean;
  /** Milliseconds. For an all-day event, local midnight of its first day. */
  start: number;
  /** Milliseconds, exclusive. Equal to `start` for an instant. */
  end: number;
  /** The time zone it was made in (time-based only). */
  tzid?: string;
}

/** A calendar (kind 31924): a named list of calendar events. */
export interface CalendarList {
  event: NostrEvent;
  coord: string;
  d: string;
  title: string;
  description: string;
  /** The calendar events in it, by coordinate. */
  members: string[];
}

export type RsvpStatus = 'accepted' | 'tentative' | 'declined';
export const RSVP_STATUSES: readonly RsvpStatus[] = ['accepted', 'tentative', 'declined'];

export interface Rsvp {
  event: NostrEvent;
  pubkey: string;
  d: string;
  /** The calendar event it answers. */
  coord: string;
  status: RsvpStatus;
  note: string;
}

/** What the editor fills in to make or change a calendar event. */
export interface EventDraft {
  title: string;
  description: string;
  allDay: boolean;
  /** Milliseconds; for all-day, local midnight of the first day. */
  start: number;
  /** Milliseconds, exclusive; for all-day, local midnight after the last day. */
  end: number;
  tzid?: string;
  locations: string[];
  participants: Participant[];
  hashtags: string[];
  links: string[];
  /** The calendar (31924 coordinate) it goes in, or null. */
  calendar: string | null;
}

export interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

const tag = (event: NostrEvent, name: string) => event.tags.find((t) => t[0] === name)?.[1];
const tags = (event: NostrEvent, name: string) => event.tags.filter((t) => t[0] === name && typeof t[1] === 'string').map((t) => t[1]);
const now = () => Math.floor(Date.now() / 1000);

export const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function coordOf(kind: number, pubkey: string, d: string): string {
  return `${kind}:${pubkey}:${d}`;
}

export function parseCoord(coord: string): { kind: number; pubkey: string; d: string } | null {
  const m = /^(\d+):([0-9a-f]{64}):(.*)$/s.exec(coord);
  return m ? { kind: Number(m[1]), pubkey: m[2], d: m[3] } : null;
}

/** `YYYY-MM-DD` of a local date. */
export function isoDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Local midnight of a `YYYY-MM-DD`, or null if it isn't one. */
export function parseIsoDate(value: string): Date | null {
  const m = ISO_DATE.exec(value.trim());
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return date.getMonth() === Number(m[2]) - 1 ? date : null;
}

/** A random identifier for a `d` tag. */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseCalendarEvent(event: NostrEvent): CalendarEvent | null {
  if (event.kind !== DATE_KIND && event.kind !== TIME_KIND) return null;
  const d = tag(event, 'd');
  const title = (tag(event, 'title') || tag(event, 'name') || '').trim();
  const startTag = tag(event, 'start');
  if (d === undefined || !startTag) return null;
  const endTag = tag(event, 'end');
  let start: number;
  let end: number;
  if (event.kind === DATE_KIND) {
    const s = parseIsoDate(startTag);
    if (!s) return null;
    start = s.getTime();
    const e = endTag ? parseIsoDate(endTag) : null;
    end = e && e.getTime() > start ? e.getTime() : new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1).getTime();
  } else {
    if (!/^\d{1,12}$/.test(startTag)) return null;
    start = Number(startTag) * 1000;
    const e = endTag && /^\d{1,12}$/.test(endTag) ? Number(endTag) * 1000 : start;
    end = e > start ? e : start;
  }
  return {
    event,
    coord: coordOf(event.kind, event.pubkey, d),
    kind: event.kind,
    pubkey: event.pubkey,
    d,
    title: title || 'Untitled event',
    summary: tag(event, 'summary') ?? '',
    description: event.content,
    image: tag(event, 'image'),
    locations: tags(event, 'location').filter((l) => l.trim()),
    hashtags: tags(event, 't'),
    links: tags(event, 'r'),
    participants: event.tags
      .filter((t) => t[0] === 'p' && HEX64.test(t[1] ?? ''))
      .map((t) => ({ pubkey: t[1], relay: t[2] || undefined, role: t[3] || undefined })),
    calendars: tags(event, 'a').filter((a) => a.startsWith(`${CALENDAR_KIND}:`)),
    allDay: event.kind === DATE_KIND,
    start,
    end,
    tzid: event.kind === TIME_KIND ? tag(event, 'start_tzid') : undefined,
  };
}

export function parseCalendarList(event: NostrEvent): CalendarList | null {
  if (event.kind !== CALENDAR_KIND) return null;
  const d = tag(event, 'd');
  if (d === undefined) return null;
  return {
    event,
    coord: coordOf(CALENDAR_KIND, event.pubkey, d),
    d,
    title: (tag(event, 'title') || tag(event, 'name') || '').trim() || 'Untitled calendar',
    description: event.content,
    members: tags(event, 'a').filter((a) => a.startsWith(`${DATE_KIND}:`) || a.startsWith(`${TIME_KIND}:`)),
  };
}

export function parseRsvp(event: NostrEvent): Rsvp | null {
  if (event.kind !== RSVP_KIND) return null;
  const coord = tag(event, 'a');
  const d = tag(event, 'd');
  // `status` now; an `l` tag with the `status` label before that.
  const raw = tag(event, 'status') ?? event.tags.find((t) => t[0] === 'l' && t[2] === 'status')?.[1];
  const status = raw?.toLowerCase();
  if (!coord || d === undefined || !RSVP_STATUSES.includes(status as RsvpStatus)) return null;
  return { event, pubkey: event.pubkey, d, coord, status: status as RsvpStatus, note: event.content };
}

/** Day numbers since the epoch (`D` tags) an event covers, at most a year of them. */
function dayTags(start: number, end: number): string[][] {
  const first = Math.floor(start / DAY_MS);
  const last = Math.max(first, Math.floor((Math.max(end, start + 1) - 1) / DAY_MS));
  const out: string[][] = [];
  for (let day = first; day <= last && out.length < 366; day++) out.push(['D', String(day)]);
  return out;
}

/** Tags this module writes; any others on an event being changed are kept as they were. */
const MANAGED = new Set(['d', 'title', 'name', 'start', 'end', 'start_tzid', 'end_tzid', 'D', 'location', 'p', 't', 'r', 'a', 'alt']);

/** A calendar event to sign, new or (with `previous`) a revision of one. */
export function eventTemplate(draft: EventDraft, previous?: CalendarEvent | null): EventTemplate {
  const kind = draft.allDay ? DATE_KIND : TIME_KIND;
  const sameKind = previous?.kind === kind;
  const d = sameKind ? previous.d : randomId();
  const out: string[][] = [['d', d], ['title', draft.title.trim() || 'Untitled event']];
  if (draft.allDay) {
    const start = new Date(draft.start);
    const end = new Date(Math.max(draft.end, draft.start + DAY_MS));
    out.push(['start', isoDate(start)]);
    // An end only when it's more than the one day `start` alone means.
    const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    if (isoDate(end) !== isoDate(next)) out.push(['end', isoDate(end)]);
  } else {
    const start = Math.floor(draft.start / 1000);
    const end = Math.floor(draft.end / 1000);
    out.push(['start', String(start)]);
    if (end > start) out.push(['end', String(end)]);
    out.push(...dayTags(draft.start, draft.end));
    if (draft.tzid) out.push(['start_tzid', draft.tzid]);
  }
  for (const l of draft.locations) if (l.trim()) out.push(['location', l.trim()]);
  const seen = new Set<string>();
  for (const p of draft.participants) {
    if (!HEX64.test(p.pubkey) || seen.has(p.pubkey)) continue;
    seen.add(p.pubkey);
    out.push(p.role ? ['p', p.pubkey, p.relay ?? '', p.role] : p.relay ? ['p', p.pubkey, p.relay] : ['p', p.pubkey]);
  }
  for (const t of draft.hashtags) if (t.trim()) out.push(['t', t.trim().replace(/^#/, '').toLowerCase()]);
  for (const r of draft.links) if (r.trim()) out.push(['r', r.trim()]);
  if (draft.calendar) out.push(['a', draft.calendar]);
  if (previous) out.push(...previous.event.tags.filter((t) => !MANAGED.has(t[0])));
  out.push(['alt', `Calendar event: ${draft.title.trim() || 'Untitled event'}`]);
  return { kind, content: draft.description, tags: out, created_at: now() };
}

/** A NIP-09 deletion of a calendar event (or calendar, or RSVP). */
export function deletionTemplate(target: { event: NostrEvent; coord: string }): EventTemplate {
  return {
    kind: 5,
    content: '',
    tags: [['e', target.event.id], ['a', target.coord], ['k', String(target.event.kind)]],
    created_at: now(),
  };
}

/** An answer to a calendar event, replacing `previous` (the user's last answer to it) if given. */
export function rsvpTemplate(target: CalendarEvent, status: RsvpStatus, previous?: Rsvp | null, note = ''): EventTemplate {
  const out = [
    ['a', target.coord],
    ['e', target.event.id],
    ['d', previous?.d ?? randomId()],
    ['status', status],
    ['p', target.pubkey],
  ];
  if (status !== 'declined') out.push(['fb', status === 'accepted' ? 'busy' : 'free']);
  return { kind: RSVP_KIND, content: note, tags: out, created_at: now() };
}

/** A calendar to sign: new (no `previous`) or a revision with these members. */
export function calendarTemplate(title: string, members: readonly string[], previous?: CalendarList | null): EventTemplate {
  const out: string[][] = [['d', previous?.d ?? randomId()], ['title', title.trim() || 'Untitled calendar']];
  for (const m of new Set(members)) out.push(['a', m]);
  if (previous) out.push(...previous.event.tags.filter((t) => !['d', 'title', 'name', 'a'].includes(t[0])));
  return { kind: CALENDAR_KIND, content: previous?.description ?? '', tags: out, created_at: now() };
}

/** What to ask relays for to show a user's calendar. */
export function calendarFilters(pubkey: string): NostrFilter[] {
  return [
    { kinds: EVENT_KINDS, authors: [pubkey], limit: 2000 },
    { kinds: EVENT_KINDS, '#p': [pubkey], limit: 1000 },
    { kinds: [CALENDAR_KIND], authors: [pubkey], limit: 100 },
    { kinds: [RSVP_KIND], authors: [pubkey], limit: 2000 },
    { kinds: [5], authors: [pubkey], '#k': EVENT_KINDS.map(String).concat(String(CALENDAR_KIND)), limit: 1000 },
  ];
}

/** Filters for calendar events by coordinate (a calendar's members by other people). */
export function coordFilters(coords: readonly string[]): NostrFilter[] {
  const byAuthor = new Map<string, { kinds: Set<number>; ds: Set<string> }>();
  for (const c of coords) {
    const p = parseCoord(c);
    if (!p) continue;
    const entry = byAuthor.get(p.pubkey) ?? { kinds: new Set(), ds: new Set() };
    entry.kinds.add(p.kind);
    entry.ds.add(p.d);
    byAuthor.set(p.pubkey, entry);
  }
  return [...byAuthor].map(([pubkey, { kinds, ds }]) => ({ kinds: [...kinds], authors: [pubkey], '#d': [...ds] }));
}

export interface CalendarData {
  /** Every calendar event, the newest revision of each, by coordinate. */
  events: Map<string, CalendarEvent>;
  /** The user's calendars, by title. */
  calendars: CalendarList[];
  /** The user's answers, by the calendar event's coordinate. */
  rsvps: Map<string, Rsvp>;
}

/**
 * Sort raw events into a calendar: the newest of each addressable event,
 * less what the user (or an event's own author) deleted.
 */
export function collectCalendar(raw: readonly NostrEvent[], pubkey: string): CalendarData {
  const deleted = new Map<string, number>();
  const deletedIds = new Set<string>();
  for (const e of raw) {
    if (e.kind !== 5) continue;
    for (const t of e.tags) {
      if (t[0] === 'a' && t[1]?.split(':')[1] === e.pubkey) deleted.set(t[1], Math.max(deleted.get(t[1]) ?? 0, e.created_at));
      if (t[0] === 'e' && t[1]) deletedIds.add(`${e.pubkey}:${t[1]}`);
    }
  }
  const gone = (coord: string, e: NostrEvent) => (deleted.get(coord) ?? -1) >= e.created_at || deletedIds.has(`${e.pubkey}:${e.id}`);
  const newer = (a: NostrEvent | undefined, b: NostrEvent) => !a || b.created_at > a.created_at || (b.created_at === a.created_at && b.id < a.id);

  const events = new Map<string, CalendarEvent>();
  const calendars = new Map<string, CalendarList>();
  const rsvps = new Map<string, Rsvp>();
  for (const e of raw) {
    if (e.kind === DATE_KIND || e.kind === TIME_KIND) {
      const c = parseCalendarEvent(e);
      if (c && newer(events.get(c.coord)?.event, e)) events.set(c.coord, c);
    } else if (e.kind === CALENDAR_KIND && e.pubkey === pubkey) {
      const c = parseCalendarList(e);
      if (c && newer(calendars.get(c.coord)?.event, e)) calendars.set(c.coord, c);
    } else if (e.kind === RSVP_KIND && e.pubkey === pubkey) {
      const r = parseRsvp(e);
      if (r && newer(rsvps.get(r.coord)?.event, e)) rsvps.set(r.coord, r);
    }
  }
  for (const [coord, c] of events) if (gone(coord, c.event)) events.delete(coord);
  for (const [coord, c] of calendars) if (gone(coord, c.event)) calendars.delete(coord);
  return {
    events,
    calendars: [...calendars.values()].sort((a, b) => a.title.localeCompare(b.title)),
    rsvps,
  };
}

/** The calendar events that touch [from, to), soonest first. */
export function eventsBetween<T extends Pick<CalendarEvent, 'start' | 'end' | 'allDay' | 'title'>>(events: Iterable<T>, from: number, to: number): T[] {
  const out: T[] = [];
  for (const e of events) {
    if (e.start < to && (e.end > from || (e.end === e.start && e.start >= from))) out.push(e);
  }
  return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
}

/** When an event is, in words: "Tue, Nov 3, 2:00 – 3:00 PM", "Nov 3 – 5 (all day)". */
export function describeWhen(e: Pick<CalendarEvent, 'allDay' | 'start' | 'end'>, locale?: string): string {
  if (e.allDay) {
    const last = new Date(e.end - 1);
    const days = Math.round((e.end - e.start) / DAY_MS);
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return days <= 1 ? `${fmt.format(e.start)}, all day` : `${fmt.formatRange(e.start, last.getTime())}, all day`;
  }
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return e.end > e.start ? fmt.formatRange(e.start, e.end) : fmt.format(e.start);
}
