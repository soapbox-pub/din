import { nip19 } from 'nostr-tools';
import { getFsBridge } from '@/lib/fs';
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
import {
  createCalendar,
  deleteCalendar,
  deleteLocalEvent,
  loadLocalCalendars,
  renameCalendar,
  saveLocalEvent,
  setCalendarColor,
  setNostrCalendar,
  type CalendarFs,
  type LocalCalendar,
  type LocalCalendars,
  type LocalEvent,
} from '@/shared/localCalendar';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din calendar`: the calendars Calendar keeps on this computer, one .ics
 * file per event in ~/.local/share/din/calendar (src/shared/localCalendar.ts,
 * which Calendar calls too), and the separate, public Nostr calendar
 * (NIP-52, src/shared/calendar.ts) when the user has turned it on: what's
 * coming up, adding an event, answering an invitation, deleting an event
 * (asks on screen first), the calendars themselves, and opening Calendar
 * on a day. Nothing goes to Nostr unless `--calendar nostr` says so, and
 * that asks on screen first.
 */

const DAY_MS = 86_400_000;
const EVENT: Param = { name: 'event', type: 'string', positional: true, help: 'The event, by title (or its UID or d tag)' };
const CALENDAR: Param = { name: 'calendar', type: 'string', positional: true, help: 'The calendar, by name' };
const ANSWERS: Record<string, RsvpStatus> = { going: 'accepted', yes: 'accepted', accepted: 'accepted', maybe: 'tentative', tentative: 'tentative', no: 'declined', declined: 'declined', 'not-going': 'declined' };
const COLOR_NAMES: Record<string, string> = { blue: '#2f7cf6', red: '#e5484d', orange: '#f76b15', yellow: '#e2a336', green: '#30a46c', teal: '#12a594', purple: '#8e4ec6', pink: '#d6409f', brown: '#a07553', gray: '#8b8d98' };

function fsOf(): CalendarFs {
  return need(getFsBridge(), 'The calendar');
}

function user(ctx: CommandContext): string {
  if (!ctx.pubkey) throw new CommandError('No one is signed in');
  return ctx.pubkey;
}

async function loadNostr(ctx: CommandContext): Promise<{ pubkey: string; data: CalendarData }> {
  const pubkey = user(ctx);
  const raw = await call(ctx.query(calendarFilters(pubkey)));
  return { pubkey, data: collectCalendar(raw, pubkey) };
}

/** The Nostr calendar, if the user turned it on; an error saying how otherwise. */
async function nostrOrFail(ctx: CommandContext, local: LocalCalendars) {
  if (!local.settings.nostr) throw new CommandError('The Nostr calendar is off. It’s public; turn it on with: din calendar nostr on');
  return loadNostr(ctx);
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

const isNostr = (name: string | undefined) => !!name && /^nostr$/i.test(name.trim());

function findCalendar(local: LocalCalendars, name: string): LocalCalendar {
  return pick(local.calendars, name, (c) => [c.id, c.title], 'calendar');
}

function color(value: string): string {
  const c = COLOR_NAMES[value.toLowerCase()] ?? value;
  if (!/^#[0-9a-f]{6}$/i.test(c)) throw new CommandError(`Not a colour: ${value} (try ${Object.keys(COLOR_NAMES).join(', ')}, or #rrggbb)`, 'usage');
  return c.toLowerCase();
}

type Found = { kind: 'local'; e: LocalEvent; calendar: LocalCalendar } | { kind: 'nostr'; e: CalendarEvent };

function localSummary(e: LocalEvent, calendar: LocalCalendar | undefined) {
  return {
    title: e.title,
    when: describeWhen(e),
    start: new Date(e.start).toISOString(),
    end: new Date(e.end).toISOString(),
    allDay: e.allDay,
    location: e.locations[0],
    calendar: calendar?.title ?? e.calendar,
    public: false,
    uid: e.uid,
  };
}

function nostrSummary(e: CalendarEvent, data: CalendarData, pubkey: string) {
  const rsvp = data.rsvps.get(e.coord)?.status ?? null;
  return {
    title: e.title,
    when: describeWhen(e),
    start: new Date(e.start).toISOString(),
    end: new Date(e.end).toISOString(),
    allDay: e.allDay,
    location: e.locations[0],
    calendar: 'Nostr',
    public: true,
    mine: e.pubkey === pubkey,
    answer: e.pubkey === pubkey ? undefined : rsvp,
    list: data.calendars.find((c) => c.members.includes(e.coord))?.title,
    link: `nostr:${nip19.naddrEncode({ kind: e.kind, pubkey: e.pubkey, identifier: e.d })}`,
  };
}

