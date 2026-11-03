import { useState } from 'react';
import { Check, Eye, EyeOff, Palette, Pencil, Plus, Trash2 } from 'lucide-react';
import { Calendar as MiniMonth } from '@/components/ui/calendar';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { describeWhen } from '@/shared/calendar';
import { FIRST_DAY, locale } from './dates';
import { colorStyle } from './model';
import type { Shown } from './menu';
import { COLORS, NOSTR, type Source, type SourceId } from './sources';

export function Sidebar({
  date,
  today,
  onDate,
  sources,
  hidden,
  onToggle,
  onShowOnly,
  onShowAll,
  onColor,
  onNewCalendar,
  onRename,
  onDeleteCalendar,
  awaiting,
  onOpen,
}: {
  date: Date;
  today: Date;
  onDate: (d: Date) => void;
  sources: Source[];
  hidden: ReadonlySet<SourceId>;
  onToggle: (id: SourceId, shown: boolean) => void;
  onShowOnly: (id: SourceId) => void;
  onShowAll: () => void;
  onColor: (id: SourceId, color: string) => void;
  onNewCalendar: () => void;
  onRename: (s: Source) => void;
  onDeleteCalendar: (s: Source) => void;
  /** Invitations to come that the user hasn't answered. */
  awaiting: Shown[];
  onOpen: (s: Shown) => void;
}) {
  const [month, setMonth] = useState(date);
  const [shownMonth, setShownMonth] = useState(date);
  // Following the view: a new date moves the little month to it.
  if (shownMonth.getTime() !== date.getTime()) {
    setShownMonth(date);
    setMonth(date);
  }

  const nostr = sources.find((s) => s.id === NOSTR);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <MiniMonth
        mode="single"
        required
        selected={date}
        onSelect={(d) => d && onDate(d)}
        month={month}
        onMonthChange={setMonth}
        weekStartsOn={FIRST_DAY as 0 | 1 | 2 | 3 | 4 | 5 | 6}
        today={today}
        className="mx-auto bg-transparent p-2 [--cell-size:--spacing(7.5)]"
      />

      <section aria-labelledby="calendars-heading" className="px-2 pt-2">
        <div className="flex items-center px-2 pb-1">
          <h2 id="calendars-heading" className="flex-1 text-xs font-semibold text-muted-foreground">Calendars</h2>
          <button
            type="button"
            aria-label="New calendar"
            title="New calendar"
            onClick={onNewCalendar}
            className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <ul className="space-y-px">
          {sources.filter((s) => s.local).map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              on={!hidden.has(s.id)}
              onToggle={onToggle}
              onShowOnly={onShowOnly}
              onShowAll={onShowAll}
              onColor={onColor}
              extra={
                <>
                  <ContextMenuItem onSelect={() => onRename(s)}>
                    <Pencil /> Rename…
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" disabled={sources.filter((x) => x.local).length < 2} onSelect={() => onDeleteCalendar(s)}>
                    <Trash2 /> Delete Calendar…
                  </ContextMenuItem>
                </>
              }
            />
          ))}
          {nostr && (
            <SourceRow source={nostr} on={!hidden.has(NOSTR)} onToggle={onToggle} onShowOnly={onShowOnly} onShowAll={onShowAll} onColor={onColor} badge />
          )}
        </ul>
      </section>

      {awaiting.length > 0 && (
        <section aria-labelledby="awaiting-heading" className="px-2 pt-4 pb-3">
          <h2 id="awaiting-heading" className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
            Waiting for your answer
          </h2>
          <ul className="space-y-px">
            {awaiting.slice(0, 8).map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => onOpen(s)}
                  className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring/60"
                  style={colorStyle(s.color)}
                >
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-(--ev)" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.e.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{describeWhen(s.e, locale)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SourceRow({
  source: s,
  on,
  onToggle,
  onShowOnly,
  onShowAll,
  onColor,
  badge,
  extra,
}: {
  source: Source;
  on: boolean;
  onToggle: (id: SourceId, shown: boolean) => void;
  onShowOnly: (id: SourceId) => void;
  onShowAll: () => void;
  onColor: (id: SourceId, color: string) => void;
  /** Mark it public (the Nostr calendar). */
  badge?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li>
          <label className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-sm hover:bg-foreground/[0.05]">
            <input type="checkbox" checked={on} onChange={(e) => onToggle(s.id, e.target.checked)} className="peer sr-only" />
            <span
              aria-hidden
              style={colorStyle(s.color)}
              className={cn(
                'grid size-4 shrink-0 place-items-center rounded-[5px] border-2 border-(--ev) peer-focus-visible:ring-2 peer-focus-visible:ring-ring/60',
                on && 'bg-(--ev)',
              )}
            >
              {on && <Check className="size-3 text-white" strokeWidth={3} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
            {badge && (
              <span style={colorStyle(s.color)} className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--ev)_16%,transparent)] px-1.5 py-px text-[11px] font-medium text-[color-mix(in_oklab,var(--ev)_65%,var(--foreground))]">Public</span>
            )}
          </label>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => onShowOnly(s.id)}>
          <Eye /> Show Only This
        </ContextMenuItem>
        <ContextMenuItem onSelect={onShowAll}>
          <Eye /> Show All
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onToggle(s.id, !on)}>
          {on ? <EyeOff /> : <Eye />} {on ? 'Hide' : 'Show'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger className="gap-2">
            <Palette className="size-4 text-muted-foreground" /> Color
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-40">
            {COLORS.map((c) => (
              <ContextMenuItem key={c.value} onSelect={() => onColor(s.id, c.value)}>
                <span className="size-3 rounded-full" style={{ backgroundColor: c.value }} aria-hidden /> {c.name}
                {c.value === s.color && <Check className="ml-auto" aria-label="(current)" />}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {extra}
      </ContextMenuContent>
    </ContextMenu>
  );
}
