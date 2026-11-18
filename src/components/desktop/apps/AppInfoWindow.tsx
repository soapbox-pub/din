import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CalendarDays,
  Copy,
  FileType,
  FolderOpen,
  Hash,
  Link2,
  ListChecks,
  MonitorUp,
  Package,
  Pin,
  Play,
  RefreshCw,
  Share2,
  Square,
  Tag,
  Trash2,
  User,
  Zap,
} from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { appsDockedAs, windowTile } from '@/lib/apps';
import { APP_KIND_LABELS, appFacts, nostrLinksLabel, type AppFacts } from '@/lib/appInfo';
import { getBrowserBridge, type SiteInfo } from '@/lib/browser';
import { cleanFsError } from '@/lib/fs';
import { hiddenBadges, withBadgeHidden } from '@/lib/hiddenBadges';
import { getNappHost, type NappStatus } from '@/lib/napp';
import { websiteLabel } from '@/lib/nsiteApps';
import { getNsiteStore } from '@/lib/nsiteStore';
import { getPeriodicSyncBridge, tagSummary, type BackgroundSite } from '@/lib/periodicSync';
import { PERMISSION_LABELS } from '@/lib/launchedApps';
import type { SiteCapability } from '@/lib/promptBridge';
import { SITE_CAPABILITIES } from '@/lib/siteCapabilities';
import { cn } from '@/lib/utils';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useDesktopIcons } from '@/contexts/DesktopIconsContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useNativeApps } from '@/hooks/useNativeApps';
import { usePinnedApps } from '@/hooks/usePinnedApps';
import { useNsitePublisher } from '@/hooks/useSiteIdentity';
import { useToast } from '@/hooks/useToast';
import { AppIcon } from '@/shared/AppIcon';
import { SettingsToken } from '@/shared/settingsChrome';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsFallback, SettingsSubHeading } from '@/shared/settingsSection';
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

/** One row of a group: its token, what it is, what it says, and a control at its end. */
function Row({
  icon,
  label,
  detail,
  htmlFor,
  children,
}: {
  icon: Parameters<typeof SettingsToken>[0]['icon'];
  label: ReactNode;
  detail?: ReactNode;
  /** The control's id, so clicking the label works it. */
  htmlFor?: string;
  children?: ReactNode;
}) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <SettingsToken icon={icon} />
      <Label htmlFor={htmlFor} className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{label}</span>
        {detail && <span className="block break-words text-xs text-muted-foreground">{detail}</span>}
      </Label>
      {children}
    </div>
  );
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
        className={cn(
          'grid size-10 place-items-center rounded-full clay',
          destructive ? 'bg-destructive/15' : 'bg-foreground/10 text-ink-accent',
        )}
      >
        <Icon className="size-4.5" strokeWidth={1.75} />
      </span>
      {label}
    </button>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * App info, as Android has it for each app, from the right-click menus of
 * the Dock, the taskbar and the apps menu (`din apps info`): the app's icon,
 * name and kind; opening it, stopping it (closing its windows) and
 * uninstalling it; keeping it in the Dock, its badge, a shortcut on the
 * desktop; what it may do (a website's or nsite's answers, as its site info
 * has them; what a Din app's manifest asks for); what it does while it's
 * closed; the links, files and shares it opens; clearing what it stored;
 * and where it's from. Launch params `app`, the app's id, and `at`, which
 * starts it over.
 */
export function AppInfoWindow({ params }: AppComponentProps) {
  const appId = typeof params?.app === 'string' ? params.app : '';
  return <AppInfo key={`${appId}:${String(params?.at)}`} appId={appId} />;
}

function AppInfo({ appId }: { appId: string }) {
  const installed = useInstalledApps();
  const { getApp } = installed;
  const app = getApp(appId);
  const { apps: nativeApps } = useNativeApps();
  useWindowTitle(app ? `${app.name} – App Info` : 'App Info');

  if (!app) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <SettingsFallback icon={Package}>This app isn’t on this computer anymore.</SettingsFallback>
      </div>
    );
  }

  const facts = appFacts(app, installed, nativeApps.find((n) => n.id === app.id));
  return (
    <div className="h-full overflow-y-auto bg-background @container">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 [&>*]:shrink-0">
        <Header facts={facts} />
        <Actions facts={facts} />
        <Desktop facts={facts} />
        <Permissions facts={facts} />
        <Background facts={facts} />
        <Opens facts={facts} />
        <Storage facts={facts} />
        <Details facts={facts} />
      </div>
    </div>
  );
}

