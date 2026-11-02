import { nip19 } from 'nostr-tools';
import {
  calendarFilters,
  calendarTemplate,
  collectCalendar,
  coordOf,
  deletionTemplate,
  describeWhen,
  eventsBetween,
  eventTemplate,
  HEX64,
  isoDate,
  parseIsoDate,
  rsvpTemplate,
  type CalendarData,
  type CalendarEvent,
  type EventTemplate,
  type Participant,
  type RsvpStatus,
} from '@/shared/calendar';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { call, command, pick } from './util';

/**
 * `din calendar`: the signed-in account's NIP-52 calendar, as Calendar
 * shows it (src/shared/calendar.ts): what's coming up, adding an event,
 * answering an invitation, deleting an event (asks on screen first), and
 * opening Calendar on a day.
 */

const DAY_MS = 86_400_000;
const EVENT: Param = { name: 'event', type: 'string', positional: true, help: 'The event, by title (or its d tag)' };
const ANSWERS: Record<string, RsvpStatus> = { going: 'accepted', yes: 'accepted', accepted: 'accepted', maybe: 'tentative', tentative: 'tentative', no: 'declined', declined: 'declined', 'not-going': 'declined' };

function user(ctx: CommandContext): string {
  if (!ctx.pubkey) throw new CommandError('No one is signed in');
  return ctx.pubkey;
}

async function load(ctx: CommandContext): Promise<{ pubkey: string; data: CalendarData }> {
  const pubkey = user(ctx);
  const raw = await call(ctx.query(calendarFilters(pubkey)));
  return { pubkey, data: collectCalendar(raw, pubkey) };
}

/** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` (or with a `T`), local time. */
function parseWhen(value: string, what: string): { time: number; dateOnly: boolean } {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(value.trim());
  const day = m ? parseIsoDate(m[1]) : null;
  if (!m || !day) throw new CommandError(`${what} isn’t a date (YYYY-MM-DD) or a date and time (YYYY-MM-DD HH:MM): ${value}`, 'usage');
  if (m[2] === undefined) return { time: day.getTime(), dateOnly: true };
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) throw new CommandError(`${what} isn’t a time of day: ${value}`, 'usage');
  return { time: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, min).getTime(), dateOnly: false };
}

function participant(value: string): Participant {
  const s = value.trim().replace(/^nostr:/, '');
  if (HEX64.test(s)) return { pubkey: s };
  try {
    const d = nip19.decode(s);
    if (d.type === 'npub') return { pubkey: d.data };
    if (d.type === 'nprofile') return { pubkey: d.data.pubkey };
  } catch {
    // Below.
  }
  throw new CommandError(`Not an npub or a public key: ${value}`, 'usage');
}

function summary(e: CalendarEvent, data: CalendarData, pubkey: string) {
  const rsvp = data.rsvps.get(e.coord)?.status ?? null;
  return {
    title: e.title,
    when: describeWhen(e),
    start: new Date(e.start).toISOString(),
    end: new Date(e.end).toISOString(),
    allDay: e.allDay,
    location: e.locations[0],
    mine: e.pubkey === pubkey,
    answer: e.pubkey === pubkey ? undefined : rsvp,
    calendar: data.calendars.find((c) => c.members.includes(e.coord))?.title,
    link: `nostr:${nip19.naddrEncode({ kind: e.kind, pubkey: e.pubkey, identifier: e.d })}`,
  };
}

/** One event, by title or d tag; upcoming ones first when titles repeat. */
function findEvent(data: CalendarData, query: string, filter: (e: CalendarEvent) => boolean = () => true): CalendarEvent {
  const now = Date.now();
  const list = [...data.events.values()].filter(filter).sort((a, b) => Number(b.end >= now) - Number(a.end >= now) || a.start - b.start);
  const upcoming = list.filter((e) => e.end >= now);
  try {
    return pick(upcoming, query, (e) => [e.d, e.title], 'upcoming event');
  } catch {
    return pick(list, query, (e) => [e.d, e.title], 'event');
  }
}

const ANSWER_TEXT: Record<RsvpStatus, string> = { accepted: 'going', tentative: 'maybe', declined: 'not going' };

