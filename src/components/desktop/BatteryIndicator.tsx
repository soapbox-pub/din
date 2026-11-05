import { useId } from 'react';
import { Plug, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PopoverClose } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { trayFooter, trayFooterButton, trayList, trayRuleBottom, trayTitle } from './trayPanel';
import {
  formatTimeRemaining,
  summarizePower,
  type BatteryInfo,
} from '@/lib/power';
import { useBatteryStatus } from '@/hooks/usePower';
import { useWindowActions } from '@/contexts/WindowManagerContext';

/** Bolt overlaid on the battery while charging, macOS style. */
const BOLT_PATH = 'M13.1 1.9 L8.7 8.2 h2.8 l-1.5 4.4 l4.6 -6.4 h-2.8 Z';

/**
 * Battery glyph, macOS style: an outlined body with a solid fill that scales
 * with the charge, and a bolt overlaid (knocked out of the body behind it)
 * while charging. Shared by the menu-bar item and Settings panel.
 */
export function BatteryGlyph({
  percent,
  charging,
  className,
}: {
  percent: number | null;
  charging: boolean;
  className?: string;
}) {
  const maskId = useId();
  const level = percent === null ? null : Math.min(100, Math.max(0, percent));
  // Interior runs x=2.5..20.5; keep a sliver visible even at 1%.
  const fillWidth = level === null || level === 0 ? 0 : Math.max(18 * (level / 100), 2);

  return (
    <svg viewBox="0 0 26 16" fill="none" className={className} aria-hidden>
      {charging && (
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect width="26" height="16" fill="white" />
          <path
            d={BOLT_PATH}
            fill="black"
            stroke="black"
            strokeWidth="1.5"
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
      {charging && <path d={BOLT_PATH} fill="currentColor" />}
    </svg>
  );
}

/** True when the battery is low enough to warn about (and not charging). */
function isCritical(percent: number | null, charging: boolean): boolean {
  return !charging && percent !== null && percent <= 15;
}

/** One line of secondary text describing charge/AC state. */
function statusLine(
  status: ReturnType<typeof summarizePower>,
  acConnected: boolean,
): string {
  if (!status) return '';
  if (status.status === 'full' || status.percent === 100) {
    return acConnected ? 'Fully charged' : 'Full';
  }
  if (status.charging) {
    return status.secondsRemaining !== null
      ? `${formatTimeRemaining(status.secondsRemaining)} until full`
      : 'Charging';
  }
  if (status.secondsRemaining !== null) {
    return `${formatTimeRemaining(status.secondsRemaining)} remaining`;
  }
  return acConnected ? 'Plugged in' : 'On battery';
}

/** Popover content: big charge readout, per-battery breakdown, settings link. */
export function BatteryPopoverBody() {
  const status = useBatteryStatus();
  const { open } = useWindowActions();

  const data = status.data;
  const summary = data ? summarizePower(data) : null;
  const critical = summary ? isCritical(summary.percent, summary.charging) : false;

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
              charging={summary.charging}
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
                {statusLine(summary, data?.acConnected ?? false)}
              </p>
            </div>
            {data?.acConnected && (
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
            <BatteryRow key={battery.name} battery={battery} />
          ))}
        </ul>
      )}

      {data && data.devices.length > 0 && (
        <ul className={trayList} aria-label="Devices">
          {data.devices.map((battery) => (
            <BatteryRow key={battery.name} battery={battery} />
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
function BatteryRow({ battery }: { battery: BatteryInfo }) {
  const charging = battery.status === 'charging';
  return (
    <li className="flex items-center gap-3 rounded-lg px-2.5 py-2">
      <BatteryGlyph
        percent={battery.percent}
        charging={charging}
        className={cn(
          'size-4.5 shrink-0',
          isCritical(battery.percent, charging) ? 'text-destructive' : 'text-muted-foreground',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{battery.label}</span>
      <span className="text-sm tabular-nums text-muted-foreground">
        {battery.percent !== null ? `${battery.percent}%` : '—'}
      </span>
    </li>
  );
}
