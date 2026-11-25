import { useId } from 'react';
import { Plug, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PopoverClose } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { trayFooter, trayFooterButton, trayList, trayRuleBottom, trayTitle } from './trayPanel';
import {
  chargeMark,
  describePower,
  isBatteryCritical,
  summarizePower,
  type BatteryInfo,
  type ChargeMark,
} from '@/lib/power';
import { useBatteryStatus, useChargeLimit } from '@/hooks/usePower';
import { useWindowActions } from '@/contexts/WindowManagerContext';

/** Bolt overlaid on the battery while plugged in, macOS style. */
const BOLT_PATH = 'M13.1 1.9 L8.7 8.2 h2.8 l-1.5 4.4 l4.6 -6.4 h-2.8 Z';

/**
 * Battery glyph, macOS style: an outlined body with a solid fill that scales
 * with the charge, and a bolt overlaid (knocked out of the body behind it)
 * while a charger's plugged in, only its outline for a slow one. Shared by
 * the menu-bar item and Settings panel.
 */
export function BatteryGlyph({
  percent,
  mark,
  className,
}: {
  percent: number | null;
  /** The bolt over it: `chargeMark()` for the computer's, charging or not for a device's. */
  mark: ChargeMark;
  className?: string;
}) {
  const maskId = useId();
  const level = percent === null ? null : Math.min(100, Math.max(0, percent));
  // Interior runs x=2.5..20.5; keep a sliver visible even at 1%.
  const fillWidth = level === null || level === 0 ? 0 : Math.max(18 * (level / 100), 2);
  const charging = mark !== null;

  return (
    <svg viewBox="0 0 26 16" fill="none" className={className} aria-hidden>
      {charging && (
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect width="26" height="16" fill="white" />
          <path
            d={BOLT_PATH}
            fill="black"
            stroke="black"
            strokeWidth={mark === 'slow' ? 3 : 1.5}
            strokeLinejoin="round"
          />
        </mask>
      )}
      <g mask={charging ? `url(#${maskId})` : undefined}>
        <rect
          x="1"
          y="2.5"
          width="21"
          height="11"
          rx="3"
          stroke="currentColor"
          className="opacity-40"
        />
        <rect
          x="23"
          y="6"
          width="2.25"
          height="4"
          rx="1.125"
          fill="currentColor"
          className="opacity-40"
        />
        {fillWidth > 0 && (
          <rect x="2.5" y="4" width={fillWidth} height="8" rx="1.75" fill="currentColor" />
        )}
      </g>
      {mark === 'charging' && <path d={BOLT_PATH} fill="currentColor" />}
      {mark === 'slow' && (
        <path d={BOLT_PATH} stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** True when a device's battery is low enough to show in red (and not charging). */
function isCritical(percent: number | null, charging: boolean): boolean {
  return !charging && percent !== null && percent <= 15;
}

/** Popover content: big charge readout, per-battery breakdown, settings link. */
export function BatteryPopoverBody() {
  const status = useBatteryStatus();
  const limit = useChargeLimit();
  const { open } = useWindowActions();

  const data = status.data;
  const summary = data ? summarizePower(data) : null;
  const critical = isBatteryCritical(summary);
  const mark = chargeMark(summary);

  return (
    <div className="flex flex-col">
      <header className={cn(trayRuleBottom, 'flex items-center gap-3 px-4 pt-4 pb-3')}>
        {status.isLoading || !summary ? (
          <>
            <Skeleton className="size-6 rounded bg-foreground/10" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-16 bg-foreground/10" />
              <Skeleton className="h-3 w-24 bg-foreground/10" />
            </div>
          </>
        ) : (
          <>
            <BatteryGlyph
              percent={summary.percent}
              mark={mark}
              className={cn(
                'size-6 shrink-0',
                critical ? 'text-destructive' : 'text-foreground',
              )}
            />
            <div className="min-w-0">
              <p className={trayTitle}>
                {summary.percent !== null ? `${summary.percent}%` : 'Battery'}
              </p>
              <p
                className={cn(
                  'text-xs',
                  critical ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {describePower(summary, limit.data)}
              </p>
            </div>
            {summary.pluggedIn && (
              <Plug className="ml-auto size-4 shrink-0 text-muted-foreground" aria-label="Plugged in" />
            )}
          </>
        )}
      </header>

      {/* Per-battery breakdown, only when there's more than one pack. */}
      {data && data.batteries.length > 1 && (
        <ul
          className={cn(trayList, data.devices.length > 0 && trayRuleBottom)}
          aria-label="Batteries"
        >
          {data.batteries.map((battery) => (
            <BatteryRow key={battery.name} battery={battery} mark={mark} />
          ))}
        </ul>
      )}

      {data && data.devices.length > 0 && (
        <ul className={trayList} aria-label="Devices">
          {data.devices.map((battery) => (
            <BatteryRow
              key={battery.name}
              battery={battery}
              mark={battery.status === 'charging' ? 'charging' : null}
            />
          ))}
        </ul>
      )}

      <footer className={trayFooter}>
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className={trayFooterButton}
            onClick={() => open('settings', { section: 'power' })}
          >
            <Settings2 aria-hidden />
            Battery settings
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}

/** Compact row for one battery: a pack of a multi-battery machine, or a device's. */
function BatteryRow({ battery, mark }: { battery: BatteryInfo; mark: ChargeMark }) {
  return (
    <li className="flex items-center gap-3 rounded-lg px-2.5 py-2">
      <BatteryGlyph
        percent={battery.percent}
        mark={mark}
        className={cn(
          'size-4.5 shrink-0',
          isCritical(battery.percent, mark !== null) ? 'text-destructive' : 'text-muted-foreground',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{battery.label}</span>
      <span className="text-sm tabular-nums text-muted-foreground">
        {battery.percent !== null ? `${battery.percent}%` : '—'}
      </span>
    </li>
  );
}
