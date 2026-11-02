import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, ChevronLeft, Copy, FolderPlus, Globe, RefreshCw, Search } from 'lucide-react';
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
import { useStoreAppListing } from '@/hooks/useStoreAppListing';
import { useAuthor } from '@/hooks/useAuthor';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { AppIcon } from '@/components/desktop/AppIcon';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, MoreSentinel, SectionHeader } from '@/components/desktop/apps/appstore/common';
import { useSeen } from '@/components/desktop/apps/appstore/useSeen';
import { FolderAppDetail, FolderAppsSection } from '@/components/desktop/apps/appstore/FolderApps';
import { useChooseAppFolder } from '@/hooks/useChooseAppFolder';
import { canAddFileApps, type OpenedFolder } from '@/lib/fileApps';
import { ThemeStore, type ThemeAddress } from '@/components/desktop/apps/appstore/ThemeStore';
import { PackageStore } from '@/components/desktop/apps/appstore/PackageStore';
import { useThemeCatalog } from '@/hooks/useThemes';
import { usePackageCatalog } from '@/hooks/useThemePackages';
import { parseThemeNaddr } from '@/lib/themeDefinition';
import { parsePackageNaddr, type PackageAddress, type PackageType } from '@/lib/themePackages';
import { isSkinFileName } from '@/lib/skinPackages';
import { PublishThemePackage, type PublishTarget } from '@/components/desktop/apps/PublishThemePackage';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const APP_STORE_ICON = '/icons/apps/app-store.png';

/** Opens a site's detail page; provided by AppStore to every card. */
const SelectAppContext = createContext<(app: StoreApp) => void>(() => {});

type StoreTab = 'apps' | 'themes' | 'cursors' | 'icons' | 'skins';

const TABS: { id: StoreTab; name: string; search: string }[] = [
  { id: 'apps', name: 'Apps', search: 'Search apps, or paste an address' },
  { id: 'themes', name: 'Themes', search: 'Search themes, or paste an address' },
  { id: 'cursors', name: 'Cursors', search: 'Search cursors, or paste an address' },
  { id: 'icons', name: 'Icons', search: 'Search icon sets, or paste an address' },
  { id: 'skins', name: 'Skins', search: 'Search skins, or paste an address' },
];

/** The tab each kind of published theme is in, and back. */
const PACKAGE_TABS: Record<PackageType, StoreTab> = { cursor: 'cursors', icon: 'icons', skin: 'skins' };
const TAB_PACKAGES: Partial<Record<StoreTab, PackageType>> = { cursors: 'cursor', icons: 'icon', skins: 'skin' };

/** The skin file a launch asks to publish: a name in the Media Player's skins folder, never a path. */
function skinToPublish(params: AppComponentProps['params']): PublishTarget | null {
  const name = params?.publishSkin;
  if (typeof name !== 'string' || !isSkinFileName(name)) return null;
  return { type: 'skin', id: name, name: name.replace(/\.[^.]+$/, '').replace(/_/g, ' ') };
}

/** The tab a launch opens on: the one asked for, or the one an address it names is in. */
function initialTab(params: AppComponentProps['params'], pkg: PackageAddress | null): StoreTab {
  if (pkg) return PACKAGE_TABS[pkg.type];
  if (skinToPublish(params)) return 'skins';
  if (typeof params?.theme === 'string') return 'themes';
  return TABS.some((t) => t.id === params?.tab) ? (params?.tab as StoreTab) : 'apps';
}

/**
 * The App Store, in categories picked in the title bar: Apps, Themes (see
 * ThemeStore), and Cursors, Icons and Media Player Skins (see PackageStore).
 * Launch params `{ tab: 'themes' | 'cursors' | 'icons' | 'skins' }` open on
 * a category, `{ theme: 'naddr1…' }` on one theme's page, and
 * `{ package: 'naddr1…' }` on one cursor theme's, icon set's or skin's.
 * `{ publishSkin: '<file name>' }`, which the Media Player sends, opens
 * Skins with Publish to Nostr… for that file in its skins folder, since an
 * app can't sign or upload itself.
 *
 * Apps are nsites (NIP-5A static websites), installed in one click.
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
 *
 * Apps can also come from a folder on this computer (src/lib/fileApps.ts),
 * for developing one: the title bar's folder button, or the From Your
 * Folders section, picks it and opens its page (FolderApps).
 */
