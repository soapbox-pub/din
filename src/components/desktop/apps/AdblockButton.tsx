import { useState } from 'react';
import { Shield, ShieldCheck, ShieldOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toolButtonClass } from '@/shared/appChromeStyles';
import { getAdblockBridge } from '@/lib/adblock';
import { useAdblockSettings, useBlockedCount } from '@/hooks/useAdblock';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';

/** The hostname blocking can be switched off for, or null for other pages. */
function siteOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    return /^(https?|nsite):$/.test(protocol) && hostname ? hostname : null;
  } catch {
    return null;
  }
}

/** Compact count for the toolbar badge. */
function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * The ad blocker's toolbar button: a shield with the page's blocked count,
 * opening a popover to turn blocking off for the site. Changing that reloads
 * the page, since what's already loaded (or already blocked) stays that way.
 * Renders nothing outside the Electron shell.
 */
export function AdblockButton({
  wcId,
  url,
  onReload,
}: {
  /** The active tab's guest, or null before it attaches. */
  wcId: number | null;
  url: string;
  onReload: () => void;
}) {
  const bridge = getAdblockBridge();
  const settings = useAdblockSettings();
  const count = useBlockedCount(wcId);
  const [open, setOpen] = useState(false);

  if (!bridge || !settings) return null;
  const site = siteOf(url);
  const allowed = !!site && settings.allowlist.includes(site);
  const blocking = settings.enabled && !!site && !allowed;
  const Icon = !settings.enabled || allowed ? ShieldOff : blocking ? ShieldCheck : Shield;

  const setSiteBlocking = (on: boolean) => {
    if (!site) return;
    bridge.setSiteAllowed(site, !on).then(onReload).catch(() => {});
  };

  const label = blocking
    ? `Ad blocker: ${count} blocked on this page`
    : 'Ad blocker: off for this page';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            toolButtonClass,
            'relative',
            blocking ? 'text-foreground/80' : 'text-foreground/50',
            open && 'bg-foreground/10 text-foreground',
          )}
        >
          <Icon className="size-4.5" strokeWidth={1.75} aria-hidden />
          {blocking && count > 0 && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-pigment clay-pigment px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground"
            >
              {badgeText(count)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-72 space-y-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'grid size-10 shrink-0 place-items-center rounded-full',
              blocking ? 'bg-pigment text-primary-foreground clay-pigment' : 'bg-foreground/10 text-foreground/75 clay',
            )}
          >
            <Icon className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-2xl font-semibold leading-tight tabular-nums">
              {blocking ? count : '–'}
            </p>
            <p className="text-xs text-muted-foreground">
              {blocking
                ? `${count === 1 ? 'ad or tracker' : 'ads and trackers'} blocked on this page`
                : 'Nothing is blocked on this page'}
            </p>
          </div>
        </div>

        {!settings.enabled ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The ad blocker is turned off for every site.
            </p>
            <Button
              className="w-full"
              onClick={() => {
                bridge.setEnabled(true).then(onReload).catch(() => {});
              }}
            >
              Turn on ad blocker
            </Button>
          </div>
        ) : site ? (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="adblock-site" className="text-sm">
                Block ads on this site
              </Label>
              <p className="truncate text-xs text-muted-foreground">{site}</p>
            </div>
            <Switch id="adblock-site" checked={!allowed} onCheckedChange={setSiteBlocking} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            The ad blocker works on websites. Open one to manage it here.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
