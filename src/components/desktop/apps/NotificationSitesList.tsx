import { useEffect, type ComponentProps } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Globe, RotateCcw } from 'lucide-react';
import { AppIcon } from '@/shared/AppIcon';
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
import { appFacts, notifiesBySite, setAppNotifications } from '@/lib/appInfo';
import { useNotificationCenter } from '@/lib/notificationCenter';
import { canonicalHostOfUrl } from '@/lib/nsiteApps';
import { useToast } from '@/hooks/useToast';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsSubHeading } from '@/shared/settingsSection';
import { SettingsToken } from '@/shared/settingsChrome';

interface Site {
  origin: string;
  allow: boolean;
  /** What an allowed website calls itself, from its web app manifest. */
  name?: string | null;
  /** Its icon, as a data URL. */
  icon?: string | null;
}

const QUERY_KEY = ['site-permissions', 'notifications'];

/**
 * The apps and sites that notify, each switched on or off: Din's own apps
 * that notify (Mail, Messages…) and any other app that has, heard or not by
 * the notification center as in their App Info; and installed nsites
 * (window.napp and their service workers) and web pages in tabs and web apps
 * that asked, which can also be forgotten so they ask again. Turning an
 * nsite's off also ends the Nostr subscriptions it keeps while closed
 * (electron/napp.mts). The same answers are behind the site info in the Web
 * Browser and an nsite's title bar. Sites only in the Electron shell.
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

  const set = (origin: string, allow: boolean | null) => {
    if (!browser) return;
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
        Apps that notify, and installed nsites and websites that asked to. Forget a site to have it ask again.
      </p>
      <AppRows />
      {!browser ? null : isLoading ? (
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
        <div className="px-8 py-6 text-center">
          <Bell className="mx-auto mb-3 size-6 text-muted-foreground/80" aria-hidden />
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            No site has asked to show notifications yet.
          </p>
        </div>
      ) : (
        <SiteRows sites={sites} onSet={set} />
      )}
    </div>
  );
}

/**
 * The apps the notification center hears or not (anything but a website or
 * nsite, whose permission says): Din's own that notify, and any that has.
 */
function AppRows() {
  const installed = useInstalledApps();
  const { appsHeard, appsOff } = useNotificationCenter();
  const { toast } = useToast();
  const rows = appsHeard
    .map((id) => installed.getApp(id))
    .filter((app): app is NonNullable<typeof app> => !!app)
    .map((app) => ({ app, facts: appFacts(app, installed) }))
    .filter(({ facts }) => !notifiesBySite(facts))
    .sort((a, b) => a.app.name.localeCompare(b.app.name));
  if (rows.length === 0) return null;

  return (
    <ul className={`${settingsGroup} mb-4`}>
      {rows.map(({ app, facts }) => (
        <NotifierRow
          key={app.id}
          id={`notif-app-${app.id}`}
          name={app.name}
          icon={app.icon}
          allow={!appsOff.includes(app.id)}
          onOpen={app.id}
          onSet={(on) => {
            void setAppNotifications(facts, on).catch((e: unknown) =>
              toast({ title: 'Couldn’t change its notifications', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }));
          }}
        />
      ))}
    </ul>
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
      return {
        ...site,
        app,
        name: app?.name ?? site.name ?? siteName(site.origin),
        icon: app?.icon ?? site.icon ?? null,
      };
    })
    .sort((a, b) => Number(b.allow) - Number(a.allow) || a.name.localeCompare(b.name));

  return (
    <ul className={settingsGroup}>
      {rows.map(({ origin, allow, app, name, icon }) => (
        <SiteRow key={origin} origin={origin} allow={allow} app={app} name={name} icon={icon} onSet={onSet} />
      ))}
    </ul>
  );
}

function SiteRow({
  origin,
  allow,
  app,
  name,
  icon,
  onSet,
}: {
  origin: string;
  allow: boolean;
  app: ReturnType<ReturnType<typeof useInstalledApps>['getApp']>;
  name: string;
  icon: ComponentProps<typeof AppIcon>['icon'] | null;
  onSet: (origin: string, allow: boolean | null) => void;
}) {
  const nsiteHost = canonicalHostOfUrl(`${origin}/`);
  const publisher = useNsitePublisher(nsiteHost);
  // An nsite's host is a key nobody can read; it goes by who publishes it.
  const detail = nsiteHost ? publisher && `by ${publisher}` : originLabel(origin);
  return (
    <NotifierRow
      id={`notif-site-${origin}`}
      name={name}
      icon={icon}
      allow={allow}
      detail={detail}
      onOpen={app?.id}
      onSet={(on) => onSet(origin, on)}
      onForget={() => onSet(origin, null)}
    />
  );
}

/** One app or site, its switch, and the same in its right-click menu. */
function NotifierRow({
  id,
  name,
  icon,
  allow,
  detail,
  onOpen,
  onSet,
  onForget,
}: {
  id: string;
  name: string;
  icon: ComponentProps<typeof AppIcon>['icon'] | null | undefined;
  allow: boolean;
  detail?: string | null;
  /** The app to open, from its menu. */
  onOpen?: string;
  onSet: (allow: boolean) => void;
  /** Forget a site's answer, so it asks again. */
  onForget?: () => void;
}) {
  const { open } = useWindowActions();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="flex items-center gap-3 px-4 py-3">
          {icon ? (
            <AppIcon icon={icon} className="size-8 shrink-0 rounded-md" />
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
          {onForget && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Forget ${name}`}
              title="Forget (asks again next time)"
              onClick={onForget}
            >
              <RotateCcw className="size-4.5" strokeWidth={1.75} aria-hidden />
            </Button>
          )}
          <Switch id={id} checked={allow} onCheckedChange={onSet} />
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {onOpen && <ContextMenuItem onSelect={() => open(onOpen)}>Open {name}</ContextMenuItem>}
        {allow ? (
          <ContextMenuItem onSelect={() => onSet(false)}>
            <BellOff />
            Turn off notifications
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onSet(true)}>
            <Bell />
            Turn on notifications
          </ContextMenuItem>
        )}
        {onForget && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onForget}>
              <RotateCcw />
              Forget
            </ContextMenuItem>
          </>
        )}
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
