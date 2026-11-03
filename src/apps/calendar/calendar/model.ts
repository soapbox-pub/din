import { createContext, useContext, useEffect, useState, type CSSProperties } from 'react';
import { nip19 } from 'nostr-tools';
import type { EventDraft } from '@/shared/calendar';
import { TIME_ZONE } from './dates';
import type { EventAction, Shown } from './menu';
import type { Profile } from './nostr';
import type { SourceId } from './sources';

/** What the editor fills in: an event, and the calendar it goes in. */
export interface Draft extends EventDraft {
  /** A calendar on this computer (`local:<folder>`), or `nostr`, which publishes it. */
  target: SourceId;
}

/** A draft from an event, to change it (or, without its identity, to copy it). */
export function draftOf(s: Shown, nostrList: string | null): Draft {
  const e = s.e;
  return {
    title: e.title,
    description: e.description,
    allDay: e.allDay,
    start: e.start,
    end: e.allDay ? e.end : Math.max(e.end, e.start),
    tzid: e.tzid,
    locations: e.locations,
    participants: s.kind === 'nostr' ? s.e.participants : [],
    hashtags: e.hashtags,
    links: e.links,
    calendar: nostrList,
    target: s.source,
  };
}

export function blankDraft(start: number, end: number, allDay: boolean, target: SourceId): Draft {
  return { title: '', description: '', allDay, start, end, tzid: TIME_ZONE, locations: [], participants: [], hashtags: [], links: [], calendar: null, target };
}

/** What the views can ask of the window around them. */
export interface ViewActions {
  /** The event whose details are open, by coordinate. */
  selected: string | null;
  select: (s: Shown, anchor: HTMLElement) => void;
  act: (s: Shown, action: EventAction, anchor?: HTMLElement) => void;
  /** Start a new event at these times. */
  create: (start: number, end: number, allDay: boolean) => void;
  /** Show this day on its own. */
  showDay: (day: Date) => void;
}

export const ViewContext = createContext<ViewActions | null>(null);

export function useViewActions(): ViewActions {
  const v = useContext(ViewContext);
  if (!v) throw new Error('No ViewContext');
  return v;
}

/** The event's colour, as `--ev`, for the classes below. */
export function colorStyle(color: string, extra?: CSSProperties): CSSProperties {
  return { '--ev': color, ...extra } as CSSProperties;
}

/** How an invitation not yet answered, or answered maybe or no, looks different. */
export function answerClasses(s: Shown): string {
  if (s.kind === 'local' || s.mine) return '';
  if (s.rsvp === 'declined') return 'opacity-55 line-through decoration-foreground/40';
  if (s.rsvp === null) return 'outline outline-1 -outline-offset-1 outline-dashed outline-(--ev)';
  return '';
}

export function tentativeStyle(s: Shown): CSSProperties | undefined {
  if (s.mine || s.rsvp !== 'tentative') return undefined;
  return {
    backgroundImage:
      'repeating-linear-gradient(135deg, color-mix(in oklab, var(--ev) 22%, transparent) 0 6px, transparent 6px 12px)',
  };
}


/** A new event's default times on a day: 9 to 10. */
export function defaultSlot(day: Date): [number, number] {
  return [new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9).getTime(), new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10).getTime()];
}

export function shortNpub(pubkey: string): string {
  const npub = nip19.npubEncode(pubkey);
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
}

export function nameOf(pubkey: string, profile: Profile | undefined): string {
  return profile?.name || shortNpub(pubkey);
}

/** Ticks once a minute, for the current-time line. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
