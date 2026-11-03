import type { FsBridge } from '@/lib/fs';
import { parseICalendar, removeEvent, serializeICalendar, type ICalEvent } from './ical';

/**
 * The calendars kept on this computer: a folder each in
 * ~/.local/share/din/calendar/ (Calendar's own, its manifest's
 * `din.folders`), one .ics file per event, with the calendar's name and
 * colour in `displayname` and `color` beside them. That's the layout
 * vdirsyncer calls a vdir, so a sync tool can keep it in step with a
 * CalDAV server (Nextcloud and the like) and other apps can read it.
 * Nothing here leaves the computer. `settings.json` says whether the
 * separate, public Nostr calendar is on. Calendar reaches the folder
 * through its scoped `din.system.fs`, `din calendar` through the
 * desktop's; both call these.
 */

export const CALENDAR_FOLDER = '.local/share/din/calendar';
const SETTINGS_FILE = 'settings.json';
const DEFAULT_ID = 'personal';

export type CalendarFs = Pick<FsBridge, 'homedir' | 'readdir' | 'readFile' | 'writeFile' | 'mkdir' | 'rm'>;

/** A calendar on this computer. */
export interface LocalCalendar {
  /** Its folder's name. */
  id: string;
  folder: string;
  title: string;
  color: string;
}

/** An event in one of them, and the file it's in. */
export interface LocalEvent extends ICalEvent {
  calendar: string;
  path: string;
  /** Other events are in the same file. */
  shared?: boolean;
}

export interface CalendarSettings {
  /** The public Nostr calendar is shown, and can be added to. Off unless the user turns it on. */
  nostr: boolean;
}

export interface LocalCalendars {
  root: string;
  calendars: LocalCalendar[];
  events: LocalEvent[];
  settings: CalendarSettings;
}

export const DEFAULT_COLOR = '#2f7cf6';

export async function calendarRoot(fs: CalendarFs): Promise<string> {
  const home = (await fs.homedir()).replace(/\/+$/, '');
  return `${home}/${CALENDAR_FOLDER}`;
}

const decoder = new TextDecoder();

async function readText(fs: CalendarFs, path: string, max = 32 * 1024 * 1024): Promise<string> {
  return decoder.decode((await fs.readFile(path, max)).data);
}

async function readOptional(fs: CalendarFs, path: string): Promise<string | null> {
  try {
    return await readText(fs, path, 64 * 1024);
  } catch {
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return /ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error));
}

function titleFromId(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

async function readSettings(fs: CalendarFs, root: string): Promise<CalendarSettings> {
  try {
    const value = JSON.parse((await readOptional(fs, `${root}/${SETTINGS_FILE}`)) ?? '{}') as Partial<CalendarSettings>;
    return { nostr: value.nostr === true };
  } catch {
    return { nostr: false };
  }
}

/** Turn the public Nostr calendar on or off (it only shows and hides it; nothing is published or deleted). */
export async function setNostrCalendar(fs: CalendarFs, on: boolean): Promise<void> {
  const root = await calendarRoot(fs);
  await fs.mkdir(root);
  const settings = { ...(await readSettings(fs, root)), nostr: on };
  await fs.writeFile(`${root}/${SETTINGS_FILE}`, `${JSON.stringify(settings, null, 2)}\n`);
}

async function writeMeta(fs: CalendarFs, folder: string, title: string, color: string): Promise<void> {
  await fs.mkdir(folder);
  await fs.writeFile(`${folder}/displayname`, `${title}\n`);
  await fs.writeFile(`${folder}/color`, `${color}\n`);
}

/**
 * Every calendar and event in the folder. With none there yet, it makes
 * the one everyone starts with, Personal.
 */
export async function loadLocalCalendars(fs: CalendarFs): Promise<LocalCalendars> {
  const root = await calendarRoot(fs);
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(root)).entries.filter((e) => e.kind === 'directory' && !e.name.startsWith('.')).map((e) => e.name);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (!dirs.length) {
    await writeMeta(fs, `${root}/${DEFAULT_ID}`, 'Personal', DEFAULT_COLOR);
    dirs = [DEFAULT_ID];
  }
  const loaded = await Promise.all(
    dirs.map(async (id) => {
      const folder = `${root}/${id}`;
      const [title, color, listing] = await Promise.all([
        readOptional(fs, `${folder}/displayname`),
        readOptional(fs, `${folder}/color`),
        fs.readdir(folder).catch(() => ({ entries: [] as { name: string; kind: string }[] })),
      ]);
      const calendar: LocalCalendar = {
        id,
        folder,
        title: title?.trim() || titleFromId(id),
        color: /^#[0-9a-f]{6}/i.test(color?.trim() ?? '') ? color!.trim().slice(0, 7) : DEFAULT_COLOR,
      };
      const files = listing.entries.filter((e) => e.kind === 'file' && /\.ics$/i.test(e.name));
      const events = await Promise.all(
        files.map(async (f) => {
          const path = `${folder}/${f.name}`;
          try {
            const list = parseICalendar(await readText(fs, path));
            return list.map((e): LocalEvent => ({ ...e, calendar: id, path, shared: list.length > 1 || undefined }));
          } catch {
            return [];
          }
        }),
      );
      return { calendar, events: events.flat() };
    }),
  );
  const calendars = loaded.map((l) => l.calendar).sort((a, b) => Number(b.id === DEFAULT_ID) - Number(a.id === DEFAULT_ID) || a.title.localeCompare(b.title));
  return { root, calendars, events: loaded.flatMap((l) => l.events), settings: await readSettings(fs, root) };
}

