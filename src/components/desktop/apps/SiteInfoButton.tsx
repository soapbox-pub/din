import { useEffect, useState, type ReactNode } from 'react';
import {
  AppWindow,
  Check,
  ChevronLeft,
  ChevronRight,
  Cookie,
  Hourglass,
  KeyRound,
  ListChecks,
  Loader2,
  Lock,
  RotateCw,
  Shield,
  Settings2,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { getBrowserBridge, siteOriginOf, type SiteInfo } from '@/lib/browser';
import { getPopupsBridge } from '@/lib/popups';
import { getAdblockBridge } from '@/lib/adblock';
import { isOnionUrl } from '@/lib/tor';
import { AppIcon } from '@/components/desktop/AppIcon';
import { NsiteIcon } from '@/components/icons/NsiteIcon';
import { useSiteIdentity } from '@/hooks/useSiteIdentity';
import { OnionIcon } from '@/components/icons/OnionIcon';
import type { SiteCapability } from '@/lib/promptBridge';
import { SITE_CAPABILITIES } from '@/lib/siteCapabilities';
import { usePopupSettings } from '@/hooks/usePopups';
import { useAdblockSettings, useBlockedCount } from '@/hooks/useAdblock';
import {
  choiceOf,
  describeChoice,
  getSiteLimitsBridge,
  LIMIT_CHOICES,
  limitOfChoice,
  spentToday,
  type SiteLimit,
  type SiteLimitStatus,
} from '@/lib/siteLimits';
import { SignerSitePanel } from '@/components/desktop/apps/SignerSitePanel';
import { useSignerSite } from '@/hooks/useSignerSite';
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

/** The host the ad blocker can be switched off for, or null. */
function adblockHostOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    return /^(https?|nsite):$/.test(protocol) && hostname ? hostname : null;
  } catch {
    return null;
  }
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

type Page = 'main' | 'security' | 'permissions' | 'limit' | 'nostr' | 'data';

const PAGE_TITLES: Record<Exclude<Page, 'main'>, string> = {
  security: 'Connection',
  permissions: 'Permissions',
  limit: 'Limit this site',
  nostr: 'Nostr account',
  data: 'Cookies and site data',
};

/** A limit in a row's few words. */
function shortLimit(limit: SiteLimit | null): string {
  if (!limit) return 'None';
  if (limit.mode === 'pause') return 'Pause first';
  if (limit.mode === 'block') return 'Blocked';
  return limit.minutes < 60 ? `${limit.minutes} min a day` : `${limit.minutes / 60} hr a day`;
}

const rowClass =
  'flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60';

