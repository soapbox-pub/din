import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FolderOpen, ListChecks, Package, Play, Square, Trash2 } from 'lucide-react';
import type { AppComponentProps, AppDefinition } from '@/lib/apps';
import { appsDockedAs, windowTile } from '@/lib/apps';
import {
  APP_KIND_LABELS,
  appFacts,
  appNotificationsState,
  nostrLinksLabel,
  notifiesBySite,
  setAppNotifications,
  type AppFacts,
} from '@/lib/appInfo';
import { THEMED_APP_ICONS } from '@/lib/appIcons';
import { badgedIcon } from '@/lib/badgedIcon';
import { getBrowserBridge, type SiteInfo } from '@/lib/browser';
import { hiddenBadges, withBadgeHidden } from '@/lib/hiddenBadges';
import { PERMISSION_LABELS } from '@/lib/launchedApps';
import { getNappHost, type NappStatus } from '@/lib/napp';
import { useNotificationCenter } from '@/lib/notificationCenter';
import { websiteLabel } from '@/lib/nsiteApps';
import { getNsiteStore } from '@/lib/nsiteStore';
import { getPeriodicSyncBridge, intervalLabel, tagSummary, type BackgroundSite, type BackgroundStatus } from '@/lib/periodicSync';
import type { SiteCapability } from '@/lib/promptBridge';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { SITE_CAPABILITIES } from '@/lib/siteCapabilities';
import { cn } from '@/lib/utils';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useWindowIcon } from '@/contexts/WindowIconContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useOwnWindowHeader } from '@/contexts/WindowFrameContext';
import { WindowControls, WindowDragRegion } from '@/components/desktop/WindowHeader';
import { ContentPane } from '@/shared/appChrome';
import { useAppContext } from '@/hooks/useAppContext';
import { useNativeApps } from '@/hooks/useNativeApps';
import { usePinnedApps } from '@/hooks/usePinnedApps';
import { useNsitePublisher } from '@/hooks/useSiteIdentity';
import { useToast } from '@/hooks/useToast';
import { AppIcon } from '@/shared/AppIcon';
import { SettingsToken } from '@/shared/settingsChrome';
import { settingsGroup, settingsRowButton } from '@/shared/settingsChromeStyles';
import { SettingsFallback, SettingsSubHeading } from '@/shared/settingsSection';
import { isGlyphIcon, themeIcon, useThemeIcons } from '@/shared/themeIcons';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** What a website may be asked for, listed even unanswered (as its site info lists them). */
const WEB_CAPABILITIES: SiteCapability[] = ['camera', 'microphone', 'geolocation', 'notifications'];
/** What an installed nsite asks the user for (as its title bar lists them). */
const NSITE_CAPABILITIES: SiteCapability[] = ['notifications', 'background-sync'];

/** What the window wears in its title bar and Dock tile: the app's icon, with this in its corner. */
const COG = '/icons/apps/settings.png';

type Page = 'main' | 'notifications' | 'permissions' | 'storage' | 'background' | 'opens';

const PAGE_TITLES: Record<Exclude<Page, 'main'>, string> = {
  notifications: 'Notifications',
  permissions: 'Permissions',
  storage: 'Storage',
  background: 'Background activity',
  opens: 'Open by default',
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** A row on the first page that opens a page of its own: its name, how it stands, a chevron. */
function NavRow({ label, value, onClick }: { label: string; value?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn(settingsRowButton, 'min-h-14')}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{label}</span>
        {value && <span className="block truncate text-xs text-muted-foreground">{value}</span>}
      </span>
      <ChevronRight className="size-4.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** A row of a page: what it is, what it says, and a control at its end. */
function Row({
  icon,
  label,
  detail,
  htmlFor,
  children,
}: {
  icon?: Parameters<typeof SettingsToken>[0]['icon'];
  label: ReactNode;
  detail?: ReactNode;
  /** The control's id, so clicking the label works it. */
  htmlFor?: string;
  children?: ReactNode;
}) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      {icon && <SettingsToken icon={icon} />}
      <Label htmlFor={htmlFor} className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{label}</span>
        {detail && <span className="block break-words text-xs text-muted-foreground">{detail}</span>}
      </Label>
      {children}
    </div>
  );
}