/** A new calendar on this computer. */
export async function createCalendar(fs: CalendarFs, title: string, color: string): Promise<LocalCalendar> {
  const root = await calendarRoot(fs);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'calendar';
  const id = `${slug}-${crypto.randomUUID().slice(0, 8)}`;
  const folder = `${root}/${id}`;
  const name = title.trim() || 'Untitled calendar';
  await writeMeta(fs, folder, name, color);
  return { id, folder, title: name, color };
}

export async function renameCalendar(fs: CalendarFs, calendar: LocalCalendar, title: string): Promise<void> {
  await writeMeta(fs, calendar.folder, title.trim() || calendar.title, calendar.color);
}

export async function setCalendarColor(fs: CalendarFs, calendar: LocalCalendar, color: string): Promise<void> {
  await writeMeta(fs, calendar.folder, calendar.title, color);
}

/** Delete a calendar and every event in it. */
export async function deleteCalendar(fs: CalendarFs, calendar: LocalCalendar): Promise<void> {
  await fs.rm(calendar.folder, { recursive: true });
}

function fileFor(folder: string, uid: string): string {
  const safe = uid.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 120);
  return `${folder}/${safe || crypto.randomUUID()}.ics`;
}

async function removeFromFile(fs: CalendarFs, path: string, uid: string): Promise<void> {
  let text: string;
  try {
    text = await readText(fs, path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const rest = removeEvent(text, uid);
  if (rest) await fs.writeFile(path, rest);
  else await fs.rm(path);
}

/** What the editor gives to make or change an event on this computer. */
export type LocalEventFields = Pick<ICalEvent, 'title' | 'description' | 'allDay' | 'start' | 'end' | 'tzid' | 'locations' | 'links' | 'hashtags'>;

/**
 * Write an event into a calendar, new or (with `was`) changed, moved from
 * another calendar if `was` is in one; resolves with it as stored.
 */
export async function saveLocalEvent(fs: CalendarFs, calendar: LocalCalendar, fields: LocalEventFields, was?: LocalEvent | null): Promise<LocalEvent> {
  await fs.mkdir(calendar.folder);
  const now = Date.now();
  const base: ICalEvent = was
    ? { ...was, sequence: was.sequence + 1 }
    : { uid: crypto.randomUUID(), title: '', description: '', locations: [], links: [], hashtags: [], allDay: false, start: 0, end: 0, repeats: false, sequence: 0, created: now, updated: now, extra: [] };
  const { title, description, allDay, start, end, tzid, locations, links, hashtags } = fields;
  const event: ICalEvent = {
    ...base,
    title: title.trim() || 'Untitled event',
    description,
    allDay,
    start,
    end,
    tzid: allDay ? undefined : tzid,
    locations,
    links,
    hashtags,
    updated: now,
  };
  // An event keeps its file, unless it shared one or moved calendar.
  const keep = was && !was.shared && was.calendar === calendar.id && was.path.startsWith(`${calendar.folder}/`);
  const path = keep ? was.path : fileFor(calendar.folder, event.uid);
  const { calendar: _c, path: _p, shared: _s, ...plain } = event as ICalEvent & Partial<LocalEvent>;
  await fs.writeFile(path, serializeICalendar(plain));
  if (was && was.path !== path) await removeFromFile(fs, was.path, was.uid);
  return { ...plain, calendar: calendar.id, path };
}

export async function deleteLocalEvent(fs: CalendarFs, event: LocalEvent): Promise<void> {
  await removeFromFile(fs, event.path, event.uid);
}
