import { useEffect, useState } from 'react';
import { AppWindow, Loader2, Lock, RotateCw, Trash2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { getBrowserBridge, siteOriginOf, type SiteInfo } from '@/lib/browser';
import { getPopupsBridge } from '@/lib/popups';
import { isOnionUrl } from '@/lib/tor';
import { AppIcon } from '@/components/desktop/AppIcon';
import { NsiteIcon } from '@/components/icons/NsiteIcon';
import { useSiteIdentity } from '@/hooks/useSiteIdentity';
import { OnionIcon } from '@/components/icons/OnionIcon';
import type { SiteCapability } from '@/lib/promptBridge';
import { SITE_CAPABILITIES } from '@/lib/siteCapabilities';
import { usePopupSettings } from '@/hooks/usePopups';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

/** What every website may be asked for, listed in its site info even unanswered. */
const ALWAYS_SHOWN = new Set<SiteCapability>(['camera', 'microphone', 'geolocation', 'notifications']);

/** The name a site goes by in the address bar: its host. */
function siteName(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').split('/')[0] || url;
}

type Security = 'secure' | 'verified' | 'onion' | 'exception' | 'insecure';

const SECURITY: Record<Security, { title: string; detail: string; warn: boolean }> = {
  onion: {
    title: 'Onion service',
    detail: "Tor encrypts this connection end to end, and the address is the site's own key, so no one can stand in for it.",
    warn: false,
  },
  secure: {
    title: 'Connection is secure',
    detail: 'Information you send to this site is private to it.',
    warn: false,
  },
  // An nsite's popover leads with who publishes it instead.
  verified: {
    title: 'nsite',
    detail: '',
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
 * page, a green N for an nsite, a violet onion for an onion service, and a
 * warning for a page that isn't secure. Clicking it shows how the connection
 * stands and what the site may do (camera, microphone, location,
 * notifications, pop-ups), each of which can be allowed, blocked, or left to
 * ask, whether or not the site has asked yet. Its cookies and storage can be
 * deleted from here too, as Chrome's "Delete site data".
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
  const [deleting, setDeleting] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const { toast } = useToast();

  const origin = siteOriginOf(url);
  const scheme = origin?.slice(0, origin.indexOf(':'));
  const identity = useSiteIdentity(origin ?? '');

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
      : isOnionUrl(url) && !info?.certificateException
        ? 'onion'
        : scheme === 'https'
        ? info?.certificateException
          ? 'exception'
          : 'secure'
        : 'insecure';
  const { title, detail, warn } = SECURITY[security];
  // nsites and onions wear the colors of their address-bar badges.
  const tint =
    security === 'verified'
      ? 'text-success'
      : security === 'onion'
        ? 'text-foreground'
        : null;
  // An nsite's host is a key; it goes by the name and icon its files give it.
  const site = identity.nsite ? identity.name : siteName(url);
  const hostname = new URL(url).hostname;
  const popupsAllowed = !!popupSettings?.allowlist.includes(hostname);

  const answered = (Object.keys(SITE_CAPABILITIES) as SiteCapability[]).filter(
    (c) => info?.permissions[c] !== undefined,
  );
  // Always offered, answered or not: a page that decided it was blocked
  // without asking has to be allowed from here.
  const shown = (Object.keys(SITE_CAPABILITIES) as SiteCapability[]).filter(
    (c) => ALWAYS_SHOWN.has(c) || answered.includes(c),
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

  const deleteSiteData = async () => {
    if (!bridge) return;
    setDeleting('busy');
    try {
      await bridge.clearSiteData(origin, isPrivate);
      // The page still holds what it read; it starts over without it.
      onReload();
      setChanged(false);
      setOpen(false);
      toast({ title: `Deleted ${site}'s data` });
    } catch {
      toast({ title: `Couldn't delete ${site}'s data`, variant: 'destructive' });
    } finally {
      setDeleting('idle');
    }
  };

  const label = `${title}. View site information`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDeleting('idle');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={title}
          className={cn(
            'absolute left-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full',
            'hover:bg-foreground/[0.07] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            warn ? 'text-destructive' : (tint ?? 'text-muted-foreground hover:text-foreground'),
            open && 'bg-foreground/[0.07]',
            open && !warn && !tint && 'text-foreground',
          )}
        >
          {warn ? (
            <TriangleAlert className="size-3.5" aria-hidden />
          ) : security === 'verified' ? (
            <NsiteIcon className="size-3.5" />
          ) : security === 'onion' ? (
            <OnionIcon className="size-3.5" />
          ) : (
            <Lock className="size-3.5" aria-hidden />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-80 space-y-4">
        {identity.nsite ? (
          <div className="flex items-center gap-3">
            {identity.icon ? (
              <AppIcon icon={identity.icon} className="size-8 shrink-0 rounded-md" />
            ) : (
              <span className={cn('grid size-8 shrink-0 place-items-center rounded-full bg-foreground/10 clay', tint)}>
                <NsiteIcon className="size-4" />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{site}</p>
              {identity.publisher && (
                <p className="truncate text-xs text-muted-foreground">by {identity.publisher}</p>
              )}
            </div>
          </div>
        ) : (
          <p className="truncate text-sm font-semibold">{site}</p>
        )}

        {security !== 'verified' && (
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'grid size-8 shrink-0 place-items-center rounded-full clay',
                warn ? 'bg-destructive/15 text-destructive' : cn('bg-foreground/10', tint ?? 'text-muted-foreground'),
              )}
            >
              {warn ? (
                <TriangleAlert className="size-4" aria-hidden />
              ) : security === 'onion' ? (
                <OnionIcon className="size-4" />
              ) : (
                <Lock className="size-4" aria-hidden />
              )}
            </span>
            <div className="min-w-0 space-y-0.5">
              <p className={cn('text-sm font-medium', warn && 'text-destructive')}>{title}</p>
              <p className="text-xs text-muted-foreground">{detail}</p>
            </div>
          </div>
        )}

        {bridge && (
          <div className="space-y-2 border-t border-border/60 pt-4">
            <p className="text-xs font-medium text-muted-foreground">Permissions</p>
            <ul className="space-y-1">
              {shown.map((capability) => {
                const { name, icon: Icon } = SITE_CAPABILITIES[capability];
                const answer = info?.permissions[capability];
                const value = answer === undefined ? 'ask' : answer ? 'allow' : 'block';
                const id = `site-permission-${capability}`;
                return (
                  <li key={capability} className="flex items-center gap-3 rounded-md py-1">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <label htmlFor={id} className="min-w-0 flex-1 text-sm">
                      {name}
                    </label>
                    <Select
                      value={value}
                      onValueChange={(next) => setPermission(capability, next === 'ask' ? null : next === 'allow')}
                    >
                      <SelectTrigger id={id} size="sm" className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ask">Ask</SelectItem>
                        <SelectItem value="allow">Allow</SelectItem>
                        <SelectItem value="block">Block</SelectItem>
                      </SelectContent>
                    </Select>
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

        {bridge && (
          <div className="space-y-2 border-t border-border/60 pt-4">
            <p className="text-xs font-medium text-muted-foreground">Cookies and site data</p>
            {deleting === 'idle' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setDeleting('confirm')}
              >
                <Trash2 className="size-4.5" strokeWidth={1.75} aria-hidden />
                Delete site data
              </Button>
            ) : (
              <div role="alertdialog" aria-labelledby="site-data-confirm" className="space-y-3 rounded-xl bg-destructive/10 p-3">
                <p id="site-data-confirm" className="text-xs">
                  This signs you out of {site} and deletes everything it saved on this computer. It can't be undone.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={deleting === 'busy'}
                    onClick={() => setDeleting('idle')}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    autoFocus
                    disabled={deleting === 'busy'}
                    onClick={() => void deleteSiteData()}
                  >
                    {deleting === 'busy' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                    Delete
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {changed && (
          <div className="flex items-center gap-3 rounded-xl bg-selected p-3">
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
              <RotateCw className="size-4.5" strokeWidth={1.75} aria-hidden />
              Reload
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
