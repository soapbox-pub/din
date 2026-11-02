import { useCallback, useState } from 'react';
import type { CalendarData, CalendarEvent, CalendarList } from '@/shared/calendar';

/** Where an event shows up in the sidebar: one of the user's calendars, their other events, or invitations. */
export type SourceId = string;
export const MINE: SourceId = 'mine';
export const INVITED: SourceId = 'invited';

export const COLORS = [
  { name: 'Blue', value: '#2f7cf6' },
  { name: 'Red', value: '#e5484d' },
  { name: 'Orange', value: '#f76b15' },
  { name: 'Yellow', value: '#e2a336' },
  { name: 'Green', value: '#30a46c' },
  { name: 'Teal', value: '#12a594' },
  { name: 'Purple', value: '#8e4ec6' },
  { name: 'Pink', value: '#d6409f' },
  { name: 'Brown', value: '#a07553' },
  { name: 'Gray', value: '#8b8d98' },
] as const;

/** New calendars' colours: not the blue and purple of My Events and Invitations. */
const CALENDAR_COLORS = [COLORS[1], COLORS[2], COLORS[3], COLORS[4], COLORS[5], COLORS[7]].map((c) => c.value);

export interface Source {
  id: SourceId;
  title: string;
  color: string;
  calendar?: CalendarList;
}

const PREFS_KEY = 'din:calendar:sources';

interface Prefs {
  hidden: SourceId[];
  colors: Record<SourceId, string>;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null;
    return { hidden: Array.isArray(p?.hidden) ? p.hidden : [], colors: p?.colors && typeof p.colors === 'object' ? p.colors : {} };
  } catch {
    return { hidden: [], colors: {} };
  }
}

/** Which sources are shown, and their colors, kept on this computer. */
export function useSourcePrefs() {
  const [prefs, setPrefs] = useState(loadPrefs);
  const update = useCallback((fn: (p: Prefs) => Prefs) => {
    setPrefs((p) => {
      const next = fn(p);
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const setHidden = useCallback(
    (id: SourceId, hidden: boolean) => update((p) => ({ ...p, hidden: hidden ? [...new Set([...p.hidden, id])] : p.hidden.filter((h) => h !== id) })),
    [update],
  );
  const showOnly = useCallback((id: SourceId, all: SourceId[]) => update((p) => ({ ...p, hidden: all.filter((s) => s !== id) })), [update]);
  const showAll = useCallback(() => update((p) => ({ ...p, hidden: [] })), [update]);
  const setColor = useCallback((id: SourceId, color: string) => update((p) => ({ ...p, colors: { ...p.colors, [id]: color } })), [update]);
  return { hidden: new Set(prefs.hidden), colors: prefs.colors, setHidden, showOnly, showAll, setColor };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The sidebar's list: the user's calendars, then their other events, then invitations. */
export function sourcesOf(data: CalendarData | null, colors: Record<SourceId, string>): Source[] {
  const calendars = data?.calendars ?? [];
  return [
    ...calendars.map((c) => ({ id: c.coord, title: c.title, calendar: c, color: colors[c.coord] ?? CALENDAR_COLORS[hash(c.d) % CALENDAR_COLORS.length] })),
    { id: MINE, title: 'My Events', color: colors[MINE] ?? COLORS[0].value },
    { id: INVITED, title: 'Invitations', color: colors[INVITED] ?? COLORS[6].value },
  ];
}

/** Which source an event belongs to. */
export function sourceOf(event: CalendarEvent, data: CalendarData, pubkey: string): SourceId {
  const calendar = data.calendars.find((c) => c.members.includes(event.coord));
  if (calendar) return calendar.coord;
  return event.pubkey === pubkey ? MINE : INVITED;
}
