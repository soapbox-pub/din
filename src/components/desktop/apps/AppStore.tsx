import { useMemo, useState } from 'react';
import { RefreshCw, Search, Store } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import type { AppComponentProps } from '@/lib/apps';
import type { StoreApp } from '@/lib/nostrApps';
import { useNostrApps } from '@/hooks/useNostrApps';
import { useAppSearch } from '@/hooks/useAppSearch';
import { useFeaturedApps } from '@/hooks/useFeaturedApps';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useAuthor } from '@/hooks/useAuthor';
import { useToast } from '@/hooks/useToast';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { AppIcon } from '@/components/desktop/AppIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The App Store: browses NIP-89 app listings published to the user's relays
 * and installs any of them as a desktop web app in one click.
 *
 * The landing page leads with a featured rail — apps by the members of a
 * curated follow pack (useFeaturedApps) — presented App Store-style: a hero
 * card, a horizontally scrolling shelf, then the full catalog grid. Typing
 * in the search box switches to NIP-50 relay search (useAppSearch, routed to
 * dedicated search relays), merged with instant substring matches from the
 * already-fetched catalog.
 *
 * Installed entries go through the same installWebApp() path as the
 * browser's "install site as app" button, so they land in the launcher,
 * roam via encrypted app data, and get the injected window.nostr bridge.
 */
