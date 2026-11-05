import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  MoreVertical,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { EmptyState } from '@/components/desktop/apps/appstore/common';
import { DeleteDialog, ExtensionAccess, InfoRow, PackageContextMenu } from '@/components/desktop/apps/appstore/PackageStore';
import {
  useCopyAddress,
  usePackageAuthor,
  usePackageHandlers,
  type PackageHandlers,
} from '@/components/desktop/apps/appstore/usePackageHandlers';
import { useSeen } from '@/components/desktop/apps/appstore/useSeen';
import { InstalledExtensions, type InstalledExtensionsProps } from '@/components/desktop/apps/InstalledExtensions';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import { useCrxExtensions, useExtensionCatalog, useThemePackage } from '@/hooks/useThemePackages';
import { categoryLabel, type ExtensionPackage } from '@/lib/extensionCatalog';
import { formatBytes } from '@/lib/fs';
import { packageCoordinate, parsePackageNaddr, type PackageAddress, type ThemePackage } from '@/lib/themePackages';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/shared/reducedMotion';

export interface ExtensionsPageProps {
  /** The extension whose page to open on, from a `nostr:` link to one. */
  initial: PackageAddress | null;
  /** What managing the installed ones needs from the browser window. */
  installed: Omit<InstalledExtensionsProps, 'onViewPublished'>;
}

type View = 'discover' | 'installed';

/** How many extensions the featured banner turns through. */
const FEATURED = 5;
/** How long each featured extension shows before the next, when nobody's pointing at it. */
const FEATURE_MS = 7000;

/**
 * about:extensions, laid out like the Chrome Web Store: a top bar with
 * Discover and Installed and a search box; Discover leads with a banner
 * turning through the newest extensions, then category chips and shelves of
 * cards (people the user follows first), and each extension has a page with
 * its screenshots, overview, details and permissions and one big Add to Din
 * button. Installed lists the browser's extensions, from the Web Store, a
 * folder, a .crx file or Nostr, to reload, publish or remove, and the
 * userscripts (InstalledExtensions).
 *
 * The extensions are browser extensions published to Nostr (NIP-82 apps
 * with a .crx, src/lib/extensionCatalog.ts) by Din's publishers, the people
 * the user follows, and the user. An internal page, painted over the tab's
 * parked surface like about:preferences (src/lib/internalPages.ts).
 */
