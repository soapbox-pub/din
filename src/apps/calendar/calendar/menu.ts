import { Check, CircleHelp, Copy, CopyPlus, ExternalLink, Link, Pencil, Trash2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import type { CalendarEvent, RsvpStatus } from '@/shared/calendar';
import type { LocalEvent } from '@/shared/localCalendar';
import type { SourceId } from './sources';

/**
 * An event as the views draw it: one kept on this computer, or one from
 * the public Nostr calendar.
 */
export type Shown = ({ kind: 'local'; e: LocalEvent } | { kind: 'nostr'; e: CalendarEvent }) & {
  /** Unique across both: `local:<calendar>/<uid>`, or the Nostr event's coordinate. */
  key: string;
  source: SourceId;
  color: string;
  /** The user can change it: theirs on Nostr, or on this computer. */
  mine: boolean;
  /** The user's answer, for someone else's Nostr event. */
  rsvp: RsvpStatus | null;
};

export type EventAction = 'open' | 'edit' | 'duplicate' | 'copy-link' | 'copy-details' | 'rsvp:accepted' | 'rsvp:tentative' | 'rsvp:declined' | 'delete';

export type MenuEntry =
  | { kind: 'item'; action: EventAction; label: string; icon: LucideIcon; checked?: boolean; destructive?: boolean }
  | { kind: 'separator' };

export const RSVP_LABELS: Record<RsvpStatus, string> = { accepted: 'Going', tentative: 'Maybe', declined: 'Not Going' };
export const RSVP_ICONS: Record<RsvpStatus, LucideIcon> = { accepted: Check, tentative: CircleHelp, declined: X };

const item = (action: EventAction, label: string, icon: LucideIcon, more: { checked?: boolean; destructive?: boolean } = {}): MenuEntry => ({ kind: 'item', action, label, icon, ...more });
const separator: MenuEntry = { kind: 'separator' };

/** What can be done to an event, for its right-click menu and its details' ⋯ menu alike. `skip` leaves out what's a button already. */
export function eventMenu(s: Shown, skip: ReadonlySet<EventAction> = new Set()): MenuEntry[] {
  const groups: MenuEntry[][] = [
    [item('open', 'Show Details', ExternalLink), ...(s.mine ? [item('edit', 'Edit…', Pencil)] : [])],
    s.kind === 'local' || s.mine
      ? []
      : (['accepted', 'tentative', 'declined'] as const).map((status) => item(`rsvp:${status}`, RSVP_LABELS[status], RSVP_ICONS[status], { checked: s.rsvp === status })),
    [item('duplicate', 'Duplicate', CopyPlus), ...(s.kind === 'nostr' ? [item('copy-link', 'Copy Link', Link)] : []), item('copy-details', 'Copy Details', Copy)],
    s.mine ? [item('delete', 'Delete…', Trash2, { destructive: true })] : [],
  ];
  const kept = groups.map((g) => g.filter((e) => e.kind !== 'item' || !skip.has(e.action))).filter((g) => g.length);
  return kept.flatMap((g, i) => (i ? [separator, ...g] : g));
}

/** A `nostr:` link to the event, with the relay hints its author gave. */
export function eventLink(e: CalendarEvent, relays: string[] = []): string {
  return `nostr:${nip19.naddrEncode({ kind: e.kind, pubkey: e.pubkey, identifier: e.d, relays: relays.slice(0, 3) })}`;
}
