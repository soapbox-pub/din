import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, MoreHorizontal, Pause, Play, RefreshCw, Trash2, type LucideIcon } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
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
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import type { AppDefinition } from '@/lib/apps';
import {
  backgroundApp,
  getPeriodicSyncBridge,
  tagSummary,
  type BackgroundSite,
  type BackgroundStatus,
} from '@/lib/periodicSync';

const QUERY_KEY = ['periodic-sync'];

const KIND_LABELS: Record<BackgroundSite['kind'], string> = {
  app: 'App',
  nsite: 'Installed nsite',
  web: 'Web app',
};

/** Why a site isn't being woken, when it isn't. */
function stateLabel(site: BackgroundSite, enabled: boolean): string | null {
  if (!site.allowed) return site.kind === 'app' ? 'Not on this computer right now' : 'No longer allowed to refresh';
  if (site.paused) return 'Paused';
  if (!enabled) return 'Off';
  return null;
}

/**
 * What apps, installed nsites and installed web apps do while they're
 * closed: each one's periodic sync tags (registration.periodicSync, kept by
 * electron/periodic-sync.mts), how often they run and how the last run went,
 * with a switch for all of them, and each one paused, run now, or removed.
 * `din background` does the same. Nothing outside the Electron shell.
 */
export function BackgroundActivity() {
  const bridge = getPeriodicSyncBridge();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => bridge!.status(),
    enabled: !!bridge,
  });

  useEffect(
    () => bridge?.onChanged(() => void queryClient.invalidateQueries({ queryKey: QUERY_KEY })),
    [bridge, queryClient],
  );

  // Last run and next run read "5 minutes ago": keep them current.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!bridge) {
    return (
      <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">Background activity needs Din’s desktop app.</p>
      </div>
    );
  }

  const refresh = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const setEnabled = (enabled: boolean) => {
    queryClient.setQueryData<BackgroundStatus>(QUERY_KEY, (prev) => prev && { ...prev, enabled });
    void bridge.setEnabled(enabled).finally(refresh);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
        <div className="flex min-w-0 items-start gap-3">
          <RefreshCw className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <Label htmlFor="background-enabled" className="cursor-pointer text-sm">
              Let apps refresh in the background
            </Label>
            <p className="text-xs text-muted-foreground">
              Apps that asked can wake up every so often while they’re closed, briefly, to fetch what’s new.
            </p>
          </div>
        </div>
        <Switch id="background-enabled" checked={data?.enabled ?? true} disabled={!data} onCheckedChange={setEnabled} />
      </div>

      <div className="border-t border-border/60 pt-4">
        <h3 className="text-sm font-medium text-foreground">Scheduled</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          What each app does on a schedule, as often as every 15 minutes. Pause one to keep its schedule without running it.
        </p>
        {isLoading ? (
          <div className="flex flex-col gap-2" aria-hidden>
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-md border p-3">
                <Skeleton className="size-8 shrink-0 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-56" />
                </div>
              </div>
            ))}
          </div>
        ) : !data || data.sites.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-8 py-8 text-center">
            <RefreshCw className="mx-auto mb-3 size-6 text-muted-foreground/80" aria-hidden />
            <p className="mx-auto max-w-sm text-sm text-muted-foreground">No app has asked to refresh in the background yet.</p>
          </div>
        ) : (
          <SiteRows status={data} onChanged={refresh} />
        )}
      </div>
    </div>
  );
}

function SiteRows({ status, onChanged }: { status: BackgroundStatus; onChanged: () => void }) {
  const apps = useInstalledApps();
  const rows = status.sites
    .map((site) => ({ site, ...backgroundApp(site, apps) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <ul className="flex flex-col gap-2">
      {rows.map(({ site, app, name }) => (
        <SiteRow key={site.origin} site={site} app={app} name={name} enabled={status.enabled} onChanged={onChanged} />
      ))}
    </ul>
  );
}

interface Action {
  key: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  destructive?: boolean;
}

function SiteRow({
  site,
  app,
  name,
  enabled,
  onChanged,
}: {
  site: BackgroundSite;
  app: AppDefinition | undefined;
  name: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const bridge = getPeriodicSyncBridge()!;
  const { open } = useWindowActions();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const state = stateLabel(site, enabled);
  const id = `background-${site.origin}`;

  const setPaused = (paused: boolean) => void bridge.setPaused(site.origin, paused).finally(onChanged);
  const runNow = () => {
    setRunning(true);
    void bridge.run(site.origin).finally(() => {
      setRunning(false);
      onChanged();
    });
  };

  // The ⋯ menu's and the right-click menu's, in the same order.
  const actions: (Action | 'separator')[] = [
    ...(app ? [{ key: 'open', label: `Open ${name}`, icon: Play, run: () => open(app.id) }] : []),
    { key: 'run', label: 'Run now', icon: RefreshCw, run: runNow },
    site.paused
      ? { key: 'resume', label: 'Resume', icon: Play, run: () => setPaused(false) }
      : { key: 'pause', label: 'Pause', icon: Pause, run: () => setPaused(true) },
    'separator',
    { key: 'remove', label: 'Remove…', icon: Trash2, run: () => setConfirming(true), destructive: true },
  ];

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <li className="flex items-start gap-3 rounded-md border bg-muted/20 p-3">
            {app ? (
              <AppIcon icon={app.icon} className="size-8 shrink-0 rounded-md" />
            ) : (
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground/5">
                <Globe className="size-4 text-muted-foreground" aria-hidden />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <label htmlFor={id} className="block cursor-pointer truncate text-sm">
                {name}
              </label>
              <span className="block truncate text-xs text-muted-foreground">
                {KIND_LABELS[site.kind]}
                {state && ` · ${state}`}
              </span>
              <ul className="mt-2 flex flex-col gap-1">
                {site.tags.map((tag) => (
                  <li key={tag.tag} className="min-w-0 text-xs">
                    <span className="font-mono text-foreground">{tag.tag}</span>
                    <span className="text-muted-foreground"> · {tagSummary(tag, site, enabled)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={`More for ${name}`}
                  disabled={running}
                >
                  {running ? <RefreshCw className="size-4 motion-safe:animate-spin" aria-hidden /> : <MoreHorizontal className="size-4" aria-hidden />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {actions.map((a, i) =>
                  a === 'separator' ? (
                    <DropdownMenuSeparator key={`separator-${i}`} />
                  ) : (
                    <DropdownMenuItem key={a.key} variant={a.destructive ? 'destructive' : 'default'} onSelect={a.run}>
                      <a.icon />
                      {a.label}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Switch
              id={id}
              checked={!site.paused}
              aria-label={site.paused ? `Resume ${name}` : `Pause ${name}`}
              onCheckedChange={(on) => setPaused(!on)}
            />
          </li>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {actions.map((a, i) =>
            a === 'separator' ? (
              <ContextMenuSeparator key={`separator-${i}`} />
            ) : (
              <ContextMenuItem key={a.key} variant={a.destructive ? 'destructive' : 'default'} disabled={running && a.key === 'run'} onSelect={a.run}>
                <a.icon />
                {a.label}
              </ContextMenuItem>
            ),
          )}
        </ContextMenuContent>
      </ContextMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}’s schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              {site.kind === 'app'
                ? 'It stops waking up in the background. It can schedule itself again the next time it’s open; pause it to keep it from running.'
                : 'It stops waking up in the background, and has to ask again before it can.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void bridge.remove(site.origin).finally(onChanged)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