export function ExtensionsPage({ initial, installed }: ExtensionsPageProps) {
  const catalog = useExtensionCatalog();
  const { data: crxInstalled } = useCrxExtensions();
  const [view, setView] = useState<View>('discover');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<PackageAddress | null>(initial);
  const handlers = usePackageHandlers('extension', setSelected);
  const scroller = useRef<HTMLDivElement>(null);

  const packages = catalog.packages as ExtensionPackage[];
  const select = (address: PackageAddress | null) => {
    setSelected(address);
    if (address) setView('discover');
    scroller.current?.scrollTo({ top: 0 });
  };

  return (
    // Opaque, like the settings page: the surface underneath is a white
    // about:blank.
    <div
      className="@container absolute inset-0 flex flex-col bg-background text-foreground"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !selected) return;
        e.stopPropagation();
        select(null);
      }}
    >
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border/60 px-4 py-3 @2xl:px-6">
        <button
          type="button"
          onClick={() => {
            select(null);
            setView('discover');
            setSearch('');
            setCategory(null);
          }}
          className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Extensions home"
        >
          <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-sky-500 via-violet-500 to-fuchsia-500 text-white shadow-sm">
            <Puzzle className="size-5" aria-hidden />
          </span>
          <span className="text-lg font-semibold tracking-tight">Extensions</span>
        </button>
        <nav className="flex items-center gap-1" aria-label="Sections">
          <TopTab active={view === 'discover'} onClick={() => { select(null); setView('discover'); }}>
            Discover
          </TopTab>
          <TopTab active={view === 'installed'} onClick={() => { setSelected(null); setView('installed'); }}>
            Installed
            {crxInstalled && crxInstalled.length > 0 && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{crxInstalled.length}</span>
            )}
          </TopTab>
        </nav>
        <div className="relative ml-auto w-full @2xl:w-80">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected(null);
              setView('discover');
            }}
            placeholder="Search extensions, or paste an address"
            aria-label="Search extensions"
            className="h-10 w-full rounded-full border border-transparent bg-muted pl-10 pr-4 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={() => void catalog.refresh()}
          disabled={catalog.refreshing}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw className={cn(catalog.refreshing && 'motion-safe:animate-spin')} aria-hidden />
        </Button>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-6 @2xl:px-8 @2xl:py-8">
          {selected ? (
            <ExtensionDetail
              key={packageCoordinate(selected)}
              address={selected}
              known={packages.find((pkg) => packageCoordinate(pkg) === packageCoordinate(selected)) ?? null}
              more={packages.filter((pkg) => pkg.pubkey === selected.pubkey && pkg.identifier !== selected.identifier)}
              handlers={handlers}
              onBack={() => select(null)}
              onSelect={select}
            />
          ) : view === 'installed' ? (
            <InstalledExtensions
              {...installed}
              onViewPublished={(naddr) => select(parsePackageNaddr(naddr, 'extension'))}
            />
          ) : (
            <Discover
              packages={packages}
              loading={catalog.isLoading}
              error={catalog.isError}
              search={search.trim()}
              category={category}
              onCategory={setCategory}
              handlers={handlers}
              onSelect={select}
            />
          )}
        </div>
      </div>
      <DeleteDialog handlers={handlers} />
    </div>
  );
}

function TopTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-9 items-center rounded-full px-4 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

function Discover({
  packages,
  loading,
  error,
  search,
  category,
  onCategory,
  handlers,
  onSelect,
}: {
  packages: ExtensionPackage[];
  loading: boolean;
  error: boolean;
  search: string;
  category: string | null;
  onCategory: (category: string | null) => void;
  handlers: PackageHandlers;
  onSelect: (address: PackageAddress) => void;
}) {
  const { user } = useCurrentUser();
  const following = useFollowingPubkeys();
  const address = parsePackageNaddr(search, 'extension');
  const lookup = useThemePackage(address);

  const categories = useMemo(
    () => [...new Set(packages.flatMap((pkg) => pkg.categories))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b))),
    [packages],
  );
  const shown = category ? packages.filter((pkg) => pkg.categories.includes(category)) : packages;
  const [friends, others] = useMemo(() => {
    const close = new Set(following);
    if (user) close.add(user.pubkey);
    return [shown.filter((pkg) => close.has(pkg.pubkey)), shown.filter((pkg) => !close.has(pkg.pubkey))];
  }, [shown, following, user]);

  if (search) {
    const q = search.toLowerCase();
    const matches = address
      ? lookup.data?.type === 'extension' ? [lookup.data] : []
      : packages.filter((pkg) =>
          [pkg.title, pkg.summary, pkg.identifier, ...pkg.categories.map(categoryLabel)].join('\u0000').toLowerCase().includes(q),
        );
    return (
      <Shelf title={address ? 'Extension at this address' : `Results for “${search}”`}>
        {(address ? lookup.isPending : loading && !matches.length) ? (
          <CardGridSkeleton />
        ) : matches.length ? (
          <CardGrid packages={matches} handlers={handlers} onSelect={onSelect} />
        ) : (
          <EmptyState
            message={address ? 'No extension is published at that address on your relays.' : `No extensions match “${search}”. You can also paste an address to find one.`}
          />
        )}
      </Shelf>
    );
  }

  if (loading && !packages.length) {
    return (
      <>
        <Skeleton className="aspect-[21/9] max-h-80 w-full rounded-3xl" />
        <CardGridSkeleton />
      </>
    );
  }
  if (!packages.length) {
    return (
      <EmptyState
        message={error
          ? 'Couldn’t load extensions. Check your relay connections and try refreshing.'
          : 'No extensions found on your relays yet. Publish one from Installed, or follow people who share theirs.'}
      />
    );
  }

  return (
    <>
      {!category && <Featured packages={packages.slice(0, FEATURED)} handlers={handlers} onSelect={onSelect} />}
      {categories.length > 0 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="toolbar" aria-label="Categories">
          <Chip active={category === null} onClick={() => onCategory(null)}>All</Chip>
          {categories.map((c) => (
            <Chip key={c} active={category === c} onClick={() => onCategory(category === c ? null : c)}>
              {categoryLabel(c)}
            </Chip>
          ))}
        </div>
      )}
      {friends.length > 0 && (
        <Shelf title="From people you follow">
          <CardGrid packages={friends} handlers={handlers} onSelect={onSelect} />
        </Shelf>
      )}
      {others.length > 0 && (
        <Shelf title={category ? categoryLabel(category) : friends.length ? 'More extensions' : 'New and updated'}>
          <CardGrid packages={others} handlers={handlers} onSelect={onSelect} />
        </Shelf>
      )}
    </>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'h-9 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}

