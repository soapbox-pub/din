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
import { useMediaQuery, useMenuBar, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
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
  type EventTemplate,
} from '@/shared/calendar';
import { createCalendar, deleteCalendar, deleteLocalEvent, renameCalendar, saveLocalEvent, setCalendarColor, setNostrCalendar } from '@/shared/localCalendar';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { toast } from '@/shared/toast';
import { ContentPane, PillButton, SegmentedControl, SidebarTitle, SidebarTitleIcon, ToolButton } from '@/shared/appChrome';
import { sidebarWidthClass, toolIcon } from '@/shared/appChromeStyles';
import { locale, rangeOf, startOfDay, step, titleOf, type View } from './calendar/dates';
import { EventDetails } from './calendar/EventDetails';
import { EventEditor } from './calendar/EventEditor';
import { eventLink, type EventAction, type Shown } from './calendar/menu';
import { MonthView } from './calendar/MonthView';
import { blankDraft, defaultSlot, draftOf, useNow, ViewContext, type Draft, type ViewActions } from './calendar/model';
import { useLocalCalendars, useLocalChange } from './calendar/local';
import { restoredState, saveState, useOnLaunch, wasReopened, windowLaunch, type Launch } from '@/shared/launch';
import { useCalendarData, usePubkey, usePublish, writeRelays } from './calendar/nostr';
import { Sidebar } from './calendar/Sidebar';
import { CALENDAR_COLORS, localSource, NOSTR, sourcesOf, useSourcePrefs, type Source, type SourceId } from './calendar/sources';
import { TimeGrid } from './calendar/TimeGrid';

const VIEW_KEY = 'din:calendar:view';
const SIDEBAR_KEY = 'din:calendar:sidebar';
/** The calendar on this computer new events go in, the last one picked. */
const TARGET_KEY = 'din:calendar:target';
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

function savedOf(state: unknown): Saved | null {
  const s = state as Partial<Saved> | null;
  return s && isView(s.view) && typeof s.date === 'string' ? { view: s.view, date: s.date } : null;
}