/** One event, by title or id; upcoming ones first when titles repeat. */
function findEvent(events: readonly Found[], query: string): Found {
  const now = Date.now();
  const list = [...events].sort((a, b) => Number(b.e.end >= now) - Number(a.e.end >= now) || a.e.start - b.e.start);
  const keys = (f: Found) => [f.kind === 'local' ? f.e.uid : f.e.d, f.e.title];
  try {
    return pick(list.filter((f) => f.e.end >= now), query, keys, 'upcoming event');
  } catch {
    return pick(list, query, keys, 'event');
  }
}

function localFound(local: LocalCalendars): Found[] {
  const byId = new Map(local.calendars.map((c) => [c.id, c]));
  return local.events.flatMap((e) => {
    const calendar = byId.get(e.calendar);
    return calendar ? [{ kind: 'local' as const, e, calendar }] : [];
  });
}

const ANSWER_TEXT: Record<RsvpStatus, string> = { accepted: 'going', tentative: 'maybe', declined: 'not going' };

export const calendarArea: Area = {
  name: 'calendar',
  summary: 'Your calendars, kept on this computer, and the public Nostr calendar if it’s on: what’s coming up, add an event, answer invitations, delete; calendars; open Calendar',
  commands: [
    command('calendar', 'list', 'Events coming up, from every calendar shown (Nostr’s too, if it’s on)', [
      { name: 'days', type: 'integer', optional: true, min: 1, max: 366, help: 'How many days ahead (default: 14)' },
      { name: 'from', type: 'string', optional: true, help: 'The first day, YYYY-MM-DD (default: today)' },
      { name: 'calendar', type: 'string', optional: true, help: 'Only this calendar, by name (or nostr)' },
    ], async (args, ctx) => {
      const local = await call(loadLocalCalendars(fsOf()));
      const fromArg = args.optString('from');
      const from = fromArg ? parseWhen(fromArg, 'from').time : new Date(new Date().setHours(0, 0, 0, 0)).getTime();
      const to = from + (args.optNumber('days') ?? 14) * DAY_MS;
      const only = args.optString('calendar');
      const onlyLocal = only && !isNostr(only) ? findCalendar(local, only) : null;
      const byId = new Map(local.calendars.map((c) => [c.id, c]));
      const rows: { start: number; end: number; allDay: boolean; title: string; row: ReturnType<typeof localSummary> | ReturnType<typeof nostrSummary> }[] = [];
      if (!isNostr(only)) {
        for (const e of local.events) if (!onlyLocal || e.calendar === onlyLocal.id) rows.push({ ...e, row: localSummary(e, byId.get(e.calendar)) });
      }
      if (!onlyLocal && (isNostr(only) || local.settings.nostr) && ctx.pubkey) {
        const { pubkey, data } = isNostr(only) ? await nostrOrFail(ctx, local) : await loadNostr(ctx);
        for (const e of data.events.values()) rows.push({ ...e, row: nostrSummary(e, data, pubkey) });
      }
      const events = eventsBetween(rows, from, to).map((r) => r.row);
      return {
        data: events,
        text: events.length
          ? events
              .map((e) => {
                const where = e.public ? ` [Nostr, public${'mine' in e && !e.mine ? `, invited${e.answer ? `, ${ANSWER_TEXT[e.answer]}` : ', not answered'}` : ''}]` : ` [${e.calendar}]`;
                return `${e.when}  ${e.title}${e.location ? ` @ ${e.location}` : ''}${where}`;
              })
              .join('\n')
          : 'Nothing on the calendar',
      };
    }),
    command('calendar', 'add', 'Add an event: to a calendar on this computer (Personal unless --calendar says), or, with --calendar nostr, publicly to Nostr (asks on screen first)', [
      { name: 'title', type: 'string', positional: true, rest: true, help: 'What it is' },
      { name: 'start', type: 'string', help: 'When it starts: YYYY-MM-DD HH:MM, or YYYY-MM-DD for all day' },
      { name: 'end', type: 'string', optional: true, help: 'When it ends (default: an hour later, or the same day)' },
      { name: 'location', type: 'string', optional: true, help: 'Where, or a video call link' },
      { name: 'notes', type: 'string', optional: true, help: 'A description' },
      { name: 'calendar', type: 'string', optional: true, help: 'Which calendar, by name; nostr publishes it for anyone to see' },
      { name: 'invite', type: 'string', optional: true, help: 'Nostr only: people to invite, npubs separated by commas' },
      { name: 'list', type: 'string', optional: true, help: 'Nostr only: one of your NIP-52 calendars to put it in, by name' },
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
      const fs = fsOf();
      const local = await call(loadLocalCalendars(fs));
      const fields = {
        title,
        description: args.optString('notes') ?? '',
        allDay,
        start: start.time,
        end: endTime,
        tzid: allDay ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone,
        locations: args.optString('location') ? [args.optString('location')!] : [],
        hashtags: [],
        links: [],
      };
      const when = describeWhen({ allDay, start: start.time, end: endTime });

      if (!isNostr(args.optString('calendar'))) {
        if (args.optString('invite') || args.optString('list')) throw new CommandError('Invitations and lists are for the public Nostr calendar: add --calendar nostr', 'usage');
        const name = args.optString('calendar');
        const calendar = name ? findCalendar(local, name) : local.calendars[0];
        await call(saveLocalEvent(fs, calendar, fields));
        return { text: `Added “${title}” to ${calendar.title}, ${when}` };
      }

      const { pubkey, data } = await nostrOrFail(ctx, local);
      const listName = args.optString('list');
      const list = listName ? pick(data.calendars, listName, (c) => [c.d, c.title], 'Nostr calendar') : null;
      const participants = (args.optString('invite') ?? '').split(',').filter((s) => s.trim()).map(participant);
      const ok = await ctx.confirm({
        title: `Publish “${title}” on Nostr?`,
        description: `${when}. It’s public: anyone can see it${participants.length ? ', and who’s invited' : ''}, and deleting it later may not remove every copy.`,
        action: 'Publish',
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      const template = eventTemplate({ ...fields, participants, calendar: list?.coord ?? null });
      const templates: EventTemplate[] = [template];
      if (list) {
        const d = template.tags.find((t) => t[0] === 'd')![1];
        templates.push(calendarTemplate(list.title, [...list.members, coordOf(template.kind, pubkey, d)], list));
      }
      for (const t of templates) await call(ctx.publish(t));
      return { text: `Published “${title}” on Nostr, ${when}` };
    }),
    command('calendar', 'rsvp', 'Answer a Nostr invitation: going, maybe or no', [
      EVENT,
      { name: 'answer', type: 'string', positional: true, choices: ['going', 'maybe', 'no'], help: 'going, maybe or no' },
    ], async (args, ctx) => {
      const local = await call(loadLocalCalendars(fsOf()));
      const { pubkey, data } = await nostrOrFail(ctx, local);
      const status = ANSWERS[args.string('answer').toLowerCase()];
      if (!status) throw new CommandError('Answer going, maybe or no', 'usage');
      const found = findEvent([...data.events.values()].filter((x) => x.pubkey !== pubkey).map((e) => ({ kind: 'nostr' as const, e })), args.string('event'));
      const e = found.e as CalendarEvent;
      await call(ctx.publish(rsvpTemplate(e, status, data.rsvps.get(e.coord))));
      return { text: `${ANSWER_TEXT[status][0].toUpperCase()}${ANSWER_TEXT[status].slice(1)}: ${e.title}, ${describeWhen(e)}` };
    }),
    command('calendar', 'delete', 'Delete one of your events (asks on screen first)', [EVENT], async (args, ctx) => {
      const fs = fsOf();
      const local = await call(loadLocalCalendars(fs));
      const events = localFound(local);
      let nostr: { pubkey: string; data: CalendarData } | null = null;
      if (local.settings.nostr && ctx.pubkey) {
        nostr = await loadNostr(ctx);
        for (const e of nostr.data.events.values()) if (e.pubkey === nostr.pubkey) events.push({ kind: 'nostr', e });
      }
      const found = findEvent(events, args.string('event'));
      const ok = await ctx.confirm({
        title: `Delete “${found.e.title}”?`,
        description:
          found.kind === 'local'
            ? `${describeWhen(found.e)}, in ${found.calendar.title}. It’s deleted from this computer.`
            : `${describeWhen(found.e)}. It’s public on Nostr: your relays are asked to delete it${found.e.participants.length ? ', and the people you invited see it go' : ''}. Copies elsewhere may stay.`,
        action: 'Delete',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      if (found.kind === 'local') {
        await call(deleteLocalEvent(fs, found.e));
      } else {
        const e = found.e;
        const templates: EventTemplate[] = [deletionTemplate(e)];
        for (const c of nostr!.data.calendars) if (c.members.includes(e.coord)) templates.push(calendarTemplate(c.title, c.members.filter((m) => m !== e.coord), c));
        for (const t of templates) await call(ctx.publish(t));
      }
      return { text: `Deleted “${found.e.title}”` };
    }),
    command('calendar', 'calendars', 'Your calendars: those on this computer, and whether the public Nostr calendar is on', [], async () => {
      const local = await call(loadLocalCalendars(fsOf()));
      const counts = new Map<string, number>();
      for (const e of local.events) counts.set(e.calendar, (counts.get(e.calendar) ?? 0) + 1);
      const data = [
        ...local.calendars.map((c) => ({ name: c.title, id: c.id, color: c.color, events: counts.get(c.id) ?? 0, public: false, folder: c.folder })),
        { name: 'Nostr', id: 'nostr', public: true, on: local.settings.nostr },
      ];
      return {
        data,
        text: [
          ...local.calendars.map((c) => `${c.title}  ${counts.get(c.id) ?? 0} event${counts.get(c.id) === 1 ? '' : 's'}, on this computer`),
          `Nostr  public, ${local.settings.nostr ? 'on' : 'off'}`,
        ].join('\n'),
      };
    }),
    command('calendar', 'new-calendar', 'Make a calendar on this computer', [
      { name: 'name', type: 'string', positional: true, rest: true, help: 'What it’s called' },
      { name: 'color', type: 'string', optional: true, help: 'blue, red, green… or #rrggbb (default: blue)' },
    ], async (args) => {
      const name = args.list('name').join(' ').trim();
      if (!name) throw new CommandError('Missing name', 'usage');
      if (isNostr(name)) throw new CommandError('Nostr is the public calendar’s name; pick another', 'usage');
      const made = await call(createCalendar(fsOf(), name, color(args.optString('color') ?? 'blue')));
      return { text: `Made ${made.title}` };
    }),
    command('calendar', 'rename-calendar', 'Rename a calendar on this computer', [
      CALENDAR,
      { name: 'name', type: 'string', positional: true, rest: true, help: 'Its new name' },
    ], async (args) => {
      const fs = fsOf();
      const calendar = findCalendar(await call(loadLocalCalendars(fs)), args.string('calendar'));
      const name = args.list('name').join(' ').trim();
      if (!name) throw new CommandError('Missing name', 'usage');
      await call(renameCalendar(fs, calendar, name));
      return { text: `Renamed ${calendar.title} to ${name}` };
    }),
    command('calendar', 'color', 'Change a calendar’s colour', [
      CALENDAR,
      { name: 'color', type: 'string', positional: true, help: 'blue, red, green… or #rrggbb' },
    ], async (args) => {
      const fs = fsOf();
      if (isNostr(args.string('calendar'))) throw new CommandError('The Nostr calendar’s colour is set in Calendar (right-click it)');
      const calendar = findCalendar(await call(loadLocalCalendars(fs)), args.string('calendar'));
      await call(setCalendarColor(fs, calendar, color(args.string('color'))));
      return { text: `${calendar.title} is ${args.string('color')} now` };
    }),
    command('calendar', 'delete-calendar', 'Delete a calendar on this computer and its events (asks on screen first)', [CALENDAR], async (args, ctx) => {
      const fs = fsOf();
      const local = await call(loadLocalCalendars(fs));
      const calendar = findCalendar(local, args.string('calendar'));
      if (local.calendars.length < 2) throw new CommandError('It’s your only calendar; make another first');
      const count = local.events.filter((e) => e.calendar === calendar.id).length;
      const ok = await ctx.confirm({
        title: `Delete the calendar “${calendar.title}”?`,
        description: count ? `Its ${count === 1 ? 'event is' : `${count} events are`} deleted from this computer too.` : 'It has no events.',
        action: 'Delete Calendar',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(deleteCalendar(fs, calendar));
      return { text: `Deleted ${calendar.title}` };
    }),
    command('calendar', 'nostr', 'Turn the public Nostr calendar on or off (only shows or hides it: nothing is published or deleted)', [
      { name: 'state', type: 'string', positional: true, choices: ['on', 'off'], help: 'on or off' },
    ], async (args) => {
      const on = args.string('state') === 'on';
      await call(setNostrCalendar(fsOf(), on));
      return { text: on ? 'The Nostr calendar is on. It’s public: what you add to it, anyone can see.' : 'The Nostr calendar is off. Its events stay public on Nostr.' };
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
