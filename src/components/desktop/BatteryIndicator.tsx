import {
  Battery,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Plug,
  Settings2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PopoverClose } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  formatTimeRemaining,
  summarizePower,
  type BatteryInfo,
} from '@/lib/power';
import { useBatteryStatus } from '@/hooks/usePower';
import { useWindowActions } from '@/contexts/WindowManagerContext';

/**
 * Battery glyph: a charging bolt when plugged in, otherwise a fill level that
 * steps down with the charge. Shared by the menu-bar item and Settings panel.
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
  let Icon: LucideIcon;
  if (charging) Icon = BatteryCharging;
  else if (percent === null) Icon = Battery;
  else if (percent >= 90) Icon = BatteryFull;
  else if (percent >= 55) Icon = BatteryMedium;
  else if (percent >= 20) Icon = BatteryLow;
  else Icon = BatteryWarning;
  return <Icon className={className} aria-hidden />;
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
      <header className="flex items-center gap-3 border-b border-border/60 px-3 py-3">
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
              <p className="text-sm font-medium text-foreground">
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
        <ul className="flex flex-col gap-1 p-1.5" aria-label="Batteries">
          {data.batteries.map((battery) => (
            <BatteryRow key={battery.name} battery={battery} />
          ))}
        </ul>
      )}

      <footer className="border-t border-border/60 p-1.5">
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground hover:text-foreground"
            onClick={() => open('settings')}
          >
            <Settings2 aria-hidden />
            Battery settings
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}

/** Compact per-battery row for multi-battery machines. */
function BatteryRow({ battery }: { battery: BatteryInfo }) {
  const charging = battery.status === 'charging';
  return (
    <li className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
      <BatteryGlyph
        percent={battery.percent}
        charging={charging}
        className="size-4.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{battery.name}</span>
      <span className="text-sm tabular-nums text-muted-foreground">
        {battery.percent !== null ? `${battery.percent}%` : '—'}
      </span>
    </li>
  );
}