/** A launch's `{ date, view }`: the day (and view) to show. */
function targetOf(launch: Pick<Launch, 'params'>): { date: Date | null; view: View | null } {
  const { date, view } = launch.params;
  return { date: typeof date === 'string' ? parseIsoDate(date) : null, view: isView(view) ? view : null };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Editor = { draft: Draft; editing: Shown | null };

function storedTarget(): SourceId {
  return localStorage.getItem(TARGET_KEY) ?? localSource('personal');
}

/**
 * Calendar: the user's events, by day, week or month. They're kept on this
 * computer, in calendars of .ics files (src/shared/localCalendar.ts); the
 * public Nostr calendar (NIP-52: the user's public events, and invitations
 * from people on Nostr) sits beside them, marked Public, and an event goes
 * there only when the user picks it. Launch params `{ date: 'YYYY-MM-DD',
 * view }` show a day; `new` (the New Event shortcut's) starts one.
 */
export function Calendar() {
  const local = useLocalCalendars();
  const change = useLocalChange();
  const nostrOn = local.data?.settings.nostr ?? false;
  const pubkey = usePubkey();
  const data = useCalendarData(pubkey, nostrOn);
  const calendar = nostrOn ? data.calendar : null;
  const publish = usePublish();
  const prefs = useSourcePrefs();
  const now = useNow();
  const today = useMemo(() => startOfDay(now), [now]);

  const [saved] = useState(() => (wasReopened() ? savedOf(restoredState()) : null));
  const [view, setViewState] = useState<View>(() => {
    const v = saved?.view ?? targetOf(windowLaunch()).view ?? localStorage.getItem(VIEW_KEY);
    return isView(v) ? v : 'week';
  });
  const [date, setDate] = useState<Date>(() => (saved ? parseIsoDate(saved.date) : targetOf(windowLaunch()).date) ?? new Date());
  const [selected, setSelected] = useState<{ key: string; rect: DOMRect } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(() => {
    if (!('new' in windowLaunch().params) || wasReopened()) return null;
    const [start, end] = defaultSlot(new Date());
    return { draft: blankDraft(start, end, false, storedTarget()), editing: null };
  });
  const [deleting, setDeleting] = useState<Shown | null>(null);
  const [naming, setNaming] = useState<{ source: Source | null; title: string } | null>(null);
  const [deletingCalendar, setDeletingCalendar] = useState<Source | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== 'hidden');
  const sidebarFits = useMediaQuery(`(min-width: ${SIDEBAR_MIN_WIDTH}px)`);
  const showSidebar = sidebarOpen && sidebarFits;

  const setView = useCallback((v: View) => {
    setViewState(v);
    localStorage.setItem(VIEW_KEY, v);
  }, []);

  useEffect(() => saveState({ view, date: isoDate(date) } satisfies Saved), [view, date]);

  const sources = useMemo(() => sourcesOf(local.data?.calendars ?? [], nostrOn, prefs.colors), [local.data, nostrOn, prefs.colors]);
  const localSources = useMemo(() => sources.filter((s) => s.local), [sources]);
  /** Where a new event goes: the calendar on this computer last picked. Never Nostr unless the user picks it. */
  const defaultTarget = useCallback((): SourceId => {
    const stored = storedTarget();
    return localSources.some((s) => s.id === stored) ? stored : localSources[0]?.id ?? stored;
  }, [localSources]);

  // Every event, with the colour of where it's from and the user's answer.
  const all = useMemo<Shown[]>(() => {
    const color = new Map(sources.map((s) => [s.id, s.color]));
    const out: Shown[] = (local.data?.events ?? []).map((e) => {
      const source = localSource(e.calendar);
      return { kind: 'local', e, key: `local:${e.calendar}/${e.uid}`, source, color: color.get(source) ?? CALENDAR_COLORS[0], mine: true, rsvp: null };
    });
    if (calendar && pubkey) {
      for (const e of calendar.events.values()) {
        out.push({ kind: 'nostr', e, key: e.coord, source: NOSTR, color: color.get(NOSTR) ?? CALENDAR_COLORS[0], mine: e.pubkey === pubkey, rsvp: calendar.rsvps.get(e.coord)?.status ?? null });
      }
    }
    return out;
  }, [local.data, calendar, pubkey, sources]);
  const visible = useMemo(() => all.filter((s) => !prefs.hidden.has(s.source)), [all, prefs.hidden]);

  const range = useMemo(() => rangeOf(view, date), [view, date]);
  const inRange = useMemo(() => {
    return eventsBetween(visible.map((s) => ({ start: s.e.start, end: s.e.end, allDay: s.e.allDay, title: s.e.title, s })), range.from, range.to).map((x) => x.s);
  }, [visible, range]);

  const awaiting = useMemo(
    () => all.filter((s) => s.kind === 'nostr' && !s.mine && !s.rsvp && s.e.end >= now).sort((a, b) => a.e.start - b.e.start),
    [all, now],
  );

  const selectedShown = selected ? all.find((s) => s.key === selected.key) ?? null : null;

  useWindowTitle(titleOf(view, date));

  // Launched again (the menu bar's clock, a shortcut): go where it says.
  useOnLaunch((launch) => {
    const t = targetOf(launch);
    if (t.date) setDate(t.date);
    if (t.view) setView(t.view);
    if ('new' in launch.params) {
      const [start, end] = defaultSlot(t.date ?? new Date());
      setEditor({ draft: blankDraft(start, end, false, defaultTarget()), editing: null });
    }
  });

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

  const nostrListOf = useCallback(
    (s: Shown) => (s.kind === 'nostr' ? calendar?.calendars.find((c) => c.members.includes(s.e.coord))?.coord ?? null : null),
    [calendar],
  );

  /** Ask relays to delete a Nostr event, and take it out of the user's NIP-52 calendars. */
  const unpublish = (s: Shown & { kind: 'nostr' }, failure: string) => run([deletionTemplate(s.e), ...membershipChanges(s.e.coord, null, null)], failure);

  const save = async ({ draft, editing }: Editor) => {
    const failure = editing ? 'Couldn’t save the event' : 'Couldn’t add the event';
    if (draft.target === NOSTR) {
      if (!pubkey) return;
      const previous = editing?.kind === 'nostr' ? editing.e : null;
      const template = eventTemplate(draft, previous);
      const d = template.tags.find((t) => t[0] === 'd')![1];
      const coord = coordOf(template.kind, pubkey, d);
      const templates = [template];
      // An event that became all-day (or stopped being) is a new kind, at a new address.
      if (previous && previous.coord !== coord) templates.push(deletionTemplate(previous));
      templates.push(...membershipChanges(previous?.coord ?? null, coord, draft.calendar));
      if (!(await run(templates, failure))) return;
      // Moved from this computer onto Nostr: it's kept there now.
      if (editing?.kind === 'local') await change((fs) => deleteLocalEvent(fs, editing.e), 'Couldn’t remove the copy on this computer');
    } else {
      const target = localSources.find((s) => s.id === draft.target)?.local;
      if (!target) return;
      const saved = await change((fs) => saveLocalEvent(fs, target, draft, editing?.kind === 'local' ? editing.e : null), failure);
      if (!saved) return;
      localStorage.setItem(TARGET_KEY, draft.target);
      if (editing?.kind === 'nostr') await unpublish(editing, 'Couldn’t delete the public copy');
    }
    setEditor(null);
    setDate(new Date(draft.start));
    toast(draft.target === NOSTR && editing?.kind !== 'nostr' ? 'Event published' : editing ? 'Event saved' : 'Event added', {
      body: describeWhen({ allDay: draft.allDay, start: draft.start, end: draft.end }, locale),
    });
  };

  const remove = async (s: Shown) => {
    setSelected(null);
    if (s.kind === 'local') {
      if ((await change((fs) => deleteLocalEvent(fs, s.e).then(() => true), 'Couldn’t delete the event')) !== undefined) toast('Event deleted');
    } else if (await unpublish(s, 'Couldn’t delete the event')) toast('Event deleted');
  };

  const act = useCallback(
    (s: Shown, action: EventAction, anchor?: HTMLElement) => {
      switch (action) {
        case 'open':
          if (anchor) setSelected({ key: s.key, rect: anchor.getBoundingClientRect() });
          return;
        case 'edit':
          if (!s.mine) return;
          setSelected(null);
          return setEditor({ draft: draftOf(s, nostrListOf(s)), editing: s });
        case 'duplicate': {
          setSelected(null);
          const draft = draftOf(s, s.mine ? nostrListOf(s) : null);
          // A copy of someone else's event is the user's own, on this computer.
          return setEditor({ draft: s.mine ? draft : { ...draft, participants: [], target: defaultTarget() }, editing: null });
        }
        case 'copy-link':
          if (s.kind !== 'nostr') return;
          void navigator.clipboard.writeText(eventLink(s.e, writeRelays()));
          return toast('Link copied');
        case 'copy-details': {
          const text = [s.e.title, describeWhen(s.e, locale), ...s.e.locations, s.e.description.trim()].filter(Boolean).join('\n');
          void navigator.clipboard.writeText(text);
          return toast('Details copied');
        }
        case 'delete':
          if (s.mine) setDeleting(s);
          return;
        default: {
          if (s.kind !== 'nostr' || s.mine) return;
          const status = action.slice('rsvp:'.length) as 'accepted' | 'tentative' | 'declined';
          void run([rsvpTemplate(s.e, status, calendar?.rsvps.get(s.e.coord))], 'Couldn’t send your answer');
        }
      }
    },
    [calendar, run, nostrListOf, defaultTarget],
  );

  const create = useCallback((start: number, end: number, allDay: boolean) => {
    setSelected(null);
    setEditor({ draft: blankDraft(start, end, allDay, defaultTarget()), editing: null });
  }, [defaultTarget]);

  const viewActions = useMemo<ViewActions>(
    () => ({
      selected: selected?.key ?? null,
      select: (s, el) => setSelected((cur) => (cur?.key === s.key ? null : { key: s.key, rect: el.getBoundingClientRect() })),
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
  const refresh = () => {
    void local.refetch();
    if (nostrOn && pubkey) void data.refetch();
  };

  const saveCalendar = async () => {
    if (!naming) return;
    const title = naming.title.trim();
    if (!title) return;
    const c = naming.source?.local;
    const color = CALENDAR_COLORS[localSources.length % CALENDAR_COLORS.length];
    const done = await change(
      (fs) => (c ? renameCalendar(fs, c, title).then(() => c.id) : createCalendar(fs, title, color).then((made) => made.id)),
      c ? 'Couldn’t rename the calendar' : 'Couldn’t make the calendar',
    );
    if (done !== undefined) setNaming(null);
  };

  const removeCalendar = async (s: Source) => {
    const c = s.local;
    if (!c) return;
    if ((await change((fs) => deleteCalendar(fs, c).then(() => true), 'Couldn’t delete the calendar')) !== undefined) toast(`${s.title} deleted`);
  };

  const setColor = (id: SourceId, color: string) => {
    const c = sources.find((s) => s.id === id)?.local;
    if (c) void change((fs) => setCalendarColor(fs, c, color), 'Couldn’t change the colour');
    else prefs.setColor(id, color);
  };

  const setNostr = (on: boolean) => void change((fs) => setNostrCalendar(fs, on), on ? 'Couldn’t show the Nostr calendar' : 'Couldn’t hide the Nostr calendar');

  const eventsIn = (s: Source | null) => (s ? all.filter((x) => x.source === s.id).length : 0);

  useMenuBar(
    [
      {
        label: 'File',
        items: [
          { id: 'new', label: 'New Event', accelerator: 'Ctrl+N', enabled: localSources.length > 0 },
          { id: 'new-calendar', label: 'New Calendar…', accelerator: 'Ctrl+Shift+N', enabled: !!local.data },
        ],
      },
      {
        label: 'Event',
        items: [
          { id: 'edit', label: 'Edit…', accelerator: 'Ctrl+E', enabled: !!selectedShown?.mine },
          { id: 'duplicate', label: 'Duplicate', enabled: !!selectedShown },
          { id: 'copy-link', label: 'Copy Link', enabled: selectedShown?.kind === 'nostr' },
          { type: 'separator' },
          { id: 'rsvp:accepted', label: 'Going', enabled: selectedShown?.kind === 'nostr' && !selectedShown.mine },
          { id: 'rsvp:tentative', label: 'Maybe', enabled: selectedShown?.kind === 'nostr' && !selectedShown.mine },
          { id: 'rsvp:declined', label: 'Not Going', enabled: selectedShown?.kind === 'nostr' && !selectedShown.mine },
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
          { id: 'nostr', type: 'checkbox' as const, label: 'Nostr Calendar', checked: nostrOn, enabled: !!local.data },
          { id: 'refresh', label: 'Refresh', accelerator: 'Ctrl+R' },
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
        case 'nostr': return setNostr(!nostrOn);
        case 'sidebar': {
          localStorage.setItem(SIDEBAR_KEY, showSidebar ? 'hidden' : 'shown');
          return setSidebarOpen(!showSidebar);
        }
        default:
          if (selectedShown) act(selectedShown, id as EventAction);
      }
    },
  );

  return (
    <ViewContext.Provider value={viewActions}>
      <div className="relative flex h-full text-foreground">
        {showSidebar && (
          <aside aria-label="Calendars" className={`flex shrink-0 flex-col ${sidebarWidthClass}`}>
            <SidebarTitle icon={<SidebarTitleIcon src="/icons/apps/calendar.png" />} title="Calendar">
              <ToolButton label="Hide sidebar" onClick={() => { localStorage.setItem(SIDEBAR_KEY, 'hidden'); setSidebarOpen(false); }}>
                <PanelLeft {...toolIcon} />
              </ToolButton>
            </SidebarTitle>
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
              onColor={setColor}
              onNewCalendar={() => setNaming({ source: null, title: '' })}
              onRename={(s) => setNaming({ source: s, title: s.title })}
              onDeleteCalendar={setDeletingCalendar}
              awaiting={awaiting}
              onOpen={(s) => {
                setDate(new Date(s.e.start));
                setSelected(null);
                // Open its details once the view has drawn it.
                requestAnimationFrame(() => {
                  const el = document.querySelector<HTMLElement>(`[data-event="${CSS.escape(s.key)}"]`);
                  if (el) setSelected({ key: s.key, rect: el.getBoundingClientRect() });
                });
              }}
            />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <WindowDragRegion className="flex h-12 shrink-0 items-center gap-1.5 pr-3 pl-2">
            {!showSidebar && sidebarFits && (
              <ToolButton label="Show sidebar" onClick={() => { localStorage.setItem(SIDEBAR_KEY, 'shown'); setSidebarOpen(true); }}>
                <PanelLeft {...toolIcon} />
              </ToolButton>
            )}
            {/* What acts on the calendar first, as in every app's title bar;
                then where it is, the date filling the rest. */}
            <SegmentedControl size="md" label="View" value={view} options={VIEWS.map((v) => ({ value: v.id, label: v.label }))} onValueChange={setView} />
            <ToolButton label="New event" onClick={newEvent}>
              <Plus {...toolIcon} />
            </ToolButton>
            <PillButton onClick={goToday} className="ml-1.5 h-8">
              Today
            </PillButton>
            <ToolButton label="Previous" onClick={() => go(-1)}>
              <ChevronLeft {...toolIcon} />
            </ToolButton>
            <ToolButton label="Next" onClick={() => go(1)}>
              <ChevronRight {...toolIcon} />
            </ToolButton>
            <h2 className="ml-1 min-w-0 flex-1 truncate text-[17px] font-semibold" aria-live="polite">{titleOf(view, date)}</h2>
            {local.isFetching || (nostrOn && data.isFetching) ? (
              <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" aria-label="Loading" />
            ) : local.isError ? (
              <button type="button" onClick={refresh} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring/60">
                <RefreshCw className="size-3.5" /> Couldn’t read your calendars
              </button>
            ) : nostrOn && data.isError ? (
              <button type="button" onClick={refresh} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring/60">
                <RefreshCw className="size-3.5" /> Couldn’t reach your Nostr relays
              </button>
            ) : null}
            <WindowControls />
          </WindowDragRegion>

          <ContentPane inset={showSidebar}>
            {view === 'month' ? (
              <MonthView date={date} events={inRange} today={today} />
            ) : (
              <TimeGrid key={view} days={range.days} events={inRange} today={today} now={now} />
            )}
          </ContentPane>
        </div>

        <Popover open={!!selectedShown && !!selected} onOpenChange={(o) => !o && setSelected(null)}>
          {selected && (
            <PopoverAnchor asChild>
              <div className="pointer-events-none fixed" style={{ left: selected.rect.left, top: selected.rect.top, width: selected.rect.width, height: selected.rect.height }} />
            </PopoverAnchor>
          )}
          <PopoverContent side="right" align="start" collisionPadding={12} className="w-[24rem] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
            {selectedShown && (
              <EventDetails
                key={selectedShown.key}
                shown={selectedShown}
                calendarTitle={sources.find((s) => s.id === selectedShown.source)?.title ?? ''}
                pubkey={pubkey}
                onAction={(a) => act(selectedShown, a)}
              />
            )}
          </PopoverContent>
        </Popover>

        {editor && (
          <EventEditor
            initial={editor.draft}
            editing={editor.editing}
            sources={sources}
            canPublish={!!pubkey}
            nostrLists={calendar?.calendars ?? []}
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
              {!naming.source && <p className="text-sm text-muted-foreground">Kept on this computer, like your other calendars. Nothing in it is shared.</p>}
              <input
                autoFocus
                aria-label="Calendar name"
                placeholder="Work, Family, Meetups…"
                value={naming.title}
                onChange={(e) => setNaming({ ...naming, title: e.target.value })}
                className="h-9 w-full rounded-lg bg-foreground/[0.06] px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
              <div className="flex justify-end gap-2">
                <DialogButton onClick={() => setNaming(null)}>Cancel</DialogButton>
                <DialogButton type="submit" variant="primary" disabled={!naming.title.trim()}>
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
                {deleting?.kind === 'nostr'
                  ? `Your relays are asked to delete it${deleting.e.participants.length ? ', and the people you invited see it go' : ''}. Copies elsewhere may stay.`
                  : 'It’s deleted from this computer.'}
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
              <AlertDialogDescription>
                {eventsIn(deletingCalendar) ? `Its ${eventsIn(deletingCalendar) === 1 ? 'event is' : `${eventsIn(deletingCalendar)} events are`} deleted from this computer too.` : 'It has no events.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => deletingCalendar && void removeCalendar(deletingCalendar)}>
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

