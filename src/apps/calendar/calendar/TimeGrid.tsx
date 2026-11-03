import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CalendarPlus } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { addDays, formatHour, formatTime, isWeekend, layoutDay, locale, sameDay, startOfDay, weekdayName, type Placed } from './dates';
import { EventItem } from './EventItem';
import { useViewActions } from './model';
import type { Shown } from './menu';

const HOUR_PX = 48;
const SNAP_MIN = 15;
const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });

/** Where the time grid was scrolled to, kept across views and windows. */
let lastScroll: number | null = null;

interface Lane {
  shown: Shown;
  from: number;
  to: number;
  lane: number;
}

/** All-day events as bars across the days they cover, stacked where they overlap. */
function laneAllDay(events: Shown[], days: Date[]): { lanes: Lane[]; count: number } {
  const first = days[0].getTime();
  const end = addDays(days[days.length - 1], 1).getTime();
  const index = (t: number) => Math.max(0, Math.min(days.length - 1, days.findIndex((d) => d.getTime() <= t && t < addDays(d, 1).getTime())));
  const items = events
    .filter((s) => s.e.start < end && s.e.end > first)
    .map((s) => ({ shown: s, from: index(Math.max(s.e.start, first)), to: index(Math.min(s.e.end, end) - 1) }))
    .sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from));
  const taken: number[][] = [];
  const lanes: Lane[] = [];
  for (const item of items) {
    let lane = 0;
    while (taken[lane]?.some((d) => d >= item.from && d <= item.to)) lane++;
    (taken[lane] ??= []).push(...Array.from({ length: item.to - item.from + 1 }, (_, i) => item.from + i));
    lanes.push({ ...item, lane });
  }
  return { lanes, count: taken.length };
}

function minutesAt(e: { clientY: number }, column: HTMLElement): number {
  const rect = column.getBoundingClientRect();
  const minutes = ((e.clientY - rect.top) / HOUR_PX) * 60;
  return Math.max(0, Math.min(24 * 60, Math.round(minutes / SNAP_MIN) * SNAP_MIN));
}

