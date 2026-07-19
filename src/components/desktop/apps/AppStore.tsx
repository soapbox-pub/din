import { useMemo, useState } from 'react';
import { Check, Download, ExternalLink, RefreshCw, Search, Store } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import type { AppComponentProps } from '@/lib/apps';
import type { StoreApp } from '@/lib/nostrApps';
import { useNostrApps } from '@/hooks/useNostrApps';
import { useAuthor } from '@/hooks/useAuthor';
import { useToast } from '@/hooks/useToast';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { AppIcon } from '@/components/desktop/AppIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The App Store: browses NIP-89 app listings published to the user's relays
 * and installs any of them as a desktop web app in one click. Installed
 * entries go through the same installWebApp() path as the browser's
 * "install site as app" button, so they land in the launcher, roam via
 * encrypted app data, and get the injected window.nostr login bridge.
 */
export function AppStore(_props: AppComponentProps) {
  const { data: apps, isLoading, isError, refetch, isRefetching } = useNostrApps();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!apps) return [];
    const q = search.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((app) => {
      const haystack = [
        app.name,
        app.about,
        app.website,
        ...app.hashtags,
      ].join('\u0000').toLowerCase();
      return haystack.includes(q);
    });
  }, [apps, search]);

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="mr-auto flex items-center gap-2 font-medium">
          <Store className="size-5 text-muted-foreground" aria-hidden />
          <span>App Store</span>
        </div>
        <div className="relative w-full max-w-64">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps…"
            aria-label="Search apps"
            autoComplete="off"
            spellCheck={false}
            className="h-8 pl-8"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => refetch()}
          disabled={isLoading || isRefetching}
          aria-label="Refresh catalog"
          title="Refresh catalog"
        >
          <RefreshCw
            className={isRefetching ? 'size-4 animate-spin' : 'size-4'}
            aria-hidden
          />
        </Button>
      </div>

      {/* Catalog */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isLoading ? (
          <CatalogSkeleton />
        ) : isError ? (
          <EmptyState message="Could not load the app catalog. Check your relay connections and try refreshing." />
        ) : filtered.length === 0 ? (
          <EmptyState
            message={
              search.trim()
                ? `No apps match “${search.trim()}”.`
                : 'No apps found on your relays yet. Try refreshing, or add more relays in Settings.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((app) => (
              <StoreAppCard key={app.address} app={app} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One catalog entry: icon, name, publisher, blurb, and the install button. */
function StoreAppCard({ app }: { app: StoreApp }) {
  const { installWebApp, findWebAppByUrl } = useInstalledApps();
  const { open: openApp } = useWindowActions();
  const { toast } = useToast();
  const author = useAuthor(app.pubkey);

  const installed = findWebAppByUrl(app.website);
  const publisher =
    author.data?.metadata?.name ??
    author.data?.metadata?.display_name ??
    `${nip19.npubEncode(app.pubkey).slice(0, 12)}…`;
  const hostname = useMemo(() => new URL(app.website).hostname, [app.website]);

  const install = () => {
    const webApp = installWebApp({
      name: app.name,
      url: app.website,
      icon: app.picture,
    });
    if (!webApp) {
      toast({
        title: 'Could not install app',
        description: 'The app listing has an invalid URL.',
        variant: 'destructive',
      });
      return;
    }
    toast({
      title: `${webApp.name} installed`,
      description: 'Find it in the app launcher, or right-click it to pin it to the taskbar.',
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <AppIcon
          icon={app.picture ?? ''}
          className="size-12 shrink-0 rounded-xl border border-border object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={app.name}>
            {app.name}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={hostname}>
            {hostname} · by {publisher}
          </p>
        </div>
      </div>

      <p className="line-clamp-3 min-h-10 flex-1 text-sm text-muted-foreground">
        {app.about}
      </p>

      {app.hashtags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {app.hashtags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {installed ? (
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => openApp(installed.id)}
        >
          <Check className="size-4" aria-hidden />
          Installed — Open
          <ExternalLink className="size-4" aria-hidden />
        </Button>
      ) : (
        <Button className="w-full" onClick={install}>
          <Download className="size-4" aria-hidden />
          Install
        </Button>
      )}
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
        >
          <div className="flex items-start gap-3">
            <Skeleton className="size-12 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2 pt-1">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
        <Store className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
