import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, PanelLeft, Plus, RefreshCw } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { LaunchContext } from '@/sdk/din';
import { useDin, useMenuBar, useWindowState, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import {
  calendarTemplate,
  coordOf,
  deletionTemplate,
  describeWhen,
  eventsBetween,
  eventTemplate,
  isoDate,
  parseIsoDate,
  rsvpTemplate,
  type CalendarEvent,
  type EventDraft,
  type EventTemplate,
} from '@/shared/calendar';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { toast } from '@/shared/toast';
import { locale, rangeOf, startOfDay, step, titleOf, type View } from './calendar/dates';
import { EventDetails } from './calendar/EventDetails';
import { EventEditor } from './calendar/EventEditor';
import { eventLink, type EventAction, type Shown } from './calendar/menu';
import { MonthView } from './calendar/MonthView';
import { blankDraft, defaultSlot, draftOf, useNow, ViewContext, type ViewActions } from './calendar/model';
import { useCalendarData, usePubkey, usePublish } from './calendar/nostr';
import { Sidebar } from './calendar/Sidebar';
import { INVITED, MINE, sourceOf, sourcesOf, useSourcePrefs, type Source } from './calendar/sources';
import { TimeGrid } from './calendar/TimeGrid';

const VIEW_KEY = 'din:calendar:view';
const SIDEBAR_KEY = 'din:calendar:sidebar';
const SIDEBAR_MIN_WIDTH = 820;
const VIEWS: { id: View; label: string; accelerator: string }[] = [
  { id: 'day', label: 'Day', accelerator: 'Ctrl+1' },
  { id: 'week', label: 'Week', accelerator: 'Ctrl+2' },
  { id: 'month', label: 'Month', accelerator: 'Ctrl+3' },
];

interface Saved {
  view: View;
  date: string;
}

function isView(v: unknown): v is View {
  return v === 'day' || v === 'week' || v === 'month';
}

function savedOf(launch: LaunchContext): Saved | null {
  const s = launch.state as Partial<Saved> | null;
  return s && isView(s.view) && typeof s.date === 'string' ? { view: s.view, date: s.date } : null;
}

/** A launch's `{ date, view }`: the day (and view) to show. */
function targetOf(launch: Pick<LaunchContext, 'params'>): { date: Date | null; view: View | null } {
  const { date, view } = launch.params;
  return { date: typeof date === 'string' ? parseIsoDate(date) : null, view: isView(view) ? view : null };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Editor = { draft: EventDraft; editing: CalendarEvent | null };

/**
 * Calendar: the user's NIP-52 calendar events and the ones they're invited
 * to, by day, week or month. Launch params `{ date: 'YYYY-MM-DD', view }`
 * show a day; the New Event shortcut starts one.
 */
export function Calendar() {
  const din = useDin();
  const pubkey = usePubkey();
  const data = useCalendarData(pubkey);
  const calendar = data.calendar;
  const publish = usePublish();
  const prefs = useSourcePrefs();
  const now = useNow();
  const today = useMemo(() => startOfDay(now), [now]);

  const [saved] = useState(() => (din.app.launch.reason === 'restore' ? savedOf(din.app.launch) : null));
  const [view, setViewState] = useState<View>(() => {
    const v = saved?.view ?? targetOf(din.app.launch).view ?? localStorage.getItem(VIEW_KEY);
    return isView(v) ? v : 'week';
  });
  const [date, setDate] = useState<Date>(() => (saved ? parseIsoDate(saved.date) : targetOf(din.app.launch).date) ?? new Date());
  const [selected, setSelected] = useState<{ coord: string; rect: DOMRect } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(() => {
    if (din.app.launch.shortcut !== 'new-event' || din.app.launch.reason === 'restore') return null;
    const [start, end] = defaultSlot(new Date());
    return { draft: blankDraft(start, end, false, null), editing: null };
  });
  const [deleting, setDeleting] = useState<Shown | null>(null);
  const [naming, setNaming] = useState<{ source: Source | null; title: string } | null>(null);
  const [deletingCalendar, setDeletingCalendar] = useState<Source | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== 'hidden');
  const sidebarFits = useWindowState((s) => (s.bounds.width || window.innerWidth) >= SIDEBAR_MIN_WIDTH);
  const showSidebar = sidebarOpen && sidebarFits;

  const setView = useCallback((v: View) => {
    setViewState(v);
    localStorage.setItem(VIEW_KEY, v);
  }, []);

  useEffect(() => din.app.saveState({ view, date: isoDate(date) } satisfies Saved), [din, view, date]);

  const sources = useMemo(() => sourcesOf(calendar, prefs.colors), [calendar, prefs.colors]);

  // Every event, with the colour of where it's from and the user's answer.
  const all = useMemo<(Shown & { source: string })[]>(() => {
    if (!calendar || !pubkey) return [];
    const color = new Map(sources.map((s) => [s.id, s.color]));
    return [...calendar.events.values()].map((e) => {
      const source = sourceOf(e, calendar, pubkey);
      return { e, source, color: color.get(source) ?? color.get(MINE)!, mine: e.pubkey === pubkey, rsvp: calendar.rsvps.get(e.coord)?.status ?? null };
    });
  }, [calendar, pubkey, sources]);
  const visible = useMemo(() => all.filter((s) => !prefs.hidden.has(s.source)), [all, prefs.hidden]);

  const range = useMemo(() => rangeOf(view, date), [view, date]);
  const inRange = useMemo(() => {
    const byCoord = new Map(visible.map((s) => [s.e.coord, s]));
    return eventsBetween(visible.map((s) => s.e), range.from, range.to).map((e) => byCoord.get(e.coord)!);
  }, [visible, range]);

  const awaiting = useMemo(
    () => all.filter((s) => s.source === INVITED && !s.rsvp && s.e.end >= now).sort((a, b) => a.e.start - b.e.start),
    [all, now],
  );

  const selectedShown = selected ? all.find((s) => s.e.coord === selected.coord) ?? null : null;

  useWindowTitle(titleOf(view, date));

  // Launched again (the menu bar's clock, a shortcut): go where it says.
  useEffect(
    () =>
      din.app.onLaunch((launch) => {
        const t = targetOf(launch);
        if (t.date) setDate(t.date);
        if (t.view) setView(t.view);
        if (launch.shortcut === 'new-event') {
          const [start, end] = defaultSlot(t.date ?? new Date());
          setEditor({ draft: blankDraft(start, end, false, null), editing: null });
        }
      }),
    [din, setView],
  );

  const run = useCallback(
    async (templates: EventTemplate[], failure: string): Promise<boolean> => {
      try {
        await publish.mutateAsync(templates);
        return true;
      } catch (error) {
        toast(failure, { body: errorText(error), destructive: true });
        return false;
      }
    },
    [publish],
  );

  /** What the user's calendars need to say for `coord` (or, with `next` null, for it to be gone). */
  const membershipChanges = useCallback(
    (old: string | null, next: string | null, into: string | null): EventTemplate[] => {
      if (!calendar) return [];
      const out: EventTemplate[] = [];
      for (const c of calendar.calendars) {
        const without = c.members.filter((m) => m !== old && m !== next);
        const members = into === c.coord && next ? [...without, next] : without;
        if (members.length !== c.members.length || members.some((m, i) => m !== c.members[i])) out.push(calendarTemplate(c.title, members, c));
      }
      return out;
    },
    [calendar],
  );

  const save = async ({ draft, editing }: Editor) => {
    if (!pubkey) return;
    const template = eventTemplate(draft, editing);
    const d = template.tags.find((t) => t[0] === 'd')![1];
    const coord = coordOf(template.kind, pubkey, d);
    const templates = [template];
    // An event that became all-day (or stopped being) is a new kind, at a new address.
    if (editing && editing.coord !== coord) templates.push(deletionTemplate(editing));
    templates.push(...membershipChanges(editing?.coord ?? null, coord, draft.calendar));
    if (await run(templates, editing ? 'Couldn’t save the event' : 'Couldn’t add the event')) {
      setEditor(null);
      setDate(new Date(draft.start));
      toast(editing ? 'Event saved' : 'Event added', { body: describeWhen({ allDay: draft.allDay, start: draft.start, end: draft.end }, locale) });
    }
  };

  const remove = async (s: Shown) => {
    setSelected(null);
    if (await run([deletionTemplate(s.e), ...membershipChanges(s.e.coord, null, null)], 'Couldn’t delete the event')) toast('Event deleted');
  };

  const act = useCallback(
    (s: Shown, action: EventAction, anchor?: HTMLElement) => {
      const calendarOf = (e: CalendarEvent) => calendar?.calendars.find((c) => c.members.includes(e.coord))?.coord ?? null;
      switch (action) {
        case 'open':
          if (anchor) setSelected({ coord: s.e.coord, rect: anchor.getBoundingClientRect() });
          return;
        case 'edit':
          setSelected(null);
          return setEditor({ draft: draftOf(s.e, calendarOf(s.e)), editing: s.e });
        case 'duplicate':
          setSelected(null);
          return setEditor({ draft: { ...draftOf(s.e, s.mine ? calendarOf(s.e) : null), participants: s.mine ? s.e.participants : [] }, editing: null });
        case 'copy-link':
          void navigator.clipboard.writeText(eventLink(s.e, din.account.relays.filter((r) => r.write).map((r) => r.url)));
          return toast('Link copied');
        case 'copy-details': {
          const text = [s.e.title, describeWhen(s.e, locale), ...s.e.locations, s.e.description.trim()].filter(Boolean).join('\n');
          void navigator.clipboard.writeText(text);
          return toast('Details copied');
        }
        case 'delete':
          return setDeleting(s);
        default: {
          const status = action.slice('rsvp:'.length) as 'accepted' | 'tentative' | 'declined';
          void run([rsvpTemplate(s.e, status, calendar?.rsvps.get(s.e.coord))], 'Couldn’t send your answer');
        }
      }
    },
    [calendar, din, run],
  );

  const create = useCallback((start: number, end: number, allDay: boolean) => {
    setSelected(null);
    setEditor({ draft: blankDraft(start, end, allDay, null), editing: null });
  }, []);

  const viewActions = useMemo<ViewActions>(
    () => ({
      selected: selected?.coord ?? null,
      select: (s, el) => setSelected((cur) => (cur?.coord === s.e.coord ? null : { coord: s.e.coord, rect: el.getBoundingClientRect() })),
      act,
      create,
      showDay: (d) => {
        setDate(d);
        setView('day');
      },
    }),
    [selected, act, create, setView],
  );

  const newEvent = () => create(...defaultSlot(sameMonthOrToday(view, date, today)), false);
  const go = (delta: number) => {
    setSelected(null);
    setDate((d) => step(view, d, delta));
  };
  const goToday = () => {
    setSelected(null);
    setDate(new Date());
  };
  const refresh = () => void data.refetch();

  const saveCalendar = async () => {
    if (!naming) return;
    const title = naming.title.trim();
    if (!title) return;
    const c = naming.source?.calendar;
    if (await run([calendarTemplate(title, c?.members ?? [], c)], c ? 'Couldn’t rename the calendar' : 'Couldn’t make the calendar')) setNaming(null);
  };

  const deleteCalendar = async (s: Source) => {
    if (s.calendar && (await run([deletionTemplate(s.calendar)], 'Couldn’t delete the calendar'))) toast(`${s.title} deleted`, { body: 'Its events are in My Events now.' });
  };

  useMenuBar(
    [
      {
        label: 'File',
        items: [
          { id: 'new', label: 'New Event', accelerator: 'Ctrl+N', enabled: !!pubkey },
          { id: 'new-calendar', label: 'New Calendar…', accelerator: 'Ctrl+Shift+N', enabled: !!pubkey },
        ],
      },
      {
        label: 'Event',
        items: [
          { id: 'edit', label: 'Edit…', accelerator: 'Ctrl+E', enabled: !!selectedShown?.mine },
          { id: 'duplicate', label: 'Duplicate', enabled: !!selectedShown },
          { id: 'copy-link', label: 'Copy Link', enabled: !!selectedShown },
          { type: 'separator' },
          { id: 'rsvp:accepted', label: 'Going', enabled: !!selectedShown && !selectedShown.mine },
          { id: 'rsvp:tentative', label: 'Maybe', enabled: !!selectedShown && !selectedShown.mine },
          { id: 'rsvp:declined', label: 'Not Going', enabled: !!selectedShown && !selectedShown.mine },
          { type: 'separator' },
          { id: 'delete', label: 'Delete…', accelerator: 'Delete', notInFields: true, enabled: !!selectedShown?.mine, destructive: true },
        ],
      },
      {
        label: 'View',
        items: [
          ...VIEWS.map((v) => ({ id: `view:${v.id}`, label: v.label, accelerator: v.accelerator })),
          { type: 'separator' as const },
          { id: 'today', label: 'Go to Today', accelerator: 'Ctrl+T' },
          { id: 'prev', label: 'Previous', accelerator: 'Ctrl+Left', notInFields: true },
          { id: 'next', label: 'Next', accelerator: 'Ctrl+Right', notInFields: true },
          { type: 'separator' as const },
          { id: 'sidebar', label: showSidebar ? 'Hide Sidebar' : 'Show Sidebar', enabled: sidebarFits },
          { id: 'refresh', label: 'Refresh', accelerator: 'Ctrl+R', enabled: !!pubkey },
        ],
      },
    ],
    (id) => {
      if (id.startsWith('view:')) return setView(id.slice(5) as View);
      switch (id) {
        case 'new': return newEvent();
        case 'new-calendar': return setNaming({ source: null, title: '' });
        case 'today': return goToday();
        case 'prev': return go(-1);
        case 'next': return go(1);
        case 'refresh': return refresh();
        case 'sidebar': {
          localStorage.setItem(SIDEBAR_KEY, showSidebar ? 'hidden' : 'shown');
          return setSidebarOpen(!showSidebar);
        }
        default:
          if (selectedShown) act(selectedShown, id as EventAction);
      }
    },
  );

  if (!pubkey) {
    return (
      <div className="flex h-full flex-col bg-background text-foreground">
        <WindowDragRegion className="flex h-13 shrink-0 items-center justify-end px-3">
          <WindowControls />
        </WindowDragRegion>
        <div className="grid flex-1 place-items-center p-8">
          <div className="flex max-w-sm flex-col items-center text-center">
            <img src="/icons/apps/calendar.png" alt="" className="mb-4 size-28 drop-shadow-md" />
            <h1 className="font-[family-name:var(--font-title)] text-2xl font-semibold">Calendar</h1>
            <p className="mt-2 text-[15px] text-muted-foreground">Sign in to Din to keep your events and answer invitations. They’re kept on your Nostr relays, so they follow you to any calendar app.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ViewContext.Provider value={viewActions}>
      <div className="relative flex h-full text-foreground">
        {showSidebar && (
          <aside aria-label="Calendars" className="flex w-64 shrink-0 flex-col border-r border-border/60 bg-background/60">
            <WindowDragRegion className="flex h-13 shrink-0 items-center gap-1 pr-2 pl-4">
              <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-[17px] font-bold">Calendar</h1>
              <ToolButton label="Hide sidebar" onClick={() => { localStorage.setItem(SIDEBAR_KEY, 'hidden'); setSidebarOpen(false); }}>
                <PanelLeft className="size-4" strokeWidth={1.75} />
              </ToolButton>
            </WindowDragRegion>
            <Sidebar
              date={date}
              today={today}
              onDate={(d) => {
                setSelected(null);
                setDate(d);
              }}
              sources={sources}
              hidden={prefs.hidden}
              onToggle={(id, on) => prefs.setHidden(id, !on)}
              onShowOnly={(id) => prefs.showOnly(id, sources.map((s) => s.id))}
              onShowAll={prefs.showAll}
              onColor={prefs.setColor}
              onNewCalendar={() => setNaming({ source: null, title: '' })}
              onRename={(s) => setNaming({ source: s, title: s.title })}
              onDeleteCalendar={setDeletingCalendar}
              awaiting={awaiting}
              onOpen={(s) => {
                setDate(new Date(s.e.start));
                setSelected(null);
                // Open its details once the view has drawn it.
                requestAnimationFrame(() => {
                  const el = document.querySelector<HTMLElement>(`[data-event="${CSS.escape(s.e.coord)}"]`);
                  if (el) setSelected({ coord: s.e.coord, rect: el.getBoundingClientRect() });
                });
              }}
            />
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col bg-background">
          <WindowDragRegion className="flex h-13 shrink-0 items-center gap-1.5 border-b border-border/60 pr-3 pl-2">
            {!showSidebar && sidebarFits && (
              <ToolButton label="Show sidebar" onClick={() => { localStorage.setItem(SIDEBAR_KEY, 'shown'); setSidebarOpen(true); }}>
                <PanelLeft className="size-4" strokeWidth={1.75} />
              </ToolButton>
            )}
            <button
              type="button"
              onClick={goToday}
              className="h-8 rounded-md border border-border px-3 text-sm font-medium outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              Today
            </button>
            <ToolButton label="Previous" onClick={() => go(-1)}>
              <ChevronLeft className="size-4.5" />
            </ToolButton>
            <ToolButton label="Next" onClick={() => go(1)}>
              <ChevronRight className="size-4.5" />
            </ToolButton>
            <h2 className="ml-1 min-w-0 flex-1 truncate text-[17px] font-semibold" aria-live="polite">{titleOf(view, date)}</h2>
            {data.isFetching ? (
              <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" aria-label="Loading" />
            ) : data.isError ? (
              <button type="button" onClick={refresh} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring/60">
                <RefreshCw className="size-3.5" /> Couldn’t reach your relays
              </button>
            ) : null}
            <div role="radiogroup" aria-label="View" className="flex rounded-lg bg-foreground/[0.06] p-0.5">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={view === v.id}
                  onClick={() => setView(v.id)}
                  className={cn(
                    'h-7 rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                    view === v.id ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <ToolButton label="New event" onClick={newEvent}>
              <Plus className="size-4.5" />
            </ToolButton>
            <WindowControls />
          </WindowDragRegion>

          {view === 'month' ? (
            <MonthView date={date} events={inRange} today={today} />
          ) : (
            <TimeGrid key={view} days={range.days} events={inRange} today={today} now={now} />
          )}
        </main>

        <Popover open={!!selectedShown && !!selected} onOpenChange={(o) => !o && setSelected(null)}>
          {selected && (
            <PopoverAnchor asChild>
              <div className="pointer-events-none fixed" style={{ left: selected.rect.left, top: selected.rect.top, width: selected.rect.width, height: selected.rect.height }} />
            </PopoverAnchor>
          )}
          <PopoverContent side="right" align="start" collisionPadding={12} className="w-[24rem] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
            {selectedShown && <EventDetails key={selectedShown.e.coord} shown={selectedShown} pubkey={pubkey} onAction={(a) => act(selectedShown, a)} />}
          </PopoverContent>
        </Popover>

        {editor && (
          <EventEditor
            initial={editor.draft}
            editing={editor.editing}
            calendars={calendar?.calendars ?? []}
            saving={publish.isPending}
            onSave={(draft) => void save({ draft, editing: editor.editing })}
            onClose={() => setEditor(null)}
          />
        )}

        {naming && (
          <Overlay label={naming.source ? 'Rename calendar' : 'New calendar'} onClose={() => setNaming(null)} className="max-w-sm">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveCalendar();
              }}
              className="space-y-4 p-5"
            >
              <h2 className="text-base font-semibold">{naming.source ? 'Rename Calendar' : 'New Calendar'}</h2>
              <input
                autoFocus
                aria-label="Calendar name"
                placeholder="Work, Family, Meetups…"
                value={naming.title}
                onChange={(e) => setNaming({ ...naming, title: e.target.value })}
                className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
              <div className="flex justify-end gap-2">
                <DialogButton onClick={() => setNaming(null)}>Cancel</DialogButton>
                <DialogButton type="submit" variant="primary" disabled={!naming.title.trim() || publish.isPending}>
                  {naming.source ? 'Rename' : 'Make Calendar'}
                </DialogButton>
              </div>
            </form>
          </Overlay>
        )}

        <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{deleting?.e.title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Your relays are asked to delete it{deleting?.e.participants.length ? ', and the people you invited see it go' : ''}. Copies elsewhere may stay.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => deleting && void remove(deleting)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={deletingCalendar !== null} onOpenChange={(o) => !o && setDeletingCalendar(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete the calendar “{deletingCalendar?.title}”?</AlertDialogTitle>
              <AlertDialogDescription>Its events aren’t deleted: yours go back to My Events, and other people’s stop showing here.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => deletingCalendar && void deleteCalendar(deletingCalendar)}>
                Delete Calendar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </ViewContext.Provider>
  );
}

/** Where New Event starts: today if it's on screen, else the day being shown. */
function sameMonthOrToday(view: View, date: Date, today: Date): Date {
  const { from, to } = rangeOf(view, date);
  return today.getTime() >= from && today.getTime() < to ? today : view === 'month' ? new Date(date.getFullYear(), date.getMonth(), 1) : startOfDay(date);
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 shrink-0 place-items-center rounded-md text-foreground/80 outline-none hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {children}
    </button>
  );
}