/** Days side by side, hour by hour: the week and day views. */
export function TimeGrid({ days, events, today, now }: { days: Date[]; events: Shown[]; today: Date; now: number }) {
  const actions = useViewActions();
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ day: number; from: number; to: number } | null>(null);
  const [allDayOpen, setAllDayOpen] = useState(false);
  /** The time right-clicked, for New Event Here. */
  const contextAt = useRef<number | null>(null);

  const allDay = useMemo(() => events.filter((s) => s.e.allDay), [events]);
  const timed = useMemo(() => events.filter((s) => !s.e.allDay), [events]);
  const { lanes, count } = useMemo(() => laneAllDay(allDay, days), [allDay, days]);
  const placed = useMemo(
    () =>
      days.map((d) => {
        const from = d.getTime();
        const to = addDays(d, 1).getTime();
        const list = timed.filter((s) => s.e.start < to && (s.e.end > from || (s.e.end === s.e.start && s.e.start >= from)));
        return layoutDay(list.map((s) => ({ start: s.e.start, end: s.e.end, shown: s })), d).map((p) => ({ ...p, shown: p.event.shown }));
      }),
    [days, timed],
  );

  // Open on the working day (or where the grid was last), not at midnight.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = lastScroll ?? Math.min(7, Math.max(0, new Date().getHours() - 2)) * HOUR_PX;
  }, []);

  const shownLanes = allDayOpen ? count : Math.min(count, 3);
  const hiddenAllDay = count - shownLanes;

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, day: number) => {
    if (e.button !== 0) return;
    const column = e.currentTarget;
    const from = minutesAt(e, column);
    let moved = false;
    setDrag({ day, from, to: from + SNAP_MIN * 2 });
    column.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const at = minutesAt(ev, column);
      if (at !== from) moved = true;
      setDrag({ day, from: Math.min(from, at), to: Math.max(from + SNAP_MIN, at) });
    };
    const up = (ev: PointerEvent) => {
      column.removeEventListener('pointermove', move);
      column.removeEventListener('pointerup', up);
      column.removeEventListener('pointercancel', up);
      setDrag(null);
      if (!moved || ev.type === 'pointercancel') return;
      const at = minutesAt(ev, column);
      const start = Math.min(from, at);
      const end = Math.max(from + SNAP_MIN, at);
      const base = startOfDay(days[day]).getTime();
      actions.create(base + start * 60_000, base + end * 60_000, false);
    };
    column.addEventListener('pointermove', move);
    column.addEventListener('pointerup', up);
    column.addEventListener('pointercancel', up);
  };

  const single = days.length === 1;
  const cols = { gridTemplateColumns: `4rem repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The days, and their all-day events, with room kept where the grid below has its scrollbar so the columns line up. */}
      <div className="overflow-hidden border-b border-border/60 [scrollbar-gutter:stable]">
        <div className="grid" style={cols}>
          <div />
          {days.map((d) => {
            const isToday = sameDay(d, today);
            return (
              <button
                key={d.getTime()}
                type="button"
                disabled={single}
                onClick={() => actions.showDay(d)}
                aria-label={`Show ${fullDate.format(d)}`}
                className={cn('flex items-baseline gap-1.5 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default', single ? '' : 'hover:bg-foreground/[0.04]')}
              >
                <span className={cn('text-xs font-medium text-muted-foreground', isToday && 'text-red-500')}>{weekdayName(d, single ? 'long' : 'short')}</span>
                <span className={cn('grid h-7 min-w-7 place-items-center rounded-full px-1 text-lg font-semibold tabular-nums', isToday && 'bg-red-500 text-white', isWeekend(d) && !isToday && 'text-muted-foreground')}>
                  {d.getDate()}
                </span>
              </button>
            );
          })}
        </div>
        <div className="grid" style={cols}>
          <div className="flex items-start justify-end pt-1 pr-2 text-[11px] text-muted-foreground">
            {hiddenAllDay > 0 || allDayOpen ? (
              <button type="button" onClick={() => setAllDayOpen((o) => !o)} className="rounded px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
                {allDayOpen ? 'fewer' : `${hiddenAllDay} more`}
              </button>
            ) : (
              'all-day'
            )}
          </div>
          <div
            className="relative"
            style={{ gridColumn: `2 / span ${days.length}`, height: Math.max(1, shownLanes) * 22 + 6 }}
            onDoubleClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const i = Math.floor(((e.clientX - rect.left) / rect.width) * days.length);
              const d = days[Math.max(0, Math.min(days.length - 1, i))];
              actions.create(d.getTime(), addDays(d, 1).getTime(), true);
            }}
          >
            {days.map((d, i) => (
              <div key={d.getTime()} className="absolute inset-y-0 border-l border-border/50" style={{ left: `${(i / days.length) * 100}%` }} aria-hidden />
            ))}
            {lanes
              .filter((l) => l.lane < shownLanes)
              .map((l) => (
                <EventItem
                  key={l.shown.key}
                  shown={l.shown}
                  label={`${l.shown.e.title}, all day`}
                  className="absolute flex h-5 items-center truncate rounded-sm bg-[color-mix(in_oklab,var(--ev)_32%,transparent)] px-1.5 text-xs font-medium data-[selected]:bg-(--ev) data-[selected]:text-white"
                  style={{ top: 3 + l.lane * 22, left: `calc(${(l.from / days.length) * 100}% + 2px)`, width: `calc(${((l.to - l.from + 1) / days.length) * 100}% - 4px)` }}
                >
                  <span className="truncate">{l.shown.e.title}</span>
                </EventItem>
              ))}
          </div>
        </div>
      </div>

      {/* Hour by hour. */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]" onScroll={(e) => (lastScroll = e.currentTarget.scrollTop)}>
        <div className="relative grid" style={{ ...cols, height: 24 * HOUR_PX }}>
          <div className="relative" aria-hidden>
            {Array.from({ length: 23 }, (_, h) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums" style={{ top: (h + 1) * HOUR_PX }}>
                {formatHour(h + 1)}
              </span>
            ))}
          </div>
          {days.map((d, i) => {
            const isToday = sameDay(d, today);
            const nowTop = ((now - startOfDay(d).getTime()) / 3_600_000) * HOUR_PX;
            return (
              <ContextMenu key={d.getTime()}>
                <ContextMenuTrigger asChild>
                  <div
                    role="group"
                    aria-label={fullDate.format(d)}
                    className={cn('relative border-l border-border/50 select-none', isWeekend(d) && !single && 'bg-foreground/[0.02]')}
                    style={{
                      backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${HOUR_PX - 1}px, color-mix(in oklab, var(--border) 60%, transparent) ${HOUR_PX - 1}px ${HOUR_PX}px)`,
                    }}
                    onPointerDown={(e) => startDrag(e, i)}
                    onDoubleClick={(e) => {
                      const m = Math.floor(minutesAt(e, e.currentTarget) / 30) * 30;
                      const base = startOfDay(d).getTime();
                      actions.create(base + m * 60_000, base + (m + 60) * 60_000, false);
                    }}
                    onContextMenuCapture={(e) => {
                      const m = Math.floor(minutesAt(e, e.currentTarget) / 30) * 30;
                      contextAt.current = startOfDay(d).getTime() + m * 60_000;
                    }}
                  >
                    {placed[i].map((p) => (
                      <TimedEvent key={p.shown.key} placed={p} compact={!single && days.length > 3} />
                    ))}
                    {drag?.day === i && (
                      <div
                        className="pointer-events-none absolute inset-x-1 z-10 rounded-md border-2 border-primary bg-primary/15 px-1.5 text-xs font-medium text-primary"
                        style={{ top: (drag.from / 60) * HOUR_PX, height: Math.max(SNAP_MIN, drag.to - drag.from) * (HOUR_PX / 60) }}
                      >
                        {formatTime(startOfDay(d).getTime() + drag.from * 60_000)} – {formatTime(startOfDay(d).getTime() + drag.to * 60_000)}
                      </div>
                    )}
                    {isToday && nowTop >= 0 && nowTop <= 24 * HOUR_PX && (
                      <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: nowTop }} aria-hidden>
                        <div className="absolute -top-[5px] -left-[5px] size-2.5 rounded-full bg-red-500" />
                        <div className="h-0.5 bg-red-500" />
                      </div>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-52">
                  <ContextMenuItem
                    onSelect={() => {
                      const start = contextAt.current ?? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9).getTime();
                      actions.create(start, start + 3_600_000, false);
                    }}
                  >
                    <CalendarPlus /> New Event Here
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => actions.create(d.getTime(), addDays(d, 1).getTime(), true)}>
                    <CalendarPlus /> New All-Day Event
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TimedEvent({ placed, compact }: { placed: Omit<Placed<unknown>, 'event'> & { shown: Shown }; compact: boolean }) {
  const { shown, top, height, column, columns } = placed;
  const { e } = shown;
  const short = height < 40;
  const width = 100 / columns;
  const when = e.end > e.start ? `${formatTime(e.start)} – ${formatTime(e.end)}` : formatTime(e.start);
  return (
    <EventItem
      shown={shown}
      label={`${e.title}, ${when}`}
      className={cn(
        'absolute flex flex-col items-stretch justify-start overflow-hidden rounded-md border-l-[3px] border-(--ev) bg-[color-mix(in_oklab,var(--ev)_30%,var(--background))] px-1.5 py-0.5 text-xs leading-tight shadow-[0_0_0_1px_var(--background)]',
        'hover:bg-[color-mix(in_oklab,var(--ev)_40%,var(--background))] data-[selected]:z-10 data-[selected]:bg-(--ev) data-[selected]:text-white',
      )}
      style={{ top: (top / 60) * HOUR_PX + 1, height: Math.max(18, (height / 60) * HOUR_PX - 2), left: `calc(${column * width}% + 1px)`, width: `calc(${width}% - 3px)` }}
    >
      {short ? (
        <span className="block truncate">
          <span className="font-semibold">{e.title}</span>
          {!compact && <span className="opacity-75">, {formatTime(e.start)}</span>}
        </span>
      ) : (
        <>
          <span className="block truncate font-semibold">{e.title}</span>
          <span className="block truncate opacity-75 tabular-nums">{when}</span>
          {e.locations[0] && height >= 75 && <span className="block truncate opacity-75">{e.locations[0]}</span>}
        </>
      )}
    </EventItem>
  );
}

