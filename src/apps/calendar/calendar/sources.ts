import { useCallback, useState } from 'react';
import type { LocalCalendar } from '@/shared/localCalendar';

/**
 * Where an event shows up in the sidebar: one of the calendars on this
 * computer (`local:<folder>`), or the separate, public Nostr calendar.
 */
export type SourceId = string;
export const NOSTR: SourceId = 'nostr';

export function localSource(id: string): SourceId {
  return `local:${id}`;
}

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

/** New calendars' colours, in turn. */
export const CALENDAR_COLORS = [COLORS[0], COLORS[1], COLORS[4], COLORS[2], COLORS[5], COLORS[7], COLORS[3]].map((c) => c.value);

/** The Nostr calendar's colour until the user picks one. */
const NOSTR_COLOR = COLORS[6].value;

export interface Source {
  id: SourceId;
  title: string;
  color: string;
  /** On this computer. */
  local?: LocalCalendar;
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

/** The sidebar's list: the calendars on this computer, then, if it's on, the Nostr one. */
export function sourcesOf(calendars: readonly LocalCalendar[], nostr: boolean, colors: Record<SourceId, string>): Source[] {
  return [
    ...calendars.map((c) => ({ id: localSource(c.id), title: c.title, color: c.color, local: c })),
    ...(nostr ? [{ id: NOSTR, title: 'Nostr', color: colors[NOSTR] ?? NOSTR_COLOR }] : []),
  ];
}