export function AppStore(_props: AppComponentProps) {
  const catalog = useNostrApps();
  const featured = useFeaturedApps();
  const [search, setSearch] = useState('');

  const rawQuery = search.trim();
  const query = useDebouncedValue(rawQuery, 400);
  const searching = rawQuery.length > 0;
  const results = useAppSearch(query);
  const searchPending = searching && (rawQuery !== query || results.isFetching);

  // Instant substring matches from the already-fetched catalog; relay
  // relevance results lead once they arrive, deduped by address.
  const searchMatches = useMemo(() => {
    if (!searching) return [];
    const q = rawQuery.toLowerCase();
    const local = (catalog.data ?? []).filter((app) => {
      const haystack = [app.name, app.about, app.website, ...app.hashtags]
        .join('\u0000')
        .toLowerCase();
      return haystack.includes(q);
    });
    const seen = new Set<string>();
    const merged: StoreApp[] = [];
    for (const app of [...(results.data ?? []), ...local]) {
      if (seen.has(app.address)) continue;
      seen.add(app.address);
      merged.push(app);
    }
    return merged;
  }, [searching, rawQuery, catalog.data, results.data]);

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
          onClick={() => {
            catalog.refetch();
            featured.refetch();
          }}
          disabled={catalog.isLoading || catalog.isRefetching || featured.isRefetching}
          aria-label="Refresh catalog"
          title="Refresh catalog"
        >
          <RefreshCw
            className={catalog.isRefetching || featured.isRefetching ? 'size-4 animate-spin' : 'size-4'}
            aria-hidden
          />
        </Button>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6">
          {searching ? (
            <section className="flex flex-col gap-4" aria-label="Search results">
              <SectionHeader title={`Results for “${rawQuery}”`} />
              {searchMatches.length > 0 ? (
                <CatalogGrid apps={searchMatches} />
              ) : searchPending ? (
                <CatalogSkeleton />
              ) : (
                <EmptyState
                  message={`No apps match “${rawQuery}”. Search covers the relay directory and your local catalog.`}
                />
              )}
            </section>
          ) : (
            <>
              <FeaturedSection />
              <section className="flex flex-col gap-4" aria-label="All apps">
                <SectionHeader
                  title="All Apps"
                  subtitle="Every app published to your relays."
                />
                {catalog.isLoading ? (
                  <CatalogSkeleton />
                ) : catalog.isError ? (
                  <EmptyState message="Could not load the app catalog. Check your relay connections and try refreshing." />
                ) : !catalog.data || catalog.data.length === 0 ? (
                  <EmptyState message="No apps found on your relays yet. Try refreshing, or add more relays in Settings." />
                ) : (
                  <CatalogGrid apps={catalog.data} />
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The curated landing rail: hero card + horizontally scrolling shelf. */
function FeaturedSection() {
  const { data: featured, isLoading } = useFeaturedApps();

  if (isLoading) return <FeaturedSkeleton />;
  if (!featured || featured.apps.length === 0) return null;

  const [hero, ...shelf] = featured.apps;

  return (
    <section className="flex flex-col gap-4" aria-label="Featured apps">
      <FeaturedHero app={hero} />
      {shelf.length > 0 && (
        <>
          <SectionHeader title={featured.title} subtitle={featured.description} />
          <div className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2">
            {shelf.map((app) => (
              <ShelfCard key={app.address} app={app} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** The big editorial card at the top of the landing page. */
function FeaturedHero({ app }: { app: StoreApp }) {
  const hostname = useMemo(() => new URL(app.website).hostname, [app.website]);

  return (
    <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary to-primary/75 p-6 text-primary-foreground shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-foreground/70">
        Featured
      </p>
      <div className="mt-4 flex items-center gap-4">
        <AppIcon
          icon={app.picture ?? ''}
          className="size-20 shrink-0 rounded-[1.25rem] border border-white/20 bg-white/10 object-cover shadow-lg"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-2xl font-bold tracking-tight" title={app.name}>
            {app.name}
          </h2>
          <p className="truncate text-sm text-primary-foreground/70" title={hostname}>
            {hostname}
          </p>
        </div>
        <GetPill app={app} onHero />
      </div>
      <p className="mt-4 line-clamp-2 max-w-prose text-sm text-primary-foreground/85">
        {app.about}
      </p>
    </div>
  );
}

/** A compact card in the horizontally scrolling featured shelf. */
function ShelfCard({ app }: { app: StoreApp }) {
  const hostname = useMemo(() => new URL(app.website).hostname, [app.website]);

  return (
    <div className="flex w-64 shrink-0 snap-start flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-shadow motion-safe:hover:shadow-md">
      <div className="flex items-center gap-3">
        <AppIcon
          icon={app.picture ?? ''}
          className="size-14 shrink-0 rounded-2xl border border-border object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" title={app.name}>
            {app.name}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={hostname}>
            {hostname}
          </p>
        </div>
      </div>
      <p className="line-clamp-3 flex-1 text-sm text-muted-foreground">{app.about}</p>
      <GetPill app={app} className="self-start" />
    </div>
  );
}

function CatalogGrid({ apps }: { apps: StoreApp[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {apps.map((app) => (
        <StoreAppCard key={app.address} app={app} />
      ))}
    </div>
  );
}

/** One catalog entry: icon, name, publisher, blurb, and the Get button. */
function StoreAppCard({ app }: { app: StoreApp }) {
  const author = useAuthor(app.pubkey);

  const publisher =
    author.data?.metadata?.name ??
    author.data?.metadata?.display_name ??
    `${nip19.npubEncode(app.pubkey).slice(0, 12)}…`;
  const hostname = useMemo(() => new URL(app.website).hostname, [app.website]);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-shadow motion-safe:hover:shadow-md">
      <div className="flex items-center gap-3">
        <AppIcon
          icon={app.picture ?? ''}
          className="size-14 shrink-0 rounded-2xl border border-border object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" title={app.name}>
            {app.name}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={hostname}>
            {hostname} · by {publisher}
          </p>
        </div>
        <GetPill app={app} />
      </div>

      <p className="line-clamp-2 min-h-10 flex-1 text-sm text-muted-foreground">
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
    </div>
  );
}

/**
 * The App Store-style pill button: "Get" installs the app, flipping to
 * "Open" once it's in the launcher.
 */
function GetPill({
  app,
  onHero = false,
  className,
}: {
  app: StoreApp;
  /** Renders the inverted variant for the hero card's gradient background. */
  onHero?: boolean;
  className?: string;
}) {
  const { installWebApp, findWebAppByUrl } = useInstalledApps();
  const { open: openApp } = useWindowActions();
  const { toast } = useToast();

  const installed = findWebAppByUrl(app.website);

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
    <Button
      size="sm"
      variant="secondary"
      onClick={installed ? () => openApp(installed.id) : install}
      aria-label={installed ? `Open ${app.name}` : `Install ${app.name}`}
      className={cn(
        'h-8 shrink-0 rounded-full px-5 font-semibold',
        onHero
          ? 'bg-primary-foreground text-primary hover:bg-primary-foreground/90'
          : 'bg-secondary text-primary hover:bg-secondary/80',
        className,
      )}
    >
      {installed ? 'Open' : 'Get'}
    </Button>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      {subtitle && (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{subtitle}</p>
      )}
    </div>
  );
}

function FeaturedSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border bg-card p-6">
        <Skeleton className="h-3 w-20" />
        <div className="mt-4 flex items-center gap-4">
          <Skeleton className="size-20 shrink-0 rounded-[1.25rem]" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-6 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-8 w-20 rounded-full" />
        </div>
        <Skeleton className="mt-4 h-4 w-3/4" />
      </div>
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={i}
            className="flex w-64 shrink-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="size-14 shrink-0 rounded-2xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
            <Skeleton className="h-8 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="size-14 shrink-0 rounded-2xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
            <Skeleton className="h-8 w-16 rounded-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="grid place-items-center py-8">
      <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
        <Store className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