function Shelf({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4" aria-label={title}>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

/** The banner at the top of Discover: the newest extensions, one at a time, big. */
function Featured({ packages, handlers, onSelect }: { packages: ExtensionPackage[]; handlers: PackageHandlers; onSelect: (address: PackageAddress) => void }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = packages.length;

  useEffect(() => {
    if (paused || count < 2 || prefersReducedMotion()) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), FEATURE_MS);
    return () => clearInterval(timer);
  }, [paused, count]);

  const pkg = packages[index % Math.max(count, 1)];
  if (!pkg) return null;
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Featured"
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <FeaturedSlide key={packageCoordinate(pkg)} pkg={pkg} handlers={handlers} onSelect={onSelect} />
      {count > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous"
            className="absolute left-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-background/90 shadow-md hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next"
            className="absolute right-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-background/90 shadow-md hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight className="size-5" aria-hidden />
          </button>
          <div className="mt-3 flex justify-center gap-2">
            {packages.map((p, i) => (
              <button
                key={packageCoordinate(p)}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show ${p.title}`}
                aria-current={i === index}
                className={cn(
                  'h-2 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  i === index ? 'w-6 bg-primary' : 'w-2 bg-muted-foreground/30 hover:bg-muted-foreground/50',
                )}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function FeaturedSlide({ pkg, handlers, onSelect }: { pkg: ExtensionPackage; handlers: PackageHandlers; onSelect: (address: PackageAddress) => void }) {
  const author = usePackageAuthor(pkg.pubkey);
  const shot = pkg.screenshots[0];
  return (
    <PackageContextMenu pkg={pkg} handlers={handlers}>
      <div className="relative grid overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-sky-500/15 via-violet-500/10 to-fuchsia-500/15 motion-safe:animate-in motion-safe:fade-in @3xl:grid-cols-[1fr_1.2fr]">
        <button
          type="button"
          onClick={() => onSelect(pkg)}
          aria-label={`View ${pkg.title}`}
          className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <div className="pointer-events-none relative flex flex-col justify-center gap-4 p-6 @2xl:p-10">
          <div className="flex items-center gap-3">
            <ExtensionIcon pkg={pkg} className="size-14" />
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {pkg.categories[0] ? categoryLabel(pkg.categories[0]) : 'Extension'}
              </p>
              {author.name && <p className="truncate text-sm text-muted-foreground">by {author.name}</p>}
            </div>
          </div>
          <h2 className="text-3xl font-bold leading-tight tracking-tight @2xl:text-4xl">{pkg.title}</h2>
          {pkg.summary && <p className="line-clamp-3 max-w-prose text-base text-muted-foreground">{pkg.summary}</p>}
          <div className="pointer-events-auto relative z-10">
            <AddButton pkg={pkg} handlers={handlers} />
          </div>
        </div>
        <div className="pointer-events-none relative hidden min-h-64 items-center justify-center p-6 @3xl:flex">
          {shot ? (
            <img
              src={shot}
              alt=""
              referrerPolicy="no-referrer"
              draggable={false}
              className="max-h-72 w-full rounded-2xl object-cover shadow-xl ring-1 ring-black/5"
            />
          ) : (
            <ExtensionIcon pkg={pkg} className="size-40 drop-shadow-xl" />
          )}
        </div>
      </div>
    </PackageContextMenu>
  );
}

function CardGrid({ packages, handlers, onSelect }: { packages: ExtensionPackage[]; handlers: PackageHandlers; onSelect: (address: PackageAddress) => void }) {
  return (
    <div className="grid grid-cols-1 gap-x-5 gap-y-8 @2xl:grid-cols-2 @5xl:grid-cols-3 @7xl:grid-cols-4">
      {packages.map((pkg) => (
        <ExtensionCard key={packageCoordinate(pkg)} pkg={pkg} handlers={handlers} onSelect={onSelect} />
      ))}
    </div>
  );
}

/** A store card: its screenshot (or icon) as a tile, then its icon, name, author and category. */
function ExtensionCard({ pkg, handlers, onSelect }: { pkg: ExtensionPackage; handlers: PackageHandlers; onSelect: (address: PackageAddress) => void }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const author = usePackageAuthor(seen ? pkg.pubkey : undefined);
  const state = handlers.stateOf(pkg);
  const shot = pkg.screenshots[0];

  return (
    <PackageContextMenu pkg={pkg} handlers={handlers}>
      <div ref={ref} className="group relative flex flex-col gap-3">
        <button
          type="button"
          onClick={() => onSelect(pkg)}
          aria-label={`View ${pkg.title}`}
          className="absolute inset-0 z-10 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
        />
        <div className="relative aspect-[16/10] overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-muted/50 to-muted transition-shadow motion-safe:group-hover:shadow-lg">
          {!seen ? (
            <Skeleton className="size-full rounded-none" />
          ) : shot ? (
            <img
              src={shot}
              alt=""
              referrerPolicy="no-referrer"
              draggable={false}
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.03]"
            />
          ) : (
            <div className="grid size-full place-items-center">
              <ExtensionIcon pkg={pkg} className="size-20" />
            </div>
          )}
          {state.id && (
            <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium shadow-sm">
              {state.outdated ? <RefreshCw className="size-3" aria-hidden /> : <Check className="size-3" aria-hidden />}
              {state.outdated ? 'Update' : 'Installed'}
            </span>
          )}
        </div>
        <div className="flex items-start gap-3">
          <ExtensionIcon pkg={pkg} className="mt-0.5 size-8" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium" title={pkg.title}>{pkg.title}</p>
            <p className="truncate text-sm text-muted-foreground">
              {[author.name, pkg.categories[0] ? categoryLabel(pkg.categories[0]) : null].filter(Boolean).join(' · ') || 'Extension'}
            </p>
          </div>
        </div>
      </div>
    </PackageContextMenu>
  );
}

function CardGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-x-5 gap-y-8 @2xl:grid-cols-2 @5xl:grid-cols-3 @7xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <Skeleton className="aspect-[16/10] rounded-2xl" />
          <div className="flex items-start gap-3">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// An extension's page
// ---------------------------------------------------------------------------

function ExtensionDetail({
  address,
  known,
  more,
  handlers,
  onBack,
  onSelect,
}: {
  address: PackageAddress;
  known: ExtensionPackage | null;
  more: ExtensionPackage[];
  handlers: PackageHandlers;
  onBack: () => void;
  onSelect: (address: PackageAddress) => void;
}) {
  // Its release and package are fetched on opening it, when they aren't known yet.
  const lookup = useThemePackage(known?.asset ? null : address);
  const fetched = lookup.data?.type === 'extension' ? lookup.data : null;
  const pkg = fetched ?? known;
  const author = usePackageAuthor(address.pubkey);
  const copy = useCopyAddress();
  const ref = useRef<HTMLDivElement>(null);

  // Take focus so Escape goes back without a click first.
  useEffect(() => ref.current?.focus(), []);

  const back = (
    <button
      type="button"
      onClick={onBack}
      className="flex w-fit items-center gap-1.5 rounded-full py-1 pr-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back
    </button>
  );

  if (!pkg) {
    return (
      <div ref={ref} tabIndex={-1} className="flex flex-col gap-6 outline-none">
        {back}
        {lookup.isPending ? (
          <div className="flex items-center gap-4">
            <Skeleton className="size-20 rounded-2xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-8 w-1/3" />
              <Skeleton className="h-4 w-1/4" />
            </div>
          </div>
        ) : (
          <EmptyState message="This isn’t on your relays. It may have been deleted." />
        )}
      </div>
    );
  }

  const state = handlers.stateOf(pkg);
  const updated = new Date(pkg.createdAt * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const loadingRelease = !pkg.asset && lookup.isPending;

  return (
    <div ref={ref} tabIndex={-1} className="flex flex-col gap-10 outline-none" aria-label={`${pkg.title} details`}>
      <div className="flex flex-col gap-6">
        {back}
        <div className="flex flex-col gap-6 @2xl:flex-row @2xl:items-center">
          <ExtensionIcon pkg={pkg} className="size-20" />
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-4xl font-bold tracking-tight">{pkg.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {author.name && (
                <span className="flex items-center gap-1.5">
                  <Avatar className="size-5">
                    {author.picture && <AvatarImage src={author.picture} alt="" />}
                    <AvatarFallback className="text-[10px]">{author.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  {author.name}
                </span>
              )}
              <span aria-hidden>·</span>
              <span>Extension</span>
              {pkg.categories.map((c) => (
                <span key={c} className="flex items-center gap-2">
                  <span aria-hidden>·</span>
                  {categoryLabel(c)}
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {state.id && state.outdated && (
              <Button variant="outline" size="lg" className="rounded-full" onClick={() => handlers.remove(pkg)} disabled={state.busy}>
                Remove
              </Button>
            )}
            <AddButton pkg={pkg} handlers={handlers} large disabled={loadingRelease} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-11 rounded-full" aria-label={`More for ${pkg.title}`} title="More">
                  <MoreVertical aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => copy(pkg)}>
                  <Copy aria-hidden />
                  Copy Address
                </DropdownMenuItem>
                {handlers.isOwn(pkg) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => handlers.deleteOwn(pkg)}>
                      <Trash2 aria-hidden />
                      Delete from Nostr…
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {pkg.screenshots.length > 0 && <Screenshots urls={pkg.screenshots} title={pkg.title} />}

      <section className="flex flex-col gap-3" aria-label="Overview">
        <h2 className="text-xl font-semibold tracking-tight">Overview</h2>
        {pkg.description || pkg.summary ? (
          <p className="max-w-prose whitespace-pre-line text-base leading-relaxed">{pkg.description || pkg.summary}</p>
        ) : (
          <p className="text-muted-foreground">This extension doesn’t describe itself.</p>
        )}
      </section>

      <ExtensionAccess pkg={pkg} />

      <section className="flex flex-col gap-4" aria-label="Details">
        <h2 className="text-xl font-semibold tracking-tight">Details</h2>
        <dl className="grid grid-cols-1 divide-y divide-border rounded-xl border border-border/70 bg-card text-sm">
          <InfoRow label="Version">{pkg.version || (loadingRelease ? '…' : 'Unknown')}</InfoRow>
          <InfoRow label="Updated">{updated}</InfoRow>
          <InfoRow label="Size">{pkg.size ? formatBytes(pkg.size) : loadingRelease ? '…' : 'Unknown'}</InfoRow>
          <InfoRow label="Offered by">{author.name ?? 'Unknown'}</InfoRow>
          {pkg.minimumChrome && <InfoRow label="Needs">{`Chrome ${pkg.minimumChrome} or later`}</InfoRow>}
          {pkg.license && <InfoRow label="License">{pkg.license}</InfoRow>}
          {pkg.website && <InfoRow label="Website">{pkg.website}</InfoRow>}
          {pkg.repository && <InfoRow label="Source code">{pkg.repository}</InfoRow>}
          {state.id && <InfoRow label="Installed as">{state.id}</InfoRow>}
        </dl>
      </section>

      {more.length > 0 && (
        <Shelf title={author.name ? `More from ${author.name}` : 'More from this creator'}>
          <CardGrid packages={more} handlers={handlers} onSelect={onSelect} />
        </Shelf>
      )}
    </div>
  );
}

/** Screenshots, side by side, scrolled one at a time. */
function Screenshots({ urls, title }: { urls: string[]; title: string }) {
  const strip = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const shown = urls.filter((url) => !failed.has(url));
  if (!shown.length) return null;
  const scroll = (delta: number) => strip.current?.scrollBy({ left: delta * strip.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <section className="relative" aria-label="Screenshots">
      <div ref={strip} className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2">
        {shown.map((url, i) => (
          <img
            key={url}
            src={url}
            alt={`${title} screenshot ${i + 1}`}
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setFailed((prev) => new Set(prev).add(url))}
            className="aspect-[16/10] w-[min(100%,40rem)] shrink-0 snap-start rounded-2xl border border-border bg-muted object-cover"
          />
        ))}
      </div>
      {shown.length > 1 && (
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" size="icon" className="rounded-full" onClick={() => scroll(-1)} aria-label="Previous screenshot">
            <ChevronLeft aria-hidden />
          </Button>
          <Button variant="outline" size="icon" className="rounded-full" onClick={() => scroll(1)} aria-label="Next screenshot">
            <ChevronRight aria-hidden />
          </Button>
        </div>
      )}
    </section>
  );
}

/** Add to Din, Update, or Installed (which removes it), as the extension stands here. */
function AddButton({ pkg, handlers, large = false, disabled = false }: { pkg: ThemePackage; handlers: PackageHandlers; large?: boolean; disabled?: boolean }) {
  const state = handlers.stateOf(pkg);
  const installed = !!state.id && !state.outdated;
  const label = state.busy
    ? state.id && !state.outdated ? 'Removing…' : 'Adding…'
    : installed ? 'Installed' : state.outdated ? 'Update' : 'Add to Din';
  return (
    <Button
      size={large ? 'lg' : 'default'}
      onClick={state.busy || installed ? undefined : () => handlers.act(pkg)}
      disabled={!handlers.canInstall || disabled}
      aria-disabled={state.busy || installed}
      title={handlers.canInstall ? (pkg.size && !state.id ? `Downloads ${formatBytes(pkg.size)}` : undefined) : 'Extensions install in the Din desktop app'}
      className={cn(
        'rounded-full px-6 font-semibold',
        installed && 'cursor-default bg-muted text-foreground hover:bg-muted',
      )}
    >
      {state.busy ? <Loader2 className="animate-spin" aria-hidden /> : installed ? <Check aria-hidden /> : state.outdated ? <RefreshCw aria-hidden /> : <Plus aria-hidden />}
      {label}
    </Button>
  );
}

/** An extension's icon, or a puzzle piece when it has none or it won't load. */
function ExtensionIcon({ pkg, className }: { pkg: ThemePackage; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = pkg.type === 'extension' ? pkg.image : null;
  if (!src || failed) {
    return (
      <span className={cn('grid shrink-0 place-items-center rounded-[22%] bg-gradient-to-br from-sky-500 to-violet-600 text-white', className)} aria-hidden>
        <Puzzle className="size-1/2" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
      className={cn('shrink-0 rounded-[22%] object-contain', className)}
    />
  );
}
