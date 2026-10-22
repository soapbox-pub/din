import { useEffect, useState } from 'react';
import { AppWindow, Lock, RotateCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getBrowserBridge, type SiteInfo } from '@/lib/browser';
import { nsiteDisplayUrl } from '@/lib/nsite';
import { getPopupsBridge } from '@/lib/popups';
import type { SiteCapability } from '@/lib/promptBridge';
import { SITE_CAPABILITIES } from '@/lib/siteCapabilities';
import { usePopupSettings } from '@/hooks/usePopups';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';

/** The origin a page's permissions are filed under (as electron/main.mts's siteOriginOf). */
function siteOriginOf(url: string): string | null {
  try {
    const { protocol, host } = new URL(url);
    return /^(https?|nsite):$/.test(protocol) && host ? `${protocol}//${host}` : null;
  } catch {
    return null;
  }
}

/** The name a site goes by in the address bar: its host, or an nsite's pretty name. */
function siteName(url: string): string {
  const display = nsiteDisplayUrl(url);
  return display.replace(/^[a-z]+:\/\//i, '').split('/')[0] || display;
}

type Security = 'secure' | 'verified' | 'exception' | 'insecure';

const SECURITY: Record<Security, { title: string; detail: string; warn: boolean }> = {
  secure: {
    title: 'Connection is secure',
    detail: 'Information you send to this site is private to it.',
    warn: false,
  },
  verified: {
    title: 'Verified site',
    detail: "Every file is checked against the site's signed manifest before it loads.",
    warn: false,
  },
  exception: {
    title: 'Not secure',
    detail: "This site's certificate isn't trusted. You chose to open it anyway.",
    warn: true,
  },
  insecure: {
    title: 'Not secure',
    detail: "Don't enter passwords or payment details here. Others on the network could see them.",
    warn: true,
  },
};

/**
 * The icon at the start of the address bar, Chrome-style: a lock for a secure
 * page, a warning for one that isn't. Clicking it shows how the connection
 * stands and what the site may do (camera, microphone, location,
 * notifications, pop-ups), each of which can be switched or forgotten.
 * Renders nothing for pages that aren't websites (the new tab page, settings).
 */
export function SiteInfoButton({
  url,
  isPrivate,
  onReload,
}: {
  url: string;
  isPrivate: boolean;
  onReload: () => void;
}) {
  const bridge = getBrowserBridge();
  const popups = getPopupsBridge();
  const popupSettings = usePopupSettings();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const [changed, setChanged] = useState(false);

  const origin = siteOriginOf(url);
  const scheme = origin?.slice(0, origin.indexOf(':'));

  useEffect(() => {
    if (!bridge || !origin) return;
    let cancelled = false;
    bridge.getSiteInfo(origin, isPrivate).then(
      (next) => {
        if (!cancelled) setInfo(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // Re-read each time it opens: a prompt may have been answered since.
  }, [bridge, origin, isPrivate, open]);

  // A different site is a different set of answers.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
    setChanged(false);
    setInfo(null);
  }, [origin]);

  if (!origin) return null;

  const security: Security =
    scheme === 'nsite'
      ? 'verified'
      : scheme === 'https'
        ? info?.certificateException
          ? 'exception'
          : 'secure'
        : 'insecure';
  const { title, detail, warn } = SECURITY[security];
  const site = siteName(url);
  const hostname = new URL(url).hostname;
  const popupsAllowed = !!popupSettings?.allowlist.includes(hostname);

  const answered = (Object.keys(SITE_CAPABILITIES) as SiteCapability[]).filter(
    (c) => info?.permissions[c] !== undefined,
  );

  const setPermission = (capability: SiteCapability, allow: boolean | null) => {
    if (!bridge) return;
    setInfo((prev) => {
      if (!prev) return prev;
      const permissions = { ...prev.permissions };
      if (allow === null) delete permissions[capability];
      else permissions[capability] = allow;
      return { ...prev, permissions };
    });
    setChanged(true);
    bridge.setSitePermission(origin, capability, allow, isPrivate).catch(() => {});
  };

  const label = `${title}. View site information`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={title}
          className={cn(
            'absolute left-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full',
            'hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            warn ? 'text-destructive' : 'text-muted-foreground hover:text-foreground',
            open && 'bg-foreground/10 text-foreground',
          )}
        >
          {warn ? (
            <TriangleAlert className="size-3.5" aria-hidden />
          ) : (
            <Lock className="size-3.5" aria-hidden />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-80 space-y-4">
        <p className="truncate text-sm font-semibold">{site}</p>

        <div className="flex items-start gap-3">
          <span
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-md',
              warn ? 'bg-destructive/15 text-destructive' : 'bg-secondary text-muted-foreground',
            )}
          >
            {warn ? (
              <TriangleAlert className="size-4" aria-hidden />
            ) : security === 'verified' ? (
              <ShieldCheck className="size-4" aria-hidden />
            ) : (
              <Lock className="size-4" aria-hidden />
            )}
          </span>
          <div className="min-w-0 space-y-0.5">
            <p className={cn('text-sm font-medium', warn && 'text-destructive')}>{title}</p>
            <p className="text-xs text-muted-foreground">{detail}</p>
          </div>
        </div>

        {bridge && (
          <div className="space-y-2 border-t border-border/60 pt-4">
            <p className="text-xs font-medium text-muted-foreground">Permissions</p>
            {answered.length === 0 && !popupsAllowed ? (
              <p className="text-xs text-muted-foreground">
                This site hasn't asked for anything. When it does, Din asks you first.
              </p>
            ) : (
              <ul className="space-y-1">
                {answered.map((capability) => {
                  const { name, icon: Icon } = SITE_CAPABILITIES[capability];
                  const allowed = info?.permissions[capability] === true;
                  const id = `site-permission-${capability}`;
                  return (
                    <li key={capability} className="flex items-center gap-3 rounded-md py-1">
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <label htmlFor={id} className="min-w-0 flex-1 space-y-0.5">
                        <span className="block text-sm">{name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {allowed ? 'Allowed' : 'Blocked'}
                        </span>
                      </label>
                      <Switch
                        id={id}
                        checked={allowed}
                        onCheckedChange={(on) => setPermission(capability, on)}
                      />
                    </li>
                  );
                })}
                {popupsAllowed && popups && (
                  <li className="flex items-center gap-3 rounded-md py-1">
                    <AppWindow className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <label htmlFor="site-permission-popups" className="min-w-0 flex-1 space-y-0.5">
                      <span className="block text-sm">Pop-ups</span>
                      <span className="block text-xs text-muted-foreground">Allowed</span>
                    </label>
                    <Switch
                      id="site-permission-popups"
                      checked
                      onCheckedChange={(on) => {
                        if (!on) popups.setSiteAllowed(hostname, false).catch(() => {});
                      }}
                    />
                  </li>
                )}
              </ul>
            )}

            {answered.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  for (const capability of answered) setPermission(capability, null);
                }}
              >
                Reset permissions
              </Button>
            )}

            {isPrivate && (
              <p className="text-xs text-muted-foreground">
                In a private window, answers are forgotten when it closes.
              </p>
            )}
          </div>
        )}

        {changed && (
          <div className="flex items-center gap-3 rounded-lg bg-secondary/60 p-3">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              Reload this page to apply your changes.
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                onReload();
                setChanged(false);
                setOpen(false);
              }}
            >
              <RotateCw className="size-3.5" aria-hidden />
              Reload
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