/** Words under a page's rows. */
function Note({ children }: { children: ReactNode }) {
  return <p className="px-1 text-xs text-muted-foreground">{children}</p>;
}

/** A big round action under the app's name, as Android's App info has them. */
function ActionButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: typeof Play;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-24 min-w-0 flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-sm outline-none',
        'hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60',
        'disabled:pointer-events-none disabled:opacity-40',
        destructive ? 'text-destructive' : 'text-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn('grid size-10 place-items-center rounded-full clay', destructive ? 'bg-destructive/15' : 'bg-foreground/10 text-ink-accent')}
      >
        <Icon className="size-4.5" strokeWidth={1.75} />
      </span>
      {label}
    </button>
  );
}

/**
 * App info, as Android has it for each app, from the right-click menus of
 * the Dock, the taskbar and the apps menu (`din apps info`). Its first page
 * is the app's icon, name and kind, Open, Stop (its windows closed) and
 * Uninstall, and a row for each of what it may change, each opening a page
 * of its own with a back button in the title bar, which keeps the app's icon
 * and name ("Armada – Notifications"): its notifications (on or
 * off, its badge, what it sent lately), its permissions, its storage, what
 * it does while closed, and what it opens. A window per app (`instanceParam`),
 * with a tile of its own in the Dock, wearing the app's icon with a cog.
 * Launch params `app`, the app's id, and `at`, which starts it over.
 */
export function AppInfoWindow({ params }: AppComponentProps) {
  const appId = typeof params?.app === 'string' ? params.app : '';
  return <AppInfo key={`${appId}:${String(params?.at)}`} appId={appId} />;
}

/** The app's icon with the cog on it, for the window to wear; null until it's drawn, or when it can't be. */
function useBadgedIcon(app: AppDefinition | undefined): string | null {
  const themeIcons = useThemeIcons();
  const icon = typeof app?.icon === 'string' ? app.icon : null;
  const isLocal = icon !== null && icon.startsWith('/') && !icon.startsWith('//');
  const themed = isLocal && THEMED_APP_ICONS[icon] ? themeIcon(themeIcons, THEMED_APP_ICONS[icon]) : null;
  const src = icon === null ? null : (themed ?? (isLocal ? icon : sanitizeImageUrl(icon)));
  const [drawn, setDrawn] = useState<{ src: string; url: string | null } | null>(null);
  useEffect(() => {
    // A monochrome theme's glyph is a mask, drawn on a tile by AppIcon alone.
    if (!src || isGlyphIcon(src)) return;
    let cancelled = false;
    void badgedIcon(src, COG).then((url) => {
      if (!cancelled) setDrawn({ src, url });
    });
    return () => {
      cancelled = true;
    };
  }, [src]);
  return drawn && drawn.src === src ? drawn.url : null;
}

/** A website's or nsite's answers, read again whenever they change, and answering one. */
function useSiteInfo(origin: string | null): [SiteInfo | null, (capability: SiteCapability, allow: boolean | null) => void] {
  const browser = getBrowserBridge();
  const queryClient = useQueryClient();
  const key = ['app-info', 'site', origin];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => browser!.getSiteInfo(origin!, false),
    enabled: Boolean(browser && origin),
  });
  useEffect(
    () => browser?.onSitePermissionsChanged(() => void queryClient.invalidateQueries({ queryKey: ['app-info', 'site'] })),
    [browser, queryClient],
  );
  const set = (capability: SiteCapability, allow: boolean | null) => {
    if (!browser || !origin) return;
    queryClient.setQueryData<SiteInfo>(key, (prev) => {
      if (!prev) return prev;
      const permissions = { ...prev.permissions };
      if (allow === null) delete permissions[capability];
      else permissions[capability] = allow;
      return { ...prev, permissions };
    });
    void browser.setSitePermission(origin, capability, allow, false).catch(() => {});
  };
  return [data ?? null, set];
}

