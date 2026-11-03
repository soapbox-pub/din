import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarPlus, CalendarSearch } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { addDays, formatTime, isWeekend, locale, rangeOf, sameDay, startOfWeek, weekdayName } from './dates';
import { EventItem } from './EventItem';
import { defaultSlot, useViewActions } from './model';
import type { Shown } from './menu';

const ROW_PX = 22;
const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });
const monthDay = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });


function MonthChip({ shown, day }: { shown: Shown; day: Date }) {
  const { e } = shown;
  const continues = e.allDay || !sameDay(e.start, e.end - 1);
  const label = `${e.title}, ${e.allDay ? 'all day' : formatTime(e.start)}`;
  if (continues) {
    const weekStart = sameDay(day, startOfWeek(day));
    const first = sameDay(e.start, day) || weekStart;
    // A bar runs on into the days beside it in the same week.
    const fromBefore = !sameDay(e.start, day) && !weekStart;
    const intoNext = !sameDay(e.end - 1, day) && day.getDay() !== (startOfWeek(day).getDay() + 6) % 7;
    return (
      <EventItem
        shown={shown}
        label={label}
        className={cn(
          'flex h-5 shrink-0 items-center truncate rounded-sm bg-[color-mix(in_oklab,var(--ev)_32%,transparent)] px-1.5 text-xs font-medium data-[selected]:bg-(--ev) data-[selected]:text-white',
          fromBefore && '-ml-1 rounded-l-none',
          intoNext && '-mr-1 rounded-r-none',
        )}
      >
        <span className="truncate">{first ? e.title : ''}&nbsp;</span>
      </EventItem>
    );
  }
  return (
    <EventItem
      shown={shown}
      label={label}
      className="flex h-5 w-full items-center gap-1.5 truncate rounded-sm px-1 text-xs hover:bg-foreground/[0.06] data-[selected]:bg-(--ev) data-[selected]:text-white"
    >
      <span className="size-2 shrink-0 rounded-full bg-(--ev) group-data-[selected]/event:bg-white" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{e.title}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums group-data-[selected]/event:text-white/85">{formatTime(e.start)}</span>
    </EventItem>
  );
}

/** Six weeks of days, each with as many of its events as fit and a count of the rest. */
export function MonthView({ date, events, today }: { date: Date; events: Shown[]; today: Date }) {
  const actions = useViewActions();
  const { days } = useMemo(() => rangeOf('month', date), [date]);
  const grid = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(3);

  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const cell = el.clientHeight / 6;
      setRows(Math.max(1, Math.floor((cell - 30) / ROW_PX)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byDay = useMemo(
    () =>
      days.map((d) => {
        const list = events.filter((s) => s.e.start < addDays(d, 1).getTime() && (s.e.end > d.getTime() || (s.e.end === s.e.start && s.e.start >= d.getTime())));
        return list.sort((a, b) => Number(b.e.allDay) - Number(a.e.allDay) || a.e.start - b.e.start || a.e.title.localeCompare(b.e.title));
      }),
    [days, events],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-border/60" aria-hidden>
        {days.slice(0, 7).map((d) => (
          <div key={d.getDay()} className={cn('px-2 py-1.5 text-right text-xs font-medium text-muted-foreground', isWeekend(d) && 'text-muted-foreground/80')}>
            {weekdayName(d)}
          </div>
        ))}
      </div>
      <div ref={grid} role="grid" aria-label="Month" className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((d, i) => {
          const inMonth = d.getMonth() === date.getMonth();
          const isToday = sameDay(d, today);
          const list = byDay[i];
          const fits = list.length > rows ? rows - 1 : rows;
          const hidden = list.length - Math.min(list.length, fits);
          return (
            <ContextMenu key={d.getTime()}>
              <ContextMenuTrigger asChild>
                <div
                  role="gridcell"
                  aria-label={`${fullDate.format(d)}${list.length ? `, ${list.length} event${list.length === 1 ? '' : 's'}` : ''}`}
                  aria-current={isToday ? 'date' : undefined}
                  onDoubleClick={() => actions.create(...defaultSlot(d), false)}
                  className={cn(
                    'flex min-h-0 min-w-0 flex-col gap-px overflow-hidden border-r border-b border-border/50 px-1 pt-1 pb-0.5',
                    i % 7 === 6 && 'border-r-0',
                    (!inMonth || isWeekend(d)) && 'bg-foreground/[0.02]',
                  )}
                >
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => actions.showDay(d)}
                      aria-label={`Show ${fullDate.format(d)}`}
                      className={cn(
                        'grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[13px] tabular-nums outline-none hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-ring/60',
                        !inMonth && 'text-muted-foreground/70',
                        isToday && 'bg-red-500 font-semibold text-white hover:bg-red-500/90',
                      )}
                    >
                      {d.getDate() === 1 ? monthDay.format(d) : d.getDate()}
                    </button>
                  </div>
                  {list.slice(0, fits).map((s) => (
                    <MonthChip key={s.key} shown={s} day={d} />
                  ))}
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => actions.showDay(d)}
                      className="h-5 shrink-0 rounded-sm px-1 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      {hidden} more
                    </button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52">
                <ContextMenuItem onSelect={() => actions.create(...defaultSlot(d), false)}>
                  <CalendarPlus /> New Event
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => actions.create(d.getTime(), addDays(d, 1).getTime(), true)}>
                  <CalendarPlus /> New All-Day Event
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => actions.showDay(d)}>
                  <CalendarSearch /> Show Day
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
    </div>
  );
}
