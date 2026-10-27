import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, ChevronLeft, Copy, Globe, RefreshCw, Search, Store } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import type { StoreApp } from '@/lib/nsiteCatalog';
import { canonicalNsiteUrl } from '@/lib/nsite';
import { nsiteAppId } from '@/lib/nsiteApps';
import { getNsiteStore } from '@/lib/nsiteStore';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { isWebviewAvailable } from '@/lib/isElectron';
import { useNsiteCatalog } from '@/hooks/useNsiteCatalog';
import { useNsiteLookup } from '@/hooks/useNsiteLookup';
import { useFeaturedApps } from '@/hooks/useFeaturedApps';
import { useStoreAppDetails } from '@/hooks/useStoreAppDetails';
import { useAuthor } from '@/hooks/useAuthor';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { AppIcon } from '@/components/desktop/AppIcon';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const APP_STORE_ICON = '/icons/apps/app-store.png';

/** Opens a site's detail page; provided by AppStore to every card. */
const SelectAppContext = createContext<(app: StoreApp) => void>(() => {});

/**
 * The App Store: browses nsites (NIP-5A static websites), the only kind of
 * app it offers, and installs any of them in one click.
 *
 * The catalog is Tenna's: the sites a known set of publishers put on Nostr
 * plus whatever the user and the people they follow publish
 * (useNsiteCatalog), kept on disk so the store opens on it at once, and
 * listing only sites already checked to be installable apps. The landing page leads with a featured rail, the
 * packaged apps of a curated follow pack's members (useFeaturedApps),
 * presented App Store-style: a hero card, a horizontally scrolling shelf,
 * then the full catalog grid. Typing in the search box filters the catalog;
 * pasting a site's address (`npub1…`, `naddr1…`, or an nsite:// URL) looks
 * that site up instead (useNsiteLookup).
 *
 * Each card reads the site's icon and name from its own files on Blossom
 * (useStoreAppDetails), the same derivation the launcher uses, so the store
 * shows the icon the user will get. Installing goes through the same
 * installNsiteApp() path as the browser's "install site as app" button: the
 * nsite store downloads every file, and the entry roams via encrypted app
 * data.
 */