function Header({ facts }: { facts: AppFacts }) {
  const { getApp } = useInstalledApps();
  const { windows } = useWindowManager();
  const app = getApp(facts.id)!;
  const publisher = useNsitePublisher(facts.nsiteHost);
  const running = windows.filter((w) => !w.closing && windowTile(w, getApp) === facts.id).length;
  const kind = facts.kind === 'nsite' && publisher ? `nsite by ${publisher}` : APP_KIND_LABELS[facts.kind];
  return (
    <header className="flex flex-col items-center gap-2 px-4 pt-4 text-center">
      <AppIcon icon={app.icon} web={app.web} className="size-20 text-foreground drop-shadow-md" />
      <h1 className="max-w-full break-words font-[family-name:var(--font-title)] text-2xl font-semibold">{app.name}</h1>
      <p className="text-sm text-muted-foreground">
        {kind}
        {running > 0 && ` · ${running === 1 ? 'Open' : `${running} windows open`}`}
      </p>
      {facts.description && <p className="max-w-prose text-sm text-muted-foreground">{facts.description}</p>}
    </header>
  );
}

function Actions({ facts }: { facts: AppFacts }) {
  const { getApp, uninstallApp } = useInstalledApps();
  const { windows } = useWindowManager();
  const { open, closeApp } = useWindowActions();
  const [, setPinned] = usePinnedApps();
  const [confirming, setConfirming] = useState(false);
  const running = windows.some((w) => !w.closing && windowTile(w, getApp) === facts.id);

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

  return (
    <div className="flex justify-center gap-2 border-b border-border/60 pb-4">
      <ActionButton icon={Play} label="Open" onClick={() => open(facts.id)} />
      <ActionButton icon={Square} label="Stop" onClick={stop} disabled={!running} />
      {facts.uninstallable && (
        <ActionButton icon={Trash2} label="Uninstall" destructive onClick={() => setConfirming(true)} />
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {facts.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its windows close, and it leaves the Dock and the apps menu.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={uninstall}>
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Desktop({ facts }: { facts: AppFacts }) {
  const [pinned, setPinned] = usePinnedApps();
  const { config, updateConfig } = useAppContext();
  const icons = useDesktopIcons();
  const { toast } = useToast();
  const isPinned = pinned.includes(facts.id);
  const badgeShown = !hiddenBadges(config).includes(facts.id);
  const dock = config.desktopLayout === 'taskbar' ? 'taskbar' : 'Dock';

  return (
    <section aria-labelledby="app-info-desktop" className="flex flex-col gap-2">
      <SettingsSubHeading>
        <span id="app-info-desktop">On the desktop</span>
      </SettingsSubHeading>
      <div className={settingsGroup}>
        <Row icon={Pin} label={dock === 'Dock' ? 'Keep in Dock' : 'Pin to taskbar'} htmlFor="app-info-pin">
          <Switch
            id="app-info-pin"
            checked={isPinned}
            onCheckedChange={(on) => setPinned((prev) => (on ? [...prev.filter((id) => id !== facts.id), facts.id] : prev.filter((id) => id !== facts.id)))}
          />
        </Row>
        <Row icon={Bell} label="Badge" detail="A count of what’s new on its icon" htmlFor="app-info-badge">
          <Switch
            id="app-info-badge"
            checked={badgeShown}
            onCheckedChange={(on) => updateConfig((c) => withBadgeHidden(c, facts.id, !on))}
          />
        </Row>
        {icons.dir && (
          <Row icon={MonitorUp} label="Shortcut on the desktop">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void icons.addApp(facts.id).catch((error: unknown) =>
                  toast({ title: 'Couldn’t add the app to the desktop', description: cleanFsError(error), variant: 'destructive' }))}
            >
              Add
            </Button>
          </Row>
        )}
      </div>
    </section>
  );
}

/** The answers the user gave a website or nsite, read again whenever they change. */
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

function Permissions({ facts }: { facts: AppFacts }) {
  const site = facts.kind === 'web' || facts.kind === 'nsite' ? facts.origin : null;
  const browser = getBrowserBridge();
  const [info, setPermission] = useSiteInfo(site);

  let body: ReactNode;
  if (site && browser) {
    const answered = (Object.keys(SITE_CAPABILITIES) as SiteCapability[]).filter((c) => info?.permissions[c] !== undefined);
    const always = facts.kind === 'nsite' ? NSITE_CAPABILITIES : WEB_CAPABILITIES;
    const shown = (Object.keys(SITE_CAPABILITIES) as SiteCapability[]).filter((c) => always.includes(c) || answered.includes(c));
    body = (
      <>
        <div className={settingsGroup}>
          {shown.map((capability) => {
            const { name, icon } = SITE_CAPABILITIES[capability];
            const answer = info?.permissions[capability];
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
  } else if (site) {
    body = <p className="px-1 text-sm text-muted-foreground">What it may do is kept by Din’s desktop app.</p>;
  } else if (facts.kind === 'linux' || facts.kind === 'windows') {
    body = (
      <p className="px-1 text-sm text-muted-foreground">
        It runs as you, so it can open any of your files and reach the network, as programs on a computer do.
      </p>
    );
  } else if (facts.kind === 'system') {
    body = <p className="px-1 text-sm text-muted-foreground">It’s part of Din’s desktop itself.</p>;
  } else if (facts.permissions.length === 0 && facts.folders.length === 0) {
    body = <p className="px-1 text-sm text-muted-foreground">Nothing more than a web page: its manifest asks for no permissions.</p>;
  } else {
    body = (
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
        <p className="px-1 text-xs text-muted-foreground">
          {facts.kind === 'builtin'
            ? 'Its manifest asks for these, and they’re reviewed with Din’s code.'
            : 'Its manifest asks for these, and you allowed them when you added it.'}
        </p>
      </>
    );
  }

  return (
    <section aria-labelledby="app-info-permissions" className="flex flex-col gap-2">
      <SettingsSubHeading>
        <span id="app-info-permissions">Permissions</span>
      </SettingsSubHeading>
      {body}
    </section>
  );
}

function Background({ facts }: { facts: AppFacts }) {
  const bridge = getPeriodicSyncBridge();
  const napp = getNappHost();
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['periodic-sync'],
    queryFn: () => bridge!.status(),
    enabled: Boolean(bridge && facts.origin),
  });
  useEffect(
    () => bridge?.onChanged(() => void queryClient.invalidateQueries({ queryKey: ['periodic-sync'] })),
    [bridge, queryClient],
  );
  const host = facts.nsiteHost;
  const { data: nappStatus } = useQuery<NappStatus>({
    queryKey: ['app-info', 'napp', host],
    queryFn: () => napp!.status(host!),
    enabled: Boolean(napp && host),
  });

  const site: BackgroundSite | undefined = status?.sites.find((s) => s.origin === facts.origin);
  const watching = (nappStatus?.subscriptions ?? 0) > 0;
  if (!site && !watching) return null;

  const setPaused = (paused: boolean) =>
    void bridge?.setPaused(site!.origin, paused).finally(() => void queryClient.invalidateQueries({ queryKey: ['periodic-sync'] }));

  return (
    <section aria-labelledby="app-info-background" className="flex flex-col gap-2">
      <SettingsSubHeading>
        <span id="app-info-background">While it’s closed</span>
      </SettingsSubHeading>
      <div className={settingsGroup}>
        {watching && (
          <Row
            icon={Zap}
            label="Watching Nostr for notifications"
            detail={`${nappStatus!.subscriptions} subscription${nappStatus!.subscriptions === 1 ? '' : 's'}`}
          />
        )}
        {site && status && (
          <Row
            icon={RefreshCw}
            label="Refresh in the background"
            detail={
              !status.enabled
                ? 'Background activity is off for every app'
                : !site.allowed
                  ? 'Not allowed anymore'
                  : site.tags.map((tag) => tagSummary(tag, site, status.enabled)).join('; ') || 'Nothing scheduled'
            }
            htmlFor="app-info-background-switch"
          >
            <Switch id="app-info-background-switch" checked={!site.paused} onCheckedChange={(on) => setPaused(!on)} />
          </Row>
        )}
      </div>
    </section>
  );
}

function Opens({ facts }: { facts: AppFacts }) {
  const { linkedWebsites, setOpensLinks } = useInstalledApps();
  const links = linkedWebsites.filter((w) => w.appId === facts.id);
  const nostr = nostrLinksLabel(facts.nostrKinds);
  if (!nostr && facts.fileTypes.length === 0 && !facts.takesShares && links.length === 0 && facts.shortcuts.length === 0) return null;

  return (
    <section aria-labelledby="app-info-opens" className="flex flex-col gap-2">
      <SettingsSubHeading>
        <span id="app-info-opens">What it opens</span>
      </SettingsSubHeading>
      <div className={settingsGroup}>
        {links.length > 0 && (
          <Row
            icon={Link2}
            label="Open links to its website"
            detail={links.map(websiteLabel).join(', ')}
            htmlFor="app-info-links"
          >
            <Switch id="app-info-links" checked={links.every((l) => l.on)} onCheckedChange={(on) => setOpensLinks(facts.id, on)} />
          </Row>
        )}
        {nostr && <Row icon={Hash} label="nostr: links" detail={nostr} />}
        {facts.fileTypes.length > 0 && <Row icon={FileType} label="Files" detail={facts.fileTypes.join(', ')} />}
        {facts.takesShares && <Row icon={Share2} label="Shares" detail="It’s offered when you share from another app" />}
        {facts.shortcuts.length > 0 && <Row icon={Tag} label="Shortcuts" detail={facts.shortcuts.join(', ')} />}
      </div>
    </section>
  );
}

function Storage({ facts }: { facts: AppFacts }) {
  const browser = getBrowserBridge();
  const napp = getNappHost();
  const { toast } = useToast();
  const { closeApp } = useWindowActions();
  const [confirming, setConfirming] = useState(false);
  const canClear = (facts.kind === 'nsite' && napp) || (facts.kind === 'web' && browser && facts.origin);
  if (!canClear) return null;

  const clear = async () => {
    try {
      // Its windows hold what they read; they start over without it.
      closeApp(facts.id);
      if (facts.kind === 'nsite') await napp!.clearData(facts.nsiteHost!);
      else await browser!.clearSiteData(facts.origin!, false);
      toast({ title: `Cleared ${facts.name}’s data` });
    } catch {
      toast({ title: `Couldn’t clear ${facts.name}’s data`, variant: 'destructive' });
    }
  };

  return (
    <section aria-labelledby="app-info-storage" className="flex flex-col gap-2">
      <SettingsSubHeading>
        <span id="app-info-storage">Storage</span>
      </SettingsSubHeading>
      <div className={settingsGroup}>
        <Row
          icon={Trash2}
          label="Clear data"
          detail={facts.kind === 'nsite'
            ? 'What it stored on this computer, its notifications and subscriptions, its environment and its permissions'
            : 'Its cookies, and everything it saved on this computer'}
        >
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Clear
          </Button>
        </Row>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear {facts.name}’s data?</AlertDialogTitle>
            <AlertDialogDescription>
              {facts.kind === 'nsite'
                ? 'This deletes what it stored on this computer, in the Web Browser too, with its notifications and subscriptions, its environment and its permissions. It stays installed.'
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
    </section>
  );
}

function Details({ facts }: { facts: AppFacts }) {
  const store = getNsiteStore();
  const host = facts.nsiteHost;
  const { toast } = useToast();
  const { data: summary } = useQuery({
    queryKey: ['nsite-store', 'info', host],
    queryFn: () => store!.info(host!),
    enabled: Boolean(store && host),
  });
  const publisher = useNsitePublisher(host);

  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(() => toast({ title: 'Copied' }), () => {});

  return (
    <section aria-labelledby="app-info-details" className="flex flex-col gap-2">
      <SettingsSubHeading>
        <span id="app-info-details">Details</span>
      </SettingsSubHeading>
      <div className={settingsGroup}>
        <Row icon={Package} label="Kind" detail={APP_KIND_LABELS[facts.kind]} />
        {publisher && <Row icon={User} label="Published by" detail={publisher} />}
        {facts.address && (
          <Row
            icon={facts.kind === 'folder' ? FolderOpen : Link2}
            label={facts.kind === 'folder' || facts.kind === 'command' ? 'Folder' : facts.kind === 'linux' || facts.kind === 'windows' ? 'Desktop entry' : 'Address'}
            detail={<span className="font-mono select-text">{facts.address}</span>}
          >
            <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Copy" onClick={() => copy(facts.address!)}>
              <Copy className="size-4" strokeWidth={1.75} aria-hidden />
            </Button>
          </Row>
        )}
        {facts.categories.length > 0 && <Row icon={Tag} label="Categories" detail={facts.categories.join(', ')} />}
        {facts.installedAt !== null && (
          <Row icon={CalendarDays} label={facts.kind === 'folder' ? 'Added' : 'Installed'} detail={formatDate(facts.installedAt)} />
        )}
        {summary && (
          <Row
            icon={RefreshCw}
            label="Version"
            detail={`Published ${formatDate(summary.updatedAt * 1000)} · ${Object.keys(summary.paths).length} files`}
          />
        )}
        <Row icon={Hash} label="App id" detail={<span className="font-mono select-text break-all">{facts.id}</span>} />
      </div>
    </section>
  );
}
