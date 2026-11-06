import { useState } from 'react';
import { AppWindow, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toolButtonClass } from '@/shared/appChromeStyles';
import { getPopupsBridge } from '@/lib/popups';
import { useBlockedPopups, usePopupSettings } from '@/hooks/usePopups';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';

/** The hostname pop-ups can be allowed for, or null for other pages. */
function siteOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    return /^(https?|nsite):$/.test(protocol) && hostname ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Shown in the toolbar once the page tried to open a window without a click,
 * Chrome-style: the blocked windows, each one opening on demand, and a switch
 * to let the site open them from now on. Renders nothing otherwise.
 */
export function PopupBlockedButton({
  wcId,
  url,
  onOpen,
}: {
  /** The active tab's guest, or null before it attaches. */
  wcId: number | null;
  url: string;
  /** Open a blocked window's URL in a new tab. */
  onOpen: (url: string) => void;
}) {
  const bridge = getPopupsBridge();
  const settings = usePopupSettings();
  const blocked = useBlockedPopups(wcId);
  const [open, setOpen] = useState(false);

  if (!bridge || !settings || blocked.length === 0) return null;
  const site = siteOf(url);
  const allowed = !!site && settings.allowlist.includes(site);
  const label = blocked.length === 1 ? 'Pop-up blocked' : `${blocked.length} pop-ups blocked`;

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
            open && 'bg-foreground/10 text-foreground',
          )}
        >
          <AppWindow className="size-4.5" strokeWidth={1.75} aria-hidden />
          <span
            aria-hidden
            className="absolute right-1 top-1 size-2 rounded-full bg-destructive"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 space-y-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold">{label}</p>
          <p className="text-xs text-muted-foreground">
            This page tried to open {blocked.length === 1 ? 'a window' : 'windows'} without a click.
          </p>
        </div>

        <ul className="space-y-1">
          {blocked.map((popup) => (
            <li key={popup}>
              <button
                type="button"
                onClick={() => {
                  onOpen(popup);
                  setOpen(false);
                }}
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm',
                  'hover:bg-foreground/5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                )}
              >
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate">{popup}</span>
              </button>
            </li>
          ))}
        </ul>

        {site && (
          <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-4">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="popups-site" className="text-sm">
                Always allow pop-ups
              </Label>
              <p className="truncate text-xs text-muted-foreground">{site}</p>
            </div>
            <Switch
              id="popups-site"
              checked={allowed}
              onCheckedChange={(on) => {
                bridge.setSiteAllowed(site, on).catch(() => {});
              }}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