export const calendarArea: Area = {
  name: 'calendar',
  summary: 'Your calendar on Nostr (NIP-52): what’s coming up, add an event, answer invitations, delete; open Calendar',
  commands: [
    command('calendar', 'list', 'Events coming up, yours and ones you’re invited to', [
      { name: 'days', type: 'integer', optional: true, min: 1, max: 366, help: 'How many days ahead (default: 14)' },
      { name: 'from', type: 'string', optional: true, help: 'The first day, YYYY-MM-DD (default: today)' },
    ], async (args, ctx) => {
      const { pubkey, data } = await load(ctx);
      const fromArg = args.optString('from');
      const from = fromArg ? parseWhen(fromArg, 'from').time : new Date(new Date().setHours(0, 0, 0, 0)).getTime();
      const to = from + (args.optNumber('days') ?? 14) * DAY_MS;
      const events = eventsBetween(data.events.values(), from, to).map((e) => summary(e, data, pubkey));
      return {
        data: events,
        text: events.length
          ? events.map((e) => `${e.when}  ${e.title}${e.location ? ` @ ${e.location}` : ''}${e.mine ? '' : ` (invited${e.answer ? `, ${ANSWER_TEXT[e.answer]}` : ', not answered'})`}`).join('\n')
          : 'Nothing on the calendar',
      };
    }),
    command('calendar', 'add', 'Add an event to your calendar (it’s public, as Nostr calendar events are)', [
      { name: 'title', type: 'string', positional: true, rest: true, help: 'What it is' },
      { name: 'start', type: 'string', help: 'When it starts: YYYY-MM-DD HH:MM, or YYYY-MM-DD for all day' },
      { name: 'end', type: 'string', optional: true, help: 'When it ends (default: an hour later, or the same day)' },
      { name: 'location', type: 'string', optional: true, help: 'Where, or a video call link' },
      { name: 'notes', type: 'string', optional: true, help: 'A description' },
      { name: 'invite', type: 'string', optional: true, help: 'People to invite: npubs, separated by commas' },
      { name: 'calendar', type: 'string', optional: true, help: 'One of your calendars to put it in, by name' },
    ], async (args, ctx) => {
      const title = args.list('title').join(' ').trim();
      if (!title) throw new CommandError('Missing title', 'usage');
      const start = parseWhen(args.string('start'), 'start');
      const endArg = args.optString('end');
      const end = endArg ? parseWhen(endArg, 'end') : null;
      const allDay = start.dateOnly && (!end || end.dateOnly);
      if (end && end.dateOnly !== start.dateOnly) throw new CommandError('Give start and end both as dates, or both with times', 'usage');
      // An all-day end names its last day; the event's end is the day after.
      const endTime = allDay ? (end ? end.time + DAY_MS : start.time + DAY_MS) : end ? end.time : start.time + 3_600_000;
      if (allDay ? endTime <= start.time : endTime < start.time) throw new CommandError('It has to end after it starts', 'usage');
      const { pubkey, data } = await load(ctx);
      const calendarName = args.optString('calendar');
      const calendar = calendarName ? pick(data.calendars, calendarName, (c) => [c.d, c.title], 'calendar') : null;
      const template = eventTemplate({
        title,
        description: args.optString('notes') ?? '',
        allDay,
        start: start.time,
        end: endTime,
        tzid: allDay ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone,
        locations: args.optString('location') ? [args.optString('location')!] : [],
        participants: (args.optString('invite') ?? '').split(',').filter((s) => s.trim()).map(participant),
        hashtags: [],
        links: [],
        calendar: calendar?.coord ?? null,
      });
      const templates: EventTemplate[] = [template];
      if (calendar) {
        const d = template.tags.find((t) => t[0] === 'd')![1];
        templates.push(calendarTemplate(calendar.title, [...calendar.members, coordOf(template.kind, pubkey, d)], calendar));
      }
      for (const t of templates) await call(ctx.publish(t));
      return { text: `Added “${title}”, ${describeWhen({ allDay, start: start.time, end: endTime })}` };
    }),
    command('calendar', 'rsvp', 'Answer an invitation: going, maybe or no', [
      EVENT,
      { name: 'answer', type: 'string', positional: true, choices: ['going', 'maybe', 'no'], help: 'going, maybe or no' },
    ], async (args, ctx) => {
      const { pubkey, data } = await load(ctx);
      const status = ANSWERS[args.string('answer').toLowerCase()];
      if (!status) throw new CommandError('Answer going, maybe or no', 'usage');
      const e = findEvent(data, args.string('event'), (x) => x.pubkey !== pubkey);
      await call(ctx.publish(rsvpTemplate(e, status, data.rsvps.get(e.coord))));
      return { text: `${ANSWER_TEXT[status][0].toUpperCase()}${ANSWER_TEXT[status].slice(1)}: ${e.title}, ${describeWhen(e)}` };
    }),
    command('calendar', 'delete', 'Delete one of your events (asks on screen first)', [EVENT], async (args, ctx) => {
      const { pubkey, data } = await load(ctx);
      const e = findEvent(data, args.string('event'), (x) => x.pubkey === pubkey);
      const ok = await ctx.confirm({
        title: `Delete “${e.title}”?`,
        description: `${describeWhen(e)}. Your relays are asked to delete it${e.participants.length ? ', and the people you invited see it go' : ''}.`,
        action: 'Delete',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      const templates: EventTemplate[] = [deletionTemplate(e)];
      for (const c of data.calendars) if (c.members.includes(e.coord)) templates.push(calendarTemplate(c.title, c.members.filter((m) => m !== e.coord), c));
      for (const t of templates) await call(ctx.publish(t));
      return { text: `Deleted “${e.title}”` };
    }),
    command('calendar', 'open', 'Open Calendar, on a day if given', [
      { name: 'date', type: 'string', positional: true, optional: true, help: 'The day, YYYY-MM-DD' },
      { name: 'view', type: 'string', optional: true, choices: ['day', 'week', 'month'], help: 'day, week or month' },
    ], (args, ctx) => {
      const date = args.optString('date');
      if (date && !parseIsoDate(date)) throw new CommandError(`Not a date (YYYY-MM-DD): ${date}`, 'usage');
      ctx.actions.open('calendar', { ...(date ? { date: isoDate(parseIsoDate(date)!) } : {}), ...(args.optString('view') ? { view: args.optString('view') } : {}) });
    }),
  ],
};