export function AppStore(_props: AppComponentProps) {
  const catalog = useNsiteCatalog();
  const featured = useFeaturedApps();
  const [search, setSearch] = useState('');
  // The site whose detail page is showing. The list stays mounted underneath
  // so going back returns to the same scroll position.
  const [selected, setSelected] = useState<StoreApp | null>(null);

  const rawQuery = search.trim();
  const searching = rawQuery.length > 0;
  const lookup = useNsiteLookup(rawQuery);

  const searchMatches = useMemo(() => {
    if (!searching) return [];
    if (lookup.isAddress) return lookup.data ? [lookup.data] : [];
    const q = rawQuery.toLowerCase();
    const seen = new Set<string>();
    const matches: StoreApp[] = [];
    for (const app of [...(featured.data?.apps ?? []), ...catalog.allApps]) {
      if (seen.has(app.host)) continue;
      seen.add(app.host);
      const haystack = [app.name ?? '', app.about, app.dtag ?? '', ...app.hashtags]
        .join('\u0000')
        .toLowerCase();
      if (haystack.includes(q)) matches.push(app);
    }
    return matches;
  }, [searching, rawQuery, lookup.isAddress, lookup.data, featured.data, catalog.allApps]);

  const searchPending = lookup.isAddress ? lookup.isLoading : catalog.isLoading;

  // Search and refresh go in the window's own title bar, so there is one bar
  // on top rather than two.
  const setTitlebar = useWindowTitlebar();
  const refetchCatalog = catalog.refresh;
  const refetchFeatured = featured.refetch;
  const refreshing = catalog.refreshing || featured.isRefetching;
  const refreshDisabled = catalog.isLoading || refreshing;
  useEffect(() => {
    setTitlebar(
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        {selected && (
          <button
            type="button"
            data-window-no-drag
            onClick={() => setSelected(null)}
            aria-label="Back to all apps"
            title="Back"
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
        )}
        <AppIcon icon={APP_STORE_ICON} className="size-4 shrink-0 text-muted-foreground" />
        <span className="mr-auto truncate font-[family-name:var(--font-title)] text-sm font-medium text-foreground/90">
          App Store
        </span>
        <div
          data-window-no-drag
          className="relative w-full max-w-64 min-w-0"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected(null);
            }}
            placeholder="Search apps, or paste an address"
            aria-label="Search apps, or paste an address"
            autoComplete="off"
            spellCheck={false}
            className="h-7 pl-7 text-sm md:text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            refetchCatalog();
            refetchFeatured();
          }}
          disabled={refreshDisabled}
          aria-label="Refresh catalog"
          title="Refresh catalog"
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} aria-hidden />
        </button>
      </div>,
    );
  }, [setTitlebar, search, selected, refetchCatalog, refetchFeatured, refreshing, refreshDisabled]);
  useEffect(() => () => setTitlebar(null), [setTitlebar]);

  const moreFromPublisher = useMemo(() => {
    if (!selected) return [];
    const seen = new Set([selected.host]);
    const apps: StoreApp[] = [];
    for (const app of [...(featured.data?.apps ?? []), ...catalog.allApps]) {
      if (app.pubkey !== selected.pubkey || seen.has(app.host)) continue;
      seen.add(app.host);
      apps.push(app);
    }
    return apps;
  }, [selected, featured.data, catalog.allApps]);

  return (
    <SelectAppContext.Provider value={setSelected}>
      <div
        className="flex h-full w-full flex-col bg-background text-foreground"
        onKeyDown={(e) => {
          if (selected && e.key === 'Escape') {
            setSelected(null);
          }
        }}
      >
        {selected && (
          <AppDetail key={selected.host} app={selected} moreFromPublisher={moreFromPublisher} />
        )}
        {/* Content */}
        <div className={cn('min-h-0 flex-1 overflow-y-auto', selected && 'hidden')}>
          <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6">
            {searching ? (
              <section className="flex flex-col gap-4" aria-label="Search results">
                <SectionHeader
                  title={lookup.isAddress ? 'Site at this address' : `Results for “${rawQuery}”`}
                />
                {searchMatches.length > 0 ? (
                  // A pasted address asks for that one site, so it shows
                  // whether or not the store would list it.
                  <CatalogGrid apps={searchMatches} />
                ) : searchPending ? (
                  <CatalogSkeleton />
                ) : (
                  <EmptyState
                    message={
                      lookup.isAddress
                        ? 'No site is published at that address on your relays.'
                        : `No apps match “${rawQuery}”. You can also paste a site’s address to find it.`
                    }
                  />
                )}
              </section>
            ) : (
              <>
                <FeaturedSection />
                <section className="flex flex-col gap-4" aria-label="All apps">
                  <SectionHeader
                    title="All Apps"
                    subtitle="Sites from Din’s publishers and the people you follow."
                  />
                  {catalog.isLoading ? (
                    <CatalogSkeleton />
                  ) : catalog.isError ? (
                    <EmptyState message="Could not load the app catalog. Check your relay connections and try refreshing." />
                  ) : catalog.apps.length === 0 && !catalog.hasMore ? (
                    <EmptyState message="No apps found on your relays yet. Try refreshing, or add more relays in Settings." />
                  ) : (
                    <>
                      <CatalogGrid apps={catalog.apps} />
                      {catalog.hasMore && (
                        <MoreSentinel
                          onReached={catalog.loadMore}
                          paused={catalog.isLoadingMore}
                        />
                      )}
                    </>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </SelectAppContext.Provider>
  );
}

/**
 * Whether an element has come on screen, latching true. Cards read their
 * site's files from Blossom, so they wait until someone can see them.
 */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

/**
 * The bottom of the list: loads the next page while it is on screen, once
 * the last one has been fetched and checked.
 */
function MoreSentinel({ onReached, paused }: { onReached: () => void; paused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (visible && !paused) onReached();
  }, [visible, paused, onReached]);
  return (
    <div ref={ref} aria-hidden className="flex justify-center py-2">
      {paused && <RefreshCw className="size-4 animate-spin text-muted-foreground" />}
    </div>
  );
}

/** Everything a card shows of a site, from its manifest, its files, and its author. */
function useStoreAppView(app: StoreApp, enabled = true) {
  const details = useStoreAppDetails(app, enabled);
  const author = useAuthor(enabled ? app.pubkey : undefined);
  const metadata = author.data?.metadata;
  const publisher = (metadata?.display_name || metadata?.name)?.trim() || null;

  // The site's own name for itself beats its manifest's; a site that says
  // neither is named after whoever published it.
  const name = details.data?.name ?? app.name ?? publisher ?? `${app.host.slice(0, 12)}…`;
  const about = app.about || details.data?.description || '';
  const by = publisher && publisher.toLowerCase() !== name.toLowerCase() ? publisher : null;

  return {
    name,
    about,
    by,
    publisher,
    picture: metadata?.picture ? sanitizeImageUrl(metadata.picture) : null,
    icon: details.data?.icon ?? null,
    iconPending: details.isPending,
    themeColor: details.data?.themeColor ?? null,
  };
}

/**
 * Makes a whole card open the site's detail page: a button stretched over the
 * card, under the Get pill (which sits above it with `relative z-10`).
 */
function CardLink({ app, name }: { app: StoreApp; name: string }) {
  const select = useContext(SelectAppContext);
  return (
    <button
      type="button"
      onClick={() => select(app)}
      aria-label={`View details for ${name}`}
      className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    />
  );
}

/**
 * A site's icon: the raster its own files declare (squircle-cut when it is
 * full-bleed, see nsiteAppInfo), a skeleton while it loads, or a tile with
 * the site's initial when it ships none.
 */
function StoreAppIcon({
  name,
  icon,
  pending,
  className,
}: {
  name: string;
  icon: string | null;
  pending: boolean;
  className?: string;
}) {
  if (icon) return <AppIcon icon={icon} className={cn('object-contain', className)} />;
  if (pending) return <Skeleton className={cn('rounded-[28%]', className)} />;
  const initial = name.match(/\p{L}|\p{N}/u)?.[0]?.toUpperCase() ?? '?';
  return (
    <span
      aria-hidden
      className={cn(
        'grid place-items-center rounded-[28%] bg-gradient-to-br from-primary to-primary/70 text-2xl font-semibold text-primary-foreground',
        className,
      )}
    >
      {initial}
    </span>
  );
}

/** The curated landing rail: hero card + horizontally scrolling shelf. */
function FeaturedSection() {
  const { data: featured, isLoading } = useFeaturedApps();

  if (isLoading) return <FeaturedSkeleton />;
  if (!featured) return null;

  const [hero, ...shelf] = featured.apps;

  return (
    <section className="flex flex-col gap-4" aria-label="Featured apps">
      <FeaturedHero app={hero} />
      {shelf.length > 0 && (
        <>
          <SectionHeader title={featured.title} subtitle={featured.description} />
          <div className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2">
            {shelf.map((app) => (
              <ShelfCard key={app.host} app={app} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** The big editorial card at the top of the landing page. */
function FeaturedHero({ app }: { app: StoreApp }) {
  const view = useStoreAppView(app);

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary to-primary/75 p-6 text-primary-foreground shadow-sm">
      <CardLink app={app} name={view.name} />
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-foreground/70">
        Featured
      </p>
      <div className="mt-4 flex items-center gap-4">
        <StoreAppIcon
          name={view.name}
          icon={view.icon}
          pending={view.iconPending}
          className="size-20 shrink-0 drop-shadow-lg"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-2xl font-bold tracking-tight" title={view.name}>
            {view.name}
          </h2>
          {view.by && (
            <p className="truncate text-sm text-primary-foreground/70" title={view.by}>
              by {view.by}
            </p>
          )}
        </div>
        <GetPill app={app} name={view.name} onHero />
      </div>
      {view.about && (
        <p className="mt-4 line-clamp-2 max-w-prose text-sm text-primary-foreground/85">
          {view.about}
        </p>
      )}
    </div>
  );
}

/** A compact card in the horizontally scrolling featured shelf. */
function ShelfCard({ app }: { app: StoreApp }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const view = useStoreAppView(app, seen);

  return (
    <div
      ref={ref}
      className="relative flex w-64 shrink-0 snap-start flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-shadow motion-safe:hover:shadow-md"
    >
      <CardLink app={app} name={view.name} />
      <div className="flex items-center gap-3">
        <StoreAppIcon
          name={view.name}
          icon={view.icon}
          pending={view.iconPending}
          className="size-14 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" title={view.name}>
            {view.name}
          </p>
          {view.by && (
            <p className="truncate text-xs text-muted-foreground" title={view.by}>
              by {view.by}
            </p>
          )}
        </div>
      </div>
      <p className="line-clamp-3 flex-1 text-sm text-muted-foreground">{view.about}</p>
      <GetPill app={app} name={view.name} className="self-start" />
    </div>
  );
}

/** The catalog's cards. */
function CatalogGrid({ apps }: { apps: StoreApp[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {apps.map((app) => (
        <StoreAppCard key={app.host} app={app} />
      ))}
    </div>
  );
}

/** One catalog entry: icon, name, publisher, blurb, and the Get button. */
function StoreAppCard({ app }: { app: StoreApp }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const view = useStoreAppView(app, seen);

  return (
    <div
      ref={ref}
      className="relative flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-shadow motion-safe:hover:shadow-md"
    >
      <CardLink app={app} name={view.name} />
      <div className="flex items-center gap-3">
        <StoreAppIcon
          name={view.name}
          icon={view.icon}
          pending={view.iconPending}
          className="size-14 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" title={view.name}>
            {view.name}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={view.by ?? undefined}>
            {view.by ? `by ${view.by}` : 'nsite'}
          </p>
        </div>
        <GetPill app={app} name={view.name} />
      </div>

      <p className="line-clamp-2 min-h-10 flex-1 text-sm text-muted-foreground">
        {view.about}
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
 * A site's detail page: the full blurb, who published it, its address, and
 * the publisher's other sites. Opening it in the browser previews the site
 * without installing it.
 */
function AppDetail({
  app,
  moreFromPublisher,
}: {
  app: StoreApp;
  moreFromPublisher: StoreApp[];
}) {
  const view = useStoreAppView(app);
  const openUrl = useOpenUrl();
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const address = canonicalNsiteUrl(app.pubkey, app.dtag, '/');
  const fileCount = app.event.tags.filter(([name]) => name === 'path').length;
  const updated = new Date(app.createdAt * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Take focus so Escape goes back without a click first.
  useEffect(() => ref.current?.focus(), []);

  const copyAddress = () => {
    void navigator.clipboard.writeText(address).then(() => setCopied(true));
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-y-auto outline-none"
      aria-label={`${view.name} details`}
    >
      <div
        className="border-b border-border"
        style={
          view.themeColor
            ? { backgroundImage: `linear-gradient(to bottom, ${view.themeColor}33, transparent)` }
            : undefined
        }
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-6 sm:p-6">
          <StoreAppIcon
            name={view.name}
            icon={view.icon}
            pending={view.iconPending}
            className="size-24 shrink-0 text-4xl drop-shadow-md sm:size-28"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="min-w-0">
              <h1 className="break-words text-3xl font-bold tracking-tight">{view.name}</h1>
              {view.publisher && (
                <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                  <Avatar className="size-5">
                    {view.picture && <AvatarImage src={view.picture} alt="" />}
                    <AvatarFallback className="text-[10px]">
                      {view.publisher.slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">{view.publisher}</span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <GetPill app={app} name={view.name} />
              {isWebviewAvailable() && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openUrl(address)}
                  className="h-8 rounded-full px-4"
                >
                  <Globe aria-hidden />
                  Open in Browser
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6">
        {view.about ? (
          <p className="max-w-prose whitespace-pre-line text-base leading-relaxed">{view.about}</p>
        ) : (
          <p className="text-muted-foreground">This site doesn’t describe itself.</p>
        )}

        {app.hashtags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {app.hashtags.map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-secondary px-2 py-0.5 text-sm text-secondary-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        <section className="flex flex-col gap-4" aria-label="Information">
          <SectionHeader title="Information" />
          <dl className="grid grid-cols-1 divide-y divide-border rounded-2xl border border-border bg-card text-sm">
            <InfoRow label="Publisher">{view.publisher ?? 'Unknown'}</InfoRow>
            <InfoRow label="Updated">{updated}</InfoRow>
            <InfoRow label="Files">{fileCount.toLocaleString()}</InfoRow>
            <InfoRow label="Address">
              <span className="flex min-w-0 items-center justify-end gap-2">
                <span className="truncate font-mono text-xs" title={address}>
                  {address}
                </span>
                <button
                  type="button"
                  onClick={copyAddress}
                  aria-label={copied ? 'Address copied' : 'Copy address'}
                  title={copied ? 'Copied' : 'Copy address'}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {copied ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : (
                    <Copy className="size-3.5" aria-hidden />
                  )}
                </button>
              </span>
            </InfoRow>
          </dl>
        </section>

        {moreFromPublisher.length > 0 && (
          <section className="flex flex-col gap-4" aria-label="More from this publisher">
            <SectionHeader
              title={view.publisher ? `More from ${view.publisher}` : 'More from this publisher'}
            />
            <CatalogGrid apps={moreFromPublisher} />
          </section>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/**
 * The App Store-style pill button: "Get" installs the site and launches it,
 * flipping to "Open" once it's in the launcher. nsites install into the OS-level nsite
 * store, so outside the Electron shell there is nothing to install into.
 */
function GetPill({
  app,
  name,
  onHero = false,
  className,
}: {
  app: StoreApp;
  /** What the card calls the app, for the button's label and the toast. */
  name: string;
  /** Renders the inverted variant for the hero card's gradient background. */
  onHero?: boolean;
  className?: string;
}) {
  const { installNsiteApp, findNsiteApp } = useInstalledApps();
  const { open: openApp } = useWindowActions();
  const { toast } = useToast();
  const canInstall = Boolean(getNsiteStore());

  const installed = findNsiteApp(app.host);
  // Set by "Get"; the app launches once it's in the registry, which is a
  // render after installNsiteApp() (open() can't see it any sooner).
  const launchOnInstall = useRef(false);

  useEffect(() => {
    if (!launchOnInstall.current || !installed) return;
    launchOnInstall.current = false;
    openApp(nsiteAppId(app.host));
  }, [installed, openApp, app.host]);

  const install = () => {
    const entry = installNsiteApp(app.host);
    if (!entry) {
      toast({
        title: 'Could not install app',
        description: 'This site’s address is not one Din can install.',
        variant: 'destructive',
      });
      return;
    }
    launchOnInstall.current = true;
    toast({
      title: `${name} installed`,
      description:
        'Find it in the app launcher. Its files are downloading, so it will work offline too.',
    });
  };

  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={installed ? () => openApp(nsiteAppId(app.host)) : install}
      disabled={!installed && !canInstall}
      title={canInstall ? undefined : 'Apps install in the Din desktop app'}
      aria-label={installed ? `Open ${name}` : `Install ${name}`}
      className={cn(
        'relative z-10 h-8 shrink-0 rounded-full px-5 font-semibold',
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