/** What the app has scheduled to do while closed, and an nsite's Nostr subscriptions. */
function useBackground(facts: AppFacts | null) {
  const bridge = getPeriodicSyncBridge();
  const napp = getNappHost();
  const queryClient = useQueryClient();
  const { data: status } = useQuery<BackgroundStatus>({
    queryKey: ['periodic-sync'],
    queryFn: () => bridge!.status(),
    enabled: Boolean(bridge && facts?.origin),
  });
  useEffect(
    () => bridge?.onChanged(() => void queryClient.invalidateQueries({ queryKey: ['periodic-sync'] })),
    [bridge, queryClient],
  );
  const host = facts?.nsiteHost ?? null;
  const { data: nappStatus } = useQuery<NappStatus>({
    queryKey: ['app-info', 'napp', host],
    queryFn: () => napp!.status(host!),
    enabled: Boolean(napp && host),
  });
  const site: BackgroundSite | undefined = status?.sites.find((s) => s.origin === facts?.origin);
  return { status, site, subscriptions: nappStatus?.subscriptions ?? 0 };
}

type Background = ReturnType<typeof useBackground>;

function AppInfo({ appId }: { appId: string }) {
  const installed = useInstalledApps();
  const app = installed.getApp(appId);
  const { apps: nativeApps } = useNativeApps();
  const [page, setPage] = useState<Page>('main');
  const facts = app ? appFacts(app, installed, nativeApps.find((n) => n.id === app.id)) : null;
  const [site, setPermission] = useSiteInfo(facts && notifiesBySite(facts) ? facts.origin : null);
  const background = useBackground(facts);

  // Which app, always, and where in its info: "Armada – Notifications", as
  // an nsite's title bar keeps its name while it moves between pages.
  const title = !app ? 'App Info' : `${app.name} – ${page === 'main' ? 'App Info' : PAGE_TITLES[page]}`;
  useWindowTitle(title);
  const badged = useBadgedIcon(app);
  useWindowIcon(badged);
  useOwnWindowHeader();

  // As Settings: the title bar is the window's frosted frame, and the page
  // sits in it on a solid, rounded pane.
  const frame = (content: ReactNode) => (
    <div className="flex h-full w-full flex-col text-foreground">
      <WindowDragRegion className={cn('flex h-12 shrink-0 items-center gap-2 pr-3', page === 'main' ? 'pl-4' : 'pl-2')}>
        {page !== 'main' && (
          <button
            type="button"
            aria-label="Back"
            title="Back"
            onClick={() => setPage('main')}
            className="-mr-1 grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ChevronLeft className="size-4.5" strokeWidth={1.75} aria-hidden />
          </button>
        )}
        <AppIcon icon={badged ?? app?.icon ?? COG} web={app?.web} className="size-5 shrink-0" />
        <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-sm font-medium text-foreground/90">{title}</h1>
        <WindowControls />
      </WindowDragRegion>
      <ContentPane className="ml-2">{content}</ContentPane>
    </div>
  );

  if (!app || !facts) {
    return frame(
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SettingsFallback icon={Package}>This app isn’t on this computer anymore.</SettingsFallback>
      </div>,
    );
  }

  let body: ReactNode;
  if (page === 'notifications') body = <NotificationsPage facts={facts} site={site} subscriptions={background.subscriptions} />;
  else if (page === 'permissions') body = <PermissionsPage facts={facts} site={site} setPermission={setPermission} />;
  else if (page === 'storage') body = <StoragePage facts={facts} />;
  else if (page === 'background') body = <BackgroundPage background={background} />;
  else if (page === 'opens') body = <OpensPage facts={facts} />;
  else body = <MainPage app={app} facts={facts} site={site} background={background} onPage={setPage} />;

  return frame(
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      // Backspace or Alt+Left goes back a page, as a browser's.
      onKeyDown={(e) => {
        if (page === 'main' || (e.target as HTMLElement).closest('input, textarea, [role=combobox], [role=listbox]')) return;
        if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) {
          e.preventDefault();
          setPage('main');
        }
      }}
    >
      <div key={page} className="mx-auto flex max-w-xl flex-col gap-4 p-4 [&>*]:shrink-0">
        {body}
      </div>
    </div>,
  );
}