export function AppStore({ params }: AppComponentProps) {
  const catalog = useNsiteCatalog();
  const featured = useFeaturedApps();
  const [selectedPackage, setSelectedPackage] = useState<PackageAddress | null>(() =>
    typeof params?.package === 'string' ? parsePackageNaddr(params.package) : null,
  );
  const [tab, setTab] = useState<StoreTab>(() => initialTab(params, selectedPackage));
  const themes = useThemeCatalog(tab === 'themes');
  const cursors = usePackageCatalog('cursor', tab === 'cursors');
  const icons = usePackageCatalog('icon', tab === 'icons');
  const skins = usePackageCatalog('skin', tab === 'skins');
  const packageType = TAB_PACKAGES[tab] ?? null;
  const packages = packageType === 'cursor' ? cursors : packageType === 'icon' ? icons : packageType === 'skin' ? skins : null;
  const [publishing, setPublishing] = useState<PublishTarget | null>(() => skinToPublish(params));
  const [search, setSearch] = useState('');
  // The site whose detail page is showing. The list stays mounted underneath
  // so going back returns to the same scroll position.
  const [selected, setSelected] = useState<StoreApp | null>(null);
  const [selectedTheme, setSelectedTheme] = useState<ThemeAddress | null>(() =>
    typeof params?.theme === 'string' ? parseThemeNaddr(params.theme) : null,
  );
  // A folder chosen to add as an app, whose page is showing.
  const [folderApp, setFolderApp] = useState<OpenedFolder | null>(null);
  const { choose: chooseAppFolder, busy: choosingFolder } = useChooseAppFolder();
  const onThemes = tab === 'themes';
  const onPackages = packages !== null;
  const detailOpen = onThemes ? !!selectedTheme : onPackages ? !!selectedPackage : !!selected || !!folderApp;
  const closeDetail = () => {
    setSelected(null);
    setFolderApp(null);
    setSelectedTheme(null);
    setSelectedPackage(null);
  };
  const searchLabel = TABS.find((t) => t.id === tab)?.search ?? '';

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
  const refetchThemes = themes.refresh;
  const refetchPackages = packages?.refresh;
  const refreshing = onThemes
    ? themes.refreshing
    : packages
      ? packages.refreshing
      : catalog.refreshing || featured.isRefetching;
  const refreshDisabled = (onThemes ? themes.isLoading : packages ? packages.isLoading : catalog.isLoading) || refreshing;
  useEffect(() => {
    setTitlebar(
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        {detailOpen && (
          <button
            type="button"
            data-window-no-drag
            onClick={closeDetail}
            aria-label={`Back to all ${(TABS.find((t) => t.id === tab)?.name ?? 'apps').toLowerCase()}`}
            title="Back"
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
        )}
        <AppIcon icon={APP_STORE_ICON} className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-[family-name:var(--font-title)] text-sm font-medium text-foreground/90">
          App Store
        </span>
        <div
          data-window-no-drag
          role="tablist"
          aria-label="Categories"
          className="mr-auto flex shrink-0 rounded-md bg-foreground/5 p-0.5"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {TABS.map(({ id, name }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                if (tab === id) return;
                setTab(id);
                setSearch('');
                setSelectedPackage(null);
              }}
              className={cn(
                'rounded px-2.5 py-0.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tab === id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {name}
            </button>
          ))}
        </div>
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
              closeDetail();
            }}
            placeholder={searchLabel}
            aria-label={searchLabel}
            autoComplete="off"
            spellCheck={false}
            className="h-7 pl-7 text-sm md:text-sm"
          />
        </div>
        {tab === 'apps' && canAddFileApps() && (
          <button
            type="button"
            onClick={() => {
              void chooseAppFolder().then((opened) => {
                if (!opened) return;
                setSelected(null);
                setFolderApp(opened);
              });
            }}
            disabled={choosingFolder}
            aria-label="Add an app from a folder"
            title="Add an App from a Folder…"
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <FolderPlus className="size-4" aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (onThemes) {
              void refetchThemes();
              return;
            }
            if (refetchPackages) {
              void refetchPackages();
              return;
            }
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
  }, [
    setTitlebar,
    tab,
    onThemes,
    detailOpen,
    search,
    searchLabel,
    refetchCatalog,
    refetchFeatured,
    refetchThemes,
    refetchPackages,
    refreshing,
    refreshDisabled,
    chooseAppFolder,
    choosingFolder,
  ]);
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

  if (packages && packageType) {
    return (
      <div className="flex h-full w-full flex-col bg-background text-foreground">
        <PackageStore
          key={tab}
          type={packageType}
          catalog={packages}
          search={search}
          selected={selectedPackage}
          onSelect={setSelectedPackage}
        />
        <PublishThemePackage target={publishing} onClose={() => setPublishing(null)} />
      </div>
    );
  }

  if (onThemes) {
    return (
      <div className="flex h-full w-full flex-col bg-background text-foreground">
        <ThemeStore
          catalog={themes}
          search={search}
          selected={selectedTheme}
          onSelect={setSelectedTheme}
        />
      </div>
    );
  }

  return (
    <SelectAppContext.Provider value={setSelected}>
      <div
        className="flex h-full w-full flex-col bg-background text-foreground"
        onKeyDown={(e) => {
          if ((selected || folderApp) && e.key === 'Escape') {
            closeDetail();
          }
        }}
      >
        {selected && (
          <AppDetail key={selected.host} app={selected} moreFromPublisher={moreFromPublisher} />
        )}
        {folderApp && !selected && <FolderAppDetail key={folderApp.appId} opened={folderApp} />}
        {/* Content */}
        <div className={cn('min-h-0 flex-1 overflow-y-auto', (selected || folderApp) && 'hidden')}>
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
                <FolderAppsSection onChose={setFolderApp} />
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
const ShelfCard = memo(function ShelfCard({ app }: { app: StoreApp }) {
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
});

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

/**
 * One catalog entry: icon, name, publisher, blurb, and the Get button.
 * Memoized: every site the catalog checks re-renders the store, and a card's
 * StoreApp stays the same object until its manifest changes.
 */
const StoreAppCard = memo(function StoreAppCard({ app }: { app: StoreApp }) {
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
});

/**
 * A site's detail page: the screenshots and categories its web app manifest
 * declares, the full blurb, who published it, its address, and the
 * publisher's other sites. Opening it in the browser previews the site
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
  const listing = useStoreAppListing(app);
  const openUrl = useOpenUrl();
  const [copied, setCopied] = useState(false);

  // The publisher's hashtags, then the manifest's own categories.
  const tags = useMemo(() => {
    const seen = new Set<string>();
    return [...app.hashtags, ...(listing.data?.categories ?? [])].filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [app.hashtags, listing.data]);
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
        <Screenshots app={app} name={view.name} />

        {view.about ? (
          <p className="max-w-prose whitespace-pre-line text-base leading-relaxed">{view.about}</p>
        ) : (
          <p className="text-muted-foreground">This site doesn’t describe itself.</p>
        )}

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
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

/**
 * The screenshots a site's web app manifest declares, in a scrolling shelf;
 * clicking one shows it full size. Nothing shows for a site that has none.
 */
function Screenshots({ app, name }: { app: StoreApp; name: string }) {
  const { data, isPending } = useStoreAppListing(app);
  const [open, setOpen] = useState<number | null>(null);
  // How many of each screenshot's URLs have failed to load, by index.
  const [failed, setFailed] = useState<Record<number, number>>({});

  if (isPending) {
    return (
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="aspect-video h-56 shrink-0 rounded-xl" />
        ))}
      </div>
    );
  }
  // Each shot at the first of its URLs that hasn't failed; one with none left is dropped.
  const shots = (data?.screenshots ?? []).flatMap((shot, i) => {
    const src = [shot.src, ...shot.fallbacks][failed[i] ?? 0];
    return src ? [{ ...shot, src, index: i }] : [];
  });
  if (!shots.length) return null;

  const current = open === null ? null : (shots[open] ?? null);
  const fail = (index: number) => setFailed((prev) => ({ ...prev, [index]: (prev[index] ?? 0) + 1 }));

  return (
    <section className="flex flex-col gap-4" aria-label="Screenshots">
      <SectionHeader title="Screenshots" />
      <div className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2">
        {shots.map((shot, i) => (
          <button
            key={shot.index}
            type="button"
            onClick={() => setOpen(i)}
            aria-label={`View screenshot ${i + 1} of ${name} full size`}
            title={shot.label ?? undefined}
            className="shrink-0 snap-start overflow-hidden rounded-xl border border-border bg-muted shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <img
              key={shot.src}
              src={shot.src}
              alt={shot.label ?? `Screenshot ${i + 1} of ${name}`}
              width={shot.width ?? undefined}
              height={shot.height ?? undefined}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => fail(shot.index)}
              className={cn(
                'block w-auto max-w-none object-contain',
                shot.formFactor === 'narrow' ? 'h-80' : 'h-56',
              )}
            />
          </button>
        ))}
      </div>

      <Dialog open={current !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent
          className="max-h-[calc(100%-2rem)] gap-3 p-3 sm:max-w-[min(calc(100%-2rem),72rem)]"
          // Escape closes this, not the detail page underneath.
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.stopPropagation();
            if (open === null) return;
            if (e.key === 'ArrowRight') setOpen((open + 1) % shots.length);
            if (e.key === 'ArrowLeft') setOpen((open - 1 + shots.length) % shots.length);
          }}
        >
          <DialogTitle className="pr-8 text-sm font-medium">
            {current?.label ?? `${name}, screenshot ${(open ?? 0) + 1} of ${shots.length}`}
          </DialogTitle>
          {current && (
            <img
              key={current.src}
              src={current.src}
              alt={current.label ?? ''}
              referrerPolicy="no-referrer"
              onError={() => fail(current.index)}
              className="max-h-[calc(100vh-8rem)] w-full rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
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
