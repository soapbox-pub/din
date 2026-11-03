import { useMemo, useState, type FormEvent } from 'react';
import { Globe, Loader2, MapPin, UserPlus, X } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { HEX64, isoDate, parseIsoDate, type CalendarList, type Participant } from '@/shared/calendar';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { addDays, startOfDay, timeInput, TIME_ZONE, withTime } from './dates';
import { useProfiles } from './nostr';
import { nameOf, type Draft } from './model';
import type { Shown } from './menu';
import { NOSTR, type Source } from './sources';
import { Avatar } from './Person';

const HOUR = 3_600_000;


/** A pubkey from an npub, nprofile or hex key, or null. */
function pubkeyFrom(input: string): Participant | null {
  const s = input.trim().replace(/^nostr:/, '');
  if (HEX64.test(s)) return { pubkey: s };
  try {
    const d = nip19.decode(s);
    if (d.type === 'npub') return { pubkey: d.data };
    if (d.type === 'nprofile') return { pubkey: d.data.pubkey, relay: d.data.relays?.[0] };
  } catch {
    // Not one.
  }
  return null;
}

const field = 'h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive';

/** Making or changing an event. */
export function EventEditor({
  initial,
  editing,
  sources,
  canPublish,
  nostrLists,
  saving,
  onSave,
  onClose,
}: {
  initial: Draft;
  /** The event being changed; null for a new one. */
  editing: Shown | null;
  /** The calendars it can go in: those on this computer, and Nostr if it's on. */
  sources: Source[];
  /** Someone is signed in to publish to Nostr as. */
  canPublish: boolean;
  /** The user's NIP-52 calendars, for a Nostr event. */
  nostrLists: CalendarList[];
  saving: boolean;
  onSave: (draft: Draft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const isPublic = draft.target === NOSTR;
  const leavingNostr = editing?.kind === 'nostr' && !isPublic;
  const local = sources.filter((s) => s.local);
  const nostr = sources.find((s) => s.id === NOSTR);
  const [invite, setInvite] = useState('');
  const [inviteError, setInviteError] = useState(false);
  const profiles = useProfiles(useMemo(() => draft.participants.map((p) => p.pubkey), [draft.participants]));
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const startDay = startOfDay(draft.start);
  // An all-day event's end is the day after its last; the field shows the last.
  const endDay = draft.allDay ? addDays(startOfDay(draft.end), -1) : startOfDay(draft.end);
  const invalid = draft.allDay ? draft.end <= draft.start : draft.end < draft.start;

  const setAllDay = (allDay: boolean) => {
    if (allDay === draft.allDay) return;
    if (allDay) {
      const s = startOfDay(draft.start);
      const e = addDays(startOfDay(Math.max(draft.start, draft.end - 1)), 1);
      set({ allDay, start: s.getTime(), end: e.getTime() });
    } else {
      const s = withTime(startOfDay(draft.start), '09:00').getTime();
      set({ allDay, start: s, end: s + HOUR, tzid: TIME_ZONE });
    }
  };

  const setStartDate = (value: string) => {
    const d = parseIsoDate(value);
    if (!d) return;
    const length = draft.end - draft.start;
    const start = draft.allDay ? d.getTime() : withTime(d, timeInput(draft.start)).getTime();
    set({ start, end: start + length });
  };
  const setStartTime = (value: string) => {
    if (!value) return;
    const length = draft.end - draft.start;
    const start = withTime(startDay, value).getTime();
    set({ start, end: start + length });
  };
  const setEndDate = (value: string) => {
    const d = parseIsoDate(value);
    if (!d) return;
    set({ end: draft.allDay ? addDays(d, 1).getTime() : withTime(d, timeInput(draft.end)).getTime() });
  };
  const setEndTime = (value: string) => {
    if (value) set({ end: withTime(endDay, value).getTime() });
  };

  const addInvite = () => {
    const parts = invite.split(/[\s,]+/).filter(Boolean);
    const found = parts.map(pubkeyFrom);
    if (!parts.length) return;
    if (found.some((p) => !p)) {
      setInviteError(true);
      return;
    }
    const have = new Set(draft.participants.map((p) => p.pubkey));
    set({ participants: [...draft.participants, ...found.filter((p): p is Participant => !!p && !have.has(p.pubkey))] });
    setInvite('');
    setInviteError(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (invalid || saving) return;
    onSave({ ...draft, title: draft.title.trim() || 'New Event', tzid: draft.allDay ? undefined : TIME_ZONE, participants: isPublic ? draft.participants : [], calendar: isPublic ? draft.calendar : null });
  };

  const zoneChanged = editing && !editing.e.allDay && editing.e.tzid && editing.e.tzid !== TIME_ZONE;

  return (
    <Overlay label={editing ? 'Edit event' : 'New event'} onClose={onClose} className="max-w-lg">
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <input
            autoFocus
            aria-label="Title"
            placeholder="New Event"
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            className="w-full bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground/70"
          />

          <div className="space-y-2 rounded-lg bg-foreground/[0.04] p-3">
            <label className="flex items-center justify-between text-sm">
              All day
              <Switch checked={draft.allDay} onCheckedChange={setAllDay} />
            </label>
            <div className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-2 text-sm">
              <span className="text-muted-foreground">Starts</span>
              <input type="date" aria-label="Start date" required value={isoDate(startDay)} onChange={(e) => setStartDate(e.target.value)} className={field} />
              {draft.allDay ? <span /> : <input type="time" aria-label="Start time" required step={300} value={timeInput(draft.start)} onChange={(e) => setStartTime(e.target.value)} className={cn(field, 'w-32')} />}
              <span className="text-muted-foreground">Ends</span>
              <input type="date" aria-label="End date" aria-invalid={invalid || undefined} required value={isoDate(endDay)} onChange={(e) => setEndDate(e.target.value)} className={field} />
              {draft.allDay ? <span /> : <input type="time" aria-label="End time" aria-invalid={invalid || undefined} required step={300} value={timeInput(draft.end)} onChange={(e) => setEndTime(e.target.value)} className={cn(field, 'w-32')} />}
            </div>
            {invalid && <p className="text-xs text-destructive">It has to end after it starts.</p>}
            {zoneChanged && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Globe className="size-3.5" /> Made in {editing.e.tzid?.replace(/_/g, ' ')}; saving puts it in {TIME_ZONE.replace(/_/g, ' ')}, at the same moment.
              </p>
            )}
          </div>

          <label className="flex items-center gap-3 text-sm">
            <span className="w-16 shrink-0 text-muted-foreground">Calendar</span>
            <select aria-label="Calendar" value={draft.target} onChange={(e) => set({ target: e.target.value })} className={field}>
              <optgroup label="On this computer">
                {local.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </optgroup>
              {nostr && (
                <optgroup label="Public">
                  <option value={NOSTR} disabled={!canPublish}>{canPublish ? 'Nostr (public)' : 'Nostr (public): sign in to use it'}</option>
                </optgroup>
              )}
            </select>
          </label>

          {isPublic && (
            <p className="text-sm text-muted-foreground">Shared on Nostr for anyone to find. Invite people by npub, and they can answer from any Nostr calendar app.</p>
          )}
          {leavingNostr && <p className="text-sm text-muted-foreground">Moving it here takes it off Nostr.</p>}

          {isPublic && nostrLists.length > 0 && (
            <label className="flex items-center gap-3 text-sm">
              <span className="w-16 shrink-0 text-muted-foreground">Nostr list</span>
              <select value={draft.calendar ?? ''} onChange={(e) => set({ calendar: e.target.value || null })} className={field}>
                <option value="">None</option>
                {nostrLists.map((c) => (
                  <option key={c.coord} value={c.coord}>{c.title}</option>
                ))}
              </select>
            </label>
          )}

          <label className="relative block">
            <MapPin className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label="Location or video call link"
              placeholder="Location or video call link"
              value={draft.locations[0] ?? ''}
              onChange={(e) => set({ locations: [e.target.value, ...draft.locations.slice(1)] })}
              className={cn(field, 'pl-8')}
            />
          </label>

          {isPublic && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <UserPlus className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    aria-label="Invite people by npub"
                    placeholder="Invite people: npub1…"
                    value={invite}
                    aria-invalid={inviteError || undefined}
                    onChange={(e) => {
                      setInvite(e.target.value);
                      setInviteError(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addInvite();
                      }
                    }}
                    onBlur={() => invite.trim() && addInvite()}
                    className={cn(field, 'pl-8')}
                  />
                </div>
                <DialogButton onClick={addInvite} disabled={!invite.trim()} className="h-9">Add</DialogButton>
              </div>
              {inviteError && <p className="text-xs text-destructive">That isn’t an npub or a public key.</p>}
              {draft.participants.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Invited">
                  {draft.participants.map((p) => (
                    <li key={p.pubkey} className="flex items-center gap-1.5 rounded-full bg-foreground/[0.06] py-0.5 pr-1 pl-0.5 text-sm">
                      <Avatar pubkey={p.pubkey} profile={profiles.get(p.pubkey)} className="size-6" />
                      <span className="max-w-40 truncate">{nameOf(p.pubkey, profiles.get(p.pubkey))}</span>
                      <button
                        type="button"
                        aria-label={`Don’t invite ${nameOf(p.pubkey, profiles.get(p.pubkey))}`}
                        onClick={() => set({ participants: draft.participants.filter((x) => x.pubkey !== p.pubkey) })}
                        className="grid size-5 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        <X className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <textarea
            aria-label="Notes"
            placeholder="Notes"
            rows={4}
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
            className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
        <div className="flex items-center gap-2 border-t border-border/60 px-5 py-3">
          <span className="mr-auto" />
          <DialogButton onClick={onClose}>Cancel</DialogButton>
          <DialogButton type="submit" variant="primary" disabled={invalid || saving} className="inline-flex items-center gap-1.5">
            {saving && <Loader2 className="size-3.5 motion-safe:animate-spin" />}
            {isPublic && !(editing?.kind === 'nostr') ? 'Publish Event' : editing ? 'Save' : 'Add Event'}
          </DialogButton>
        </div>
      </form>
    </Overlay>
  );
}