function MainPage({
  app,
  facts,
  site,
  background,
  onPage,
}: {
  app: AppDefinition;
  facts: AppFacts;
  site: SiteInfo | null;
  background: Background;
  onPage: (page: Page) => void;
}) {
  const { getApp, uninstallApp, linkedWebsites } = useInstalledApps();
  const { windows } = useWindowManager();
  const { open, closeApp } = useWindowActions();
  const [, setPinned] = usePinnedApps();
  useNotificationCenter();
  const publisher = useNsitePublisher(facts.nsiteHost);
  const store = getNsiteStore();
  const { data: summary } = useQuery({
    queryKey: ['nsite-store', 'info', facts.nsiteHost],
    queryFn: () => store!.info(facts.nsiteHost!),
    enabled: Boolean(store && facts.nsiteHost),
  });
  const [confirming, setConfirming] = useState(false);
  const running = windows.filter((w) => !w.closing && windowTile(w, getApp) === facts.id).length;

  // As the Dock's Close all windows: the app's own, and those under its tile.
  const stop = () => {
    for (const id of [facts.id, ...appsDockedAs(facts.id)]) closeApp(id);
  };
  // As the Dock's Uninstall.
  const uninstall = () => {
    closeApp(facts.id);
    setPinned((prev) => prev.filter((id) => id !== facts.id));
    uninstallApp(facts.id);
  };

  const notifications = appNotificationsState(facts, site);
  const bySite = notifiesBySite(facts);

  let permissions: string;
  if (bySite) {
    const allowed = (Object.keys(SITE_CAPABILITIES) as SiteCapability[]).filter((c) => site?.permissions[c] === true);
    permissions = allowed.length === 0 ? 'None allowed' : allowed.map((c) => SITE_CAPABILITIES[c].name).join(', ');
  } else if (facts.kind === 'linux' || facts.kind === 'windows') {
    permissions = 'Everything you can reach';
  } else if (facts.kind === 'system') {
    permissions = 'Part of Din';
  } else {
    const count = facts.permissions.length + (facts.folders.length > 0 ? 1 : 0);
    permissions = count === 0 ? 'None requested' : `${count} permission${count === 1 ? '' : 's'}`;
  }

  const { status, site: scheduled, subscriptions } = background;
  const backgroundValue = scheduled
    ? !status?.enabled
      ? 'Off for every app'
      : scheduled.paused
        ? 'Paused'
        : scheduled.tags[0]
          ? `Refreshes ${intervalLabel(scheduled.tags[0].minInterval)}`
          : 'Nothing scheduled'
    : subscriptions > 0
      ? 'Watching for notifications'
      : null;

  const links = linkedWebsites.filter((w) => w.appId === facts.id);
  const opens = [
    links.length > 0 && links.every((l) => l.on) ? `Links to ${links.map(websiteLabel).join(', ')}` : null,
    facts.nostrKinds !== undefined ? 'nostr: links' : null,
    facts.fileTypes.length > 0 ? `${facts.fileTypes.length} file type${facts.fileTypes.length === 1 ? '' : 's'}` : null,
    facts.takesShares ? 'Shares' : null,
  ].filter((part): part is string => part !== null);

  const canClear = (facts.kind === 'nsite' && getNappHost()) || (facts.kind === 'web' && getBrowserBridge());
  const kind = facts.kind === 'nsite' && publisher ? `nsite by ${publisher}` : APP_KIND_LABELS[facts.kind];
  // Where it's from, quietly at the foot, as Android puts the version.
  const footer = [
    summary ? `Published ${formatDate(summary.updatedAt * 1000)}` : null,
    facts.installedAt !== null ? `${facts.kind === 'folder' ? 'Added' : 'Installed'} ${formatDate(facts.installedAt)}` : null,
  ].filter((line): line is string => line !== null).join(' · ');

  return (
    <>
      <header className="flex flex-col items-center gap-1.5 px-4 pt-4 text-center">
        <AppIcon icon={app.icon} web={app.web} className="mb-1 size-20 text-foreground drop-shadow-md" />
        <h1 className="max-w-full break-words font-[family-name:var(--font-title)] text-2xl font-semibold">{app.name}</h1>
        <p className="text-sm text-muted-foreground">
          {kind}
          {running > 0 && ` · ${running === 1 ? 'Open' : `${running} windows open`}`}
        </p>
      </header>

      <div className="flex justify-center gap-2">
        <ActionButton icon={Play} label="Open" onClick={() => open(facts.id)} />
        <ActionButton icon={Square} label="Stop" onClick={stop} disabled={running === 0} />
        {facts.uninstallable && <ActionButton icon={Trash2} label="Uninstall" destructive onClick={() => setConfirming(true)} />}
      </div>

      <div className={settingsGroup}>
        <NavRow
          label="Notifications"
          value={notifications === 'on' ? 'On' : notifications === 'off' ? 'Off' : 'Asks first'}
          onClick={() => onPage('notifications')}
        />
        <NavRow label="Permissions" value={permissions} onClick={() => onPage('permissions')} />
        {canClear && <NavRow label="Storage" value="What it saved on this computer" onClick={() => onPage('storage')} />}
        {backgroundValue && <NavRow label="Background activity" value={backgroundValue} onClick={() => onPage('background')} />}
        {(opens.length > 0 || links.length > 0) && (
          <NavRow label="Open by default" value={opens.join(', ') || 'Nothing'} onClick={() => onPage('opens')} />
        )}
      </div>

      {(facts.address || footer) && (
        <div className="flex flex-col items-center gap-0.5 px-4 pt-2 text-center text-xs text-muted-foreground">
          {footer && <p>{footer}</p>}
          {facts.address && (
            <p className="max-w-full truncate font-mono select-text" title={facts.address}>
              {facts.address}
            </p>
          )}
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {facts.name}?</AlertDialogTitle>
            <AlertDialogDescription>Its windows close, and it leaves the Dock and the apps menu.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={uninstall}>
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function NotificationsPage({ facts, site, subscriptions }: { facts: AppFacts; site: SiteInfo | null; subscriptions: number }) {
  const { config, updateConfig } = useAppContext();
  const { notifications } = useNotificationCenter();
  const { toast } = useToast();
  const state = appNotificationsState(facts, site);
  const bySite = notifiesBySite(facts);
  const recent = notifications.filter((n) => n.source.appId === facts.id).slice(0, 10);

  const set = (on: boolean) =>
    void setAppNotifications(facts, on).catch((e: unknown) =>
      toast({ title: 'Couldn’t change its notifications', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }));

  return (
    <>
      <div className={settingsGroup}>
        <Row
          label={`All ${facts.name} notifications`}
          detail={
            state === 'ask'
              ? 'It asks before it shows any'
              : state === 'off'
                ? bySite ? 'Blocked: it can’t ask again' : 'Nothing it sends shows'
                : subscriptions > 0
                  ? 'On, and watching Nostr for them while it’s closed'
                  : undefined
          }
          htmlFor="app-info-notifications"
        >
          <Switch id="app-info-notifications" checked={state === 'on'} onCheckedChange={set} />
        </Row>
        <Row label="App icon badge" detail="A count of what’s new on its Dock icon" htmlFor="app-info-badge">
          <Switch
            id="app-info-badge"
            checked={!hiddenBadges(config).includes(facts.id)}
            onCheckedChange={(on) => updateConfig((c) => withBadgeHidden(c, facts.id, !on))}
          />
        </Row>
      </div>
      {recent.length > 0 && (
        <>
          <SettingsSubHeading>Recent</SettingsSubHeading>
          <ul className={settingsGroup}>
            {recent.map((n) => (
              <li key={n.id} className="flex flex-col px-4 py-2.5">
                <span className="truncate text-sm text-foreground">{n.title}</span>
                {n.body && <span className="line-clamp-2 text-xs text-muted-foreground">{n.body}</span>}
                <span className="text-xs text-muted-foreground">
                  {new Date(n.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function PermissionsPage({
  facts,
  site,
  setPermission,
}: {
  facts: AppFacts;
  site: SiteInfo | null;
  setPermission: (capability: SiteCapability, allow: boolean | null) => void;
}) {
  if (notifiesBySite(facts)) {
    if (!getBrowserBridge()) return <Note>What it may do is kept by Din’s desktop app.</Note>;
    const answered = (Object.keys(SITE_CAPABILITIES) as SiteCapability[]).filter((c) => site?.permissions[c] !== undefined);
    const always = facts.kind === 'nsite' ? NSITE_CAPABILITIES : WEB_CAPABILITIES;
    const shown = (Object.keys(SITE_CAPABILITIES) as SiteCapability[]).filter((c) => always.includes(c) || answered.includes(c));
    return (
      <>
        <div className={settingsGroup}>
          {shown.map((capability) => {
            const { name, icon } = SITE_CAPABILITIES[capability];
            const answer = site?.permissions[capability];
            const id = `app-info-permission-${capability}`;
            return (
              <Row key={capability} icon={icon} label={name} htmlFor={id}>
                <Select
                  value={answer === undefined ? 'ask' : answer ? 'allow' : 'block'}
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
              </Row>
            );
          })}
        </div>
        {answered.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              for (const capability of answered) setPermission(capability, null);
            }}
          >
            Reset permissions
          </Button>
        )}
      </>
    );
  }
  if (facts.kind === 'linux' || facts.kind === 'windows') {
    return <Note>It runs as you, so it can open any of your files and reach the network, as programs on a computer do.</Note>;
  }
  if (facts.kind === 'system') return <Note>It’s part of Din’s desktop itself.</Note>;
  if (facts.permissions.length === 0 && facts.folders.length === 0) {
    return <Note>Nothing more than a web page: it asks for no permissions.</Note>;
  }
  return (
    <>
      <ul className={settingsGroup}>
        {facts.permissions.map((p) => (
          <li key={p}>
            <Row icon={ListChecks} label={PERMISSION_LABELS[p]} />
          </li>
        ))}
        {facts.folders.length > 0 && (
          <li>
            <Row icon={FolderOpen} label="Read and change files in" detail={facts.folders.join(', ')} />
          </li>
        )}
      </ul>
      <Note>
        {facts.kind === 'builtin'
          ? 'It asks for these in its manifest, and they’re reviewed with Din’s code.'
          : 'It asks for these in its manifest, and you allowed them when you added it.'}
      </Note>
    </>
  );
}

function StoragePage({ facts }: { facts: AppFacts }) {
  const browser = getBrowserBridge();
  const napp = getNappHost();
  const store = getNsiteStore();
  const { toast } = useToast();
  const { closeApp } = useWindowActions();
  const [confirming, setConfirming] = useState(false);
  const { data: summary } = useQuery({
    queryKey: ['nsite-store', 'info', facts.nsiteHost],
    queryFn: () => store!.info(facts.nsiteHost!),
    enabled: Boolean(store && facts.nsiteHost),
  });
  const nsite = facts.kind === 'nsite';

  const clear = async () => {
    try {
      // Its windows hold what they read; they start over without it.
      closeApp(facts.id);
      if (nsite) await napp!.clearData(facts.nsiteHost!);
      else await browser!.clearSiteData(facts.origin!, false);
      toast({ title: `Cleared ${facts.name}’s data` });
    } catch {
      toast({ title: `Couldn’t clear ${facts.name}’s data`, variant: 'destructive' });
    }
  };

  return (
    <>
      <div className={settingsGroup}>
        {summary && (
          <Row
            label="App"
            detail={`${Object.keys(summary.paths).length} files, kept on this computer so it opens offline`}
          />
        )}
        <Row
          label="Data"
          detail={nsite
            ? 'What it saved here, its notifications and subscriptions, its environment and its permissions'
            : 'Its cookies, and everything it saved here'}
        >
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <Trash2 className="size-4.5" strokeWidth={1.75} aria-hidden />
            Clear data
          </Button>
        </Row>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear {facts.name}’s data?</AlertDialogTitle>
            <AlertDialogDescription>
              {nsite
                ? 'This deletes what it saved on this computer, in the Web Browser too, with its notifications and subscriptions, its environment and its permissions. It stays installed.'
                : 'This signs you out of it and deletes everything it saved on this computer, in the Web Browser too. It stays installed.'}{' '}
              It can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void clear()}>
              Clear data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BackgroundPage({ background }: { background: Background }) {
  const bridge = getPeriodicSyncBridge();
  const queryClient = useQueryClient();
  const { status, site, subscriptions } = background;
  const setPaused = (paused: boolean) =>
    void bridge?.setPaused(site!.origin, paused).finally(() => void queryClient.invalidateQueries({ queryKey: ['periodic-sync'] }));

  return (
    <>
      <div className={settingsGroup}>
        {site && status && (
          <Row
            label="Refresh in the background"
            detail={
              !status.enabled
                ? 'Background activity is off for every app, in Settings'
                : !site.allowed
                  ? 'It isn’t allowed to anymore'
                  : site.tags.map((tag) => tagSummary(tag, site, status.enabled)).join('; ') || 'Nothing scheduled'
            }
            htmlFor="app-info-background"
          >
            <Switch id="app-info-background" checked={!site.paused} onCheckedChange={(on) => setPaused(!on)} />
          </Row>
        )}
        {subscriptions > 0 && (
          <Row
            label="Watching Nostr for notifications"
            detail={`${subscriptions} subscription${subscriptions === 1 ? '' : 's'}, kept while it’s closed. Turning its notifications off ends them.`}
          />
        )}
      </div>
      {site && <Note>It wakes up at most this often while no window of it is open, to fetch what’s new.</Note>}
    </>
  );
}

function OpensPage({ facts }: { facts: AppFacts }) {
  const { linkedWebsites, setOpensLinks } = useInstalledApps();
  const links = linkedWebsites.filter((w) => w.appId === facts.id);
  const nostr = nostrLinksLabel(facts.nostrKinds);
  return (
    <div className={settingsGroup}>
      {links.length > 0 && (
        <Row label="Open links to its websites" detail={links.map(websiteLabel).join(', ')} htmlFor="app-info-links">
          <Switch id="app-info-links" checked={links.every((l) => l.on)} onCheckedChange={(on) => setOpensLinks(facts.id, on)} />
        </Row>
      )}
      {nostr && <Row label="nostr: links" detail={nostr} />}
      {facts.fileTypes.length > 0 && <Row label="Files" detail={facts.fileTypes.join(', ')} />}
      {facts.takesShares && <Row label="Shares" detail="It’s offered when you share from another app" />}
    </div>
  );
}
