import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Globe, RotateCcw } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useNsitePublisher } from '@/hooks/useSiteIdentity';
import { getBrowserBridge } from '@/lib/browser';
import { canonicalHostOfUrl } from '@/lib/nsiteApps';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsSubHeading } from '@/shared/settingsSection';
import { SettingsToken } from '@/shared/settingsChrome';

interface Site {
  origin: string;
  allow: boolean;
}

const QUERY_KEY = ['site-permissions', 'notifications'];

/**
 * The apps and sites that have asked to show notifications - installed
 * nsites (window.napp and their service workers) and web pages in tabs and
 * web apps - each switched on or off, or forgotten so it asks again. Turning
 * an nsite's off also ends the Nostr subscriptions it keeps while closed
 * (electron/napp.mts). The same answers are behind the site info in the
 * Web Browser and an nsite's title bar. Nothing outside the Electron shell.
 */
export function NotificationSitesList() {
  const browser = getBrowserBridge();
  const queryClient = useQueryClient();

  const { data: sites, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => browser!.listSitePermissions('notifications'),
    enabled: !!browser,
  });

  useEffect(
    () => browser?.onSitePermissionsChanged(() => void queryClient.invalidateQueries({ queryKey: QUERY_KEY })),
    [browser, queryClient],
  );

  if (!browser) return null;

  const set = (origin: string, allow: boolean | null) => {
    queryClient.setQueryData<Site[]>(QUERY_KEY, (prev) =>
      allow === null
        ? prev?.filter((s) => s.origin !== origin)
        : prev?.map((s) => (s.origin === origin ? { ...s, allow } : s)),
    );
    void browser.setSitePermission(origin, 'notifications', allow, false).catch(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    });
  };

  return (
    <div>
      <SettingsSubHeading>Apps and sites</SettingsSubHeading>
      <p className="mb-3 px-1 text-xs text-muted-foreground">
        Installed nsites and websites that asked to show notifications. Forget one to have it ask again.
      </p>
      {isLoading ? (
        <div className={settingsGroup} aria-hidden>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-8 shrink-0 rounded-md" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </div>
      ) : !sites || sites.length === 0 ? (
        <div className="px-8 py-8 text-center">
          <Bell className="mx-auto mb-3 size-6 text-muted-foreground/80" aria-hidden />
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            No app or site has asked to show notifications yet.
          </p>
        </div>
      ) : (
        <SiteRows sites={sites} onSet={set} />
      )}
    </div>
  );
}

function SiteRows({
  sites,
  onSet,
}: {
  sites: Site[];
  onSet: (origin: string, allow: boolean | null) => void;
}) {
  const { findAppIdForUrl, getApp } = useInstalledApps();
  const rows = sites
    .map((site) => {
      const appId = findAppIdForUrl(`${site.origin}/`);
      const app = appId ? getApp(appId) : undefined;
      return { ...site, app, name: app?.name ?? siteName(site.origin) };
    })
    .sort((a, b) => Number(b.allow) - Number(a.allow) || a.name.localeCompare(b.name));

  return (
    <ul className={settingsGroup}>
      {rows.map(({ origin, allow, app, name }) => (
        <SiteRow key={origin} origin={origin} allow={allow} app={app} name={name} onSet={onSet} />
      ))}
    </ul>
  );
}

function SiteRow({
  origin,
  allow,
  app,
  name,
  onSet,
}: {
  origin: string;
  allow: boolean;
  app: ReturnType<ReturnType<typeof useInstalledApps>['getApp']>;
  name: string;
  onSet: (origin: string, allow: boolean | null) => void;
}) {
  const { open } = useWindowActions();
  const nsiteHost = canonicalHostOfUrl(`${origin}/`);
  const publisher = useNsitePublisher(nsiteHost);
  // An nsite's host is a key nobody can read; it goes by who publishes it.
  const detail = nsiteHost ? publisher && `by ${publisher}` : originLabel(origin);
  const id = `notif-site-${origin}`;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="flex items-center gap-3 px-4 py-3">
          {app ? (
            <AppIcon icon={app.icon} className="size-8 shrink-0 rounded-md" />
          ) : (
            <SettingsToken icon={Globe} />
          )}
          <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
            <span className="block truncate text-sm">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {allow ? 'Allowed' : 'Blocked'}
              {detail && ` · ${detail}`}
            </span>
          </label>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`Forget ${name}`}
            title="Forget (asks again next time)"
            onClick={() => onSet(origin, null)}
          >
            <RotateCcw className="size-4.5" strokeWidth={1.75} aria-hidden />
          </Button>
          <Switch id={id} checked={allow} onCheckedChange={(on) => onSet(origin, on)} />
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {app && <ContextMenuItem onSelect={() => open(app.id)}>Open {name}</ContextMenuItem>}
        {allow ? (
          <ContextMenuItem onSelect={() => onSet(origin, false)}>
            <BellOff />
            Turn off notifications
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onSet(origin, true)}>
            <Bell />
            Turn on notifications
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onSet(origin, null)}>
          <RotateCcw />
          Forget
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** What an origin is called without an installed app: its host. */
function siteName(origin: string): string {
  const host = originLabel(origin);
  return origin.startsWith('nsite://') && host.length > 16 ? `${host.slice(0, 12)}…` : host;
}

function originLabel(origin: string): string {
  return origin.replace(/^[a-z]+:\/\//, '');
}