/** A row of the summary that opens a page of its own: its icon, name, how it stands, and a chevron. */
function NavRow({
  icon,
  label,
  value,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  tone?: 'warn';
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={rowClass}>
      <span className={cn('shrink-0', tone === 'warn' ? 'text-destructive' : 'text-muted-foreground')}>{icon}</span>
      <span className={cn('min-w-0 shrink-0 text-sm', tone === 'warn' && 'text-destructive')}>{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{value}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4.5" strokeWidth={1.75} aria-hidden />;
}

/**
 * The button at the start of the address bar, and everything Din does for
 * the site it's on, as Chrome's site controls: how the connection stands, its
 * ad blocking, a limit on the user's time there (electron/site-limits.mts),
 * its connection to the user's Nostr account, what it may do (camera,
 * microphone, location, notifications, pop-ups, each allowed, blocked or left
 * to ask, answered or not), and its cookies and storage. The popover opens on
 * a summary, a row for each, and each opens a page of its own in place.
 *
 * Two sliders (Chrome's tune) for a secure page, the nsite's N or an onion for those, and a
 * warning for a page that isn't secure. Renders nothing for pages that aren't
 * websites (the new tab page, settings).
 */
export function SiteInfoButton({
  url,
  wcId,
  isPrivate,
  onReload,
}: {
  url: string;
  /** The tab's guest, for what the ad blocker blocked there; null before it attaches. */
  wcId: number | null;
  isPrivate: boolean;
  onReload: () => void;
}) {
  const bridge = getBrowserBridge();
  const popups = getPopupsBridge();
  const adblock = getAdblockBridge();
  const siteLimits = getSiteLimitsBridge();
  const popupSettings = usePopupSettings();
  const adblockSettings = useAdblockSettings();
  const blockedCount = useBlockedCount(wcId);
  const signerSite = useSignerSite(url);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>('main');
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const [changed, setChanged] = useState(false);
  const [deleting, setDeleting] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [limit, setLimit] = useState<SiteLimitStatus | null>(null);
  const { toast } = useToast();

  const origin = siteOriginOf(url);
  const scheme = origin?.slice(0, origin.indexOf(':'));
  const identity = useSiteIdentity(origin ?? '');
  // Private tabs have no window.nostr.
  const signer = isPrivate ? null : signerSite;

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

  // Its limit, if the user limited it, and its time today: websites only.
  const limitHost = scheme === 'http' || scheme === 'https' ? new URL(origin ?? '').hostname : null;
  useEffect(() => {
    if (!siteLimits || !limitHost || !open) return;
    let cancelled = false;
    siteLimits.status(limitHost).then(
      (next) => {
        if (!cancelled) setLimit(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [siteLimits, limitHost, open]);

  // A different site is a different set of answers.
  useEffect(() => {
    setOpen(false);
    setChanged(false);
    setInfo(null);
    setLimit(null);
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
  // nsites and onions wear colors of their own.
  const tint = security === 'verified' ? 'text-success' : security === 'onion' ? 'text-foreground' : null;
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
  const allowed = answered.filter((c) => info?.permissions[c]);
  const refused = answered.filter((c) => info?.permissions[c] === false);
  // Short enough for its row: "Camera allowed", "2 allowed, 1 blocked", "Ask first".
  const permissionSummary =
    allowed.length === 1 && refused.length === 0
      ? `${SITE_CAPABILITIES[allowed[0]].name} allowed`
      : [allowed.length ? `${allowed.length} allowed` : '', refused.length ? `${refused.length} blocked` : '']
        .filter(Boolean)
        .join(', ') || 'Ask first';

  const adHost = adblockHostOf(url);
  const adsAllowed = !!adHost && !!adblockSettings?.allowlist.includes(adHost);
  const adsBlocking = !!adblockSettings?.enabled && !!adHost && !adsAllowed;

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

  const setAdsBlocked = (on: boolean) => {
    if (!adblock || !adHost) return;
    // Turning it on here, with it off everywhere, turns it on everywhere.
    const change = !adblockSettings?.enabled && on
      ? adblock.setSiteAllowed(adHost, false).then(() => adblock.setEnabled(true))
      : adblock.setSiteAllowed(adHost, !on);
    // What's already loaded (or already blocked) stays that way until it reloads.
    change.then(onReload).catch(() => {});
  };

  const setSiteLimit = (choice: string) => {
    if (!siteLimits || !limitHost) return;
    const next = limitOfChoice(choice);
    setLimit((prev) => (prev ? { ...prev, limit: next ? { site: prev.site, minutes: 30, ...next } : null } : prev));
    siteLimits
      .set(limitHost, next)
      .then(() => siteLimits.status(limitHost))
      .then(setLimit)
      .catch(() => toast({ title: "Couldn't change this site's limit", variant: 'destructive' }));
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

  const securityIcon = warn ? (
    <TriangleAlert className="size-4.5" strokeWidth={1.75} aria-hidden />
  ) : security === 'onion' ? (
    <OnionIcon className="size-4.5" />
  ) : (
    <Lock className="size-4.5" strokeWidth={1.75} aria-hidden />
  );

  const limitChoice = choiceOf(limit?.limit ?? null);
  const limitChoices = LIMIT_CHOICES.includes(limitChoice) ? LIMIT_CHOICES : [...LIMIT_CHOICES, limitChoice];

  const mainPage = (
    <div className="space-y-3">
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
            {identity.publisher && <p className="truncate text-xs text-muted-foreground">by {identity.publisher}</p>}
          </div>
        </div>
      ) : (
        <p className="truncate px-0.5 text-sm font-semibold">{site}</p>
      )}

      <div className="-mx-2 space-y-0.5">
        {security !== 'verified' && (
          <NavRow
            icon={securityIcon}
            label={title}
            tone={warn ? 'warn' : undefined}
            onClick={() => setPage('security')}
          />
        )}

        {adblock && adblockSettings && adHost && (
          <div className="flex h-9 items-center gap-3 rounded-lg px-2">
            <Shield className="size-4.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
            <label htmlFor="site-adblock" className="min-w-0 shrink-0 text-sm">
              Block ads
            </label>
            <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground tabular-nums">
              {!adblockSettings.enabled
                ? 'Off everywhere'
                : adsAllowed
                  ? 'Off here'
                  : `${blockedCount} blocked`}
            </span>
            <Switch id="site-adblock" checked={adsBlocking} onCheckedChange={setAdsBlocked} />
          </div>
        )}

        {siteLimits && limitHost && (
          <NavRow
            icon={<RowIcon icon={Hourglass} />}
            label="Limit this site"
            value={limit ? shortLimit(limit.limit) : undefined}
            onClick={() => setPage('limit')}
          />
        )}

        {signer && (
          <NavRow
            icon={<RowIcon icon={KeyRound} />}
            label="Nostr account"
            value={signer.blocked ? 'Blocked' : 'Connected'}
            onClick={() => setPage('nostr')}
          />
        )}

        {bridge && (
          <NavRow
            icon={<RowIcon icon={ListChecks} />}
            label="Permissions"
            value={info ? permissionSummary : undefined}
            onClick={() => setPage('permissions')}
          />
        )}

        {bridge && (
          <NavRow icon={<RowIcon icon={Cookie} />} label="Cookies and site data" onClick={() => setPage('data')} />
        )}
      </div>
    </div>
  );

  const securityPage = (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-full clay',
          warn ? 'bg-destructive/15 text-destructive' : cn('bg-foreground/10', tint ?? 'text-muted-foreground'),
        )}
      >
        {securityIcon}
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className={cn('text-sm font-medium', warn && 'text-destructive')}>{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );

  const permissionsPage = (
    <div className="space-y-3">
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
        <p className="text-xs text-muted-foreground">In a private window, answers are forgotten when it closes.</p>
      )}
    </div>
  );

  const limitPage = (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {limit
          ? `${spentToday(limit.seconds)} on ${limit.site}${
            limit.attempts ? `, ${limit.attempts} ${limit.attempts === 1 ? 'try' : 'tries'}` : ''
          }.`
          : ' '}
      </p>
      <div role="radiogroup" aria-label="Limit this site" className="-mx-2 space-y-0.5">
        {limitChoices.map((choice) => {
          const chosen = choice === limitChoice;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={chosen}
              disabled={!limit}
              onClick={() => setSiteLimit(choice)}
              className={cn(rowClass, 'disabled:opacity-50', chosen && 'bg-selected hover:bg-selected')}
            >
              <span className="min-w-0 flex-1 truncate text-sm">{describeChoice(choice)}</span>
              {chosen && <Check className="size-4 shrink-0 text-ink-accent" aria-hidden />}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Covers {limit?.site ?? 'the site'} and its subdomains, in every window and installed app.
      </p>
    </div>
  );

  const dataPage =
    deleting === 'idle' ? (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Its cookies, and everything it saved on this computer.</p>
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setDeleting('confirm')}>
          <Trash2 className="size-4.5" strokeWidth={1.75} aria-hidden />
          Delete site data
        </Button>
      </div>
    ) : (
      <div role="alertdialog" aria-labelledby="site-data-confirm" className="space-y-3 rounded-xl bg-destructive/10 p-3">
        <p id="site-data-confirm" className="text-xs">
          This signs you out of {site} and deletes everything it saved on this computer. It can't be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={deleting === 'busy'} onClick={() => setDeleting('idle')}>
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
    );

  const body =
    page === 'security'
      ? securityPage
      : page === 'permissions'
        ? permissionsPage
        : page === 'limit'
          ? limitPage
          : page === 'nostr' && signer
            ? <SignerSitePanel signer={signer} onDone={() => setOpen(false)} />
            : page === 'data'
              ? dataPage
              : mainPage;

  const label = `${title}. View site information and controls`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPage('main');
        else setDeleting('idle');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={warn ? title : 'Site information and controls'}
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
            <Settings2 className="size-4" strokeWidth={1.75} aria-hidden />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-80 space-y-3">
        {page !== 'main' && (
          <div className="-mt-1 -ml-2 flex items-center gap-1">
            <button
              type="button"
              aria-label="Back"
              autoFocus
              onClick={() => {
                setPage('main');
                setDeleting('idle');
              }}
              className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <ChevronLeft className="size-4.5" strokeWidth={1.75} aria-hidden />
            </button>
            <p className="min-w-0 truncate text-sm font-semibold">{PAGE_TITLES[page]}</p>
          </div>
        )}

        {body}

        {changed && (
          <div className="flex items-center gap-3 rounded-xl bg-selected p-3">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">Reload this page to apply your changes.</p>
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
