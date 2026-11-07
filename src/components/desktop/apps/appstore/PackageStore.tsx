import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, Check, Copy, Eye, EyeOff, Info, Loader2, Puzzle, RefreshCw, Trash2, X } from 'lucide-react';
import { EmptyState, MoreSentinel, SectionHeader } from '@/components/desktop/apps/appstore/common';
import { useSeen } from '@/components/desktop/apps/appstore/useSeen';
import { canTryOn, useTryOn, type TryOn } from '@/components/desktop/apps/appstore/useTryOn';
import {
  useCopyAddress,
  usePackageAuthor,
  usePackageHandlers,
  type PackageHandlers,
} from '@/components/desktop/apps/appstore/usePackageHandlers';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import { type PackageCatalogState, useThemePackage } from '@/hooks/useThemePackages';
import { Budget } from '@/lib/cursorImport/bytes';
import { decodeXcursor } from '@/lib/cursorImport/xcursor';
import { formatBytes } from '@/lib/fs';
import {
  blobUrl,
  iconPreviewUrls,
  packageCoordinate,
  parsePackageNaddr,
  type CursorPackage,
  type ExtensionPackage,
  type PackageAddress,
  type PackageType,
  type ThemePackage,
} from '@/lib/themePackages';
import { cn } from '@/lib/utils';
import { frameUrl, framesNear } from '@/shared/cursorFrames';
import { settingsGroup } from '@/shared/settingsChromeStyles';

type PackageCatalog = PackageCatalogState;

const COPY: Record<PackageType, { title: string; subtitle: string; noun: string; empty: string }> = {
  cursor: {
    title: 'Cursors',
    subtitle: 'Pointers for your whole computer, from Din’s publishers and the people you follow.',
    noun: 'cursor',
    empty: 'No cursors found on your relays yet. Publish one from Settings → Cursors, or follow people who share theirs.',
  },
  icon: {
    title: 'Icons',
    subtitle: 'Icon sets for your apps, files and folders, from Din’s publishers and the people you follow.',
    noun: 'icon set',
    empty: 'No icon sets found on your relays yet. Publish one from Settings → Icons, or follow people who share theirs.',
  },
  skin: {
    title: 'Skins',
    subtitle: 'Winamp and Windows Media Player skins for the Media Player, from Din’s publishers and the people you follow.',
    noun: 'skin',
    empty: 'No skins found on your relays yet. Publish one from the Media Player’s Skins tab, or follow people who share theirs.',
  },
  extension: {
    title: 'Extensions',
    subtitle: 'Extensions for the Web Browser, from Din’s publishers and the people you follow.',
    noun: 'extension',
    empty: 'No extensions found on your relays yet. Publish one from the browser’s Settings, or follow people who share theirs.',
  },
};

/**
 * The App Store's Cursors, Icons and Skins, and the Web Browser's
 * about:extensions: cursor themes (kind 34628), icon themes (kind 34642),
 * skins (kind 34675) and browser extensions (NIP-82 apps with a .crx) published by the catalog's publishers, the people the
 * user follows, and the user (usePackageCatalog), the people they follow
 * first. Get downloads one and puts it on; it shows its download size, which
 * for an icon set can be tens of megabytes.
 */
export function PackageStore({
  type,
  catalog,
  search,
  selected,
  onSelect,
}: {
  type: PackageType;
  catalog: PackageCatalog;
  search: string;
  selected: PackageAddress | null;
  onSelect: (address: PackageAddress | null) => void;
}) {
  const base = usePackageHandlers(type, onSelect);
  const tryOn = useTryOn((pkg) => base.stateOf(pkg).id);
  // A pointer tried on is the system's for now, but not yet got: Get keeps
  // it, and its download is Try On's to show.
  const tryingPointer = (pkg: ThemePackage) => pkg.type === 'cursor' && tryOn.isTrying(pkg);
  const handlers: PackageHandlers = {
    ...base,
    stateOf: (pkg) => (tryingPointer(pkg) ? { id: null, outdated: false, inUse: false, busy: false } : base.stateOf(pkg)),
    act: (pkg) => (tryingPointer(pkg) ? tryOn.keep() : base.act(pkg)),
  };
  const { user } = useCurrentUser();
  const following = useFollowingPubkeys();
  const copy = COPY[type];

  const query = search.trim();
  const address = parsePackageNaddr(query, type);
  const lookup = useThemePackage(address);

  const matches = useMemo(() => {
    if (!query || address) return [];
    const q = query.toLowerCase();
    return catalog.packages.filter((pkg) =>
      `${pkg.title}\u0000${pkg.summary}\u0000${pkg.identifier}`.toLowerCase().includes(q),
    );
  }, [query, address, catalog.packages]);

  const [friends, others] = useMemo(() => {
    const close = new Set(following);
    if (user) close.add(user.pubkey);
    return [
      catalog.packages.filter((pkg) => close.has(pkg.pubkey)),
      catalog.packages.filter((pkg) => !close.has(pkg.pubkey)),
    ];
  }, [catalog.packages, following, user]);

  // What's tried on comes off once it's got and worn for real.
  const triedState = tryOn.trying && handlers.stateOf(tryOn.trying);
  const triedInUse = !!triedState && triedState.inUse && !triedState.outdated;
  const { stop } = tryOn;
  useEffect(() => {
    if (triedInUse) stop();
  }, [triedInUse, stop]);

  const known =
    selected && catalog.packages.find((pkg) => packageCoordinate(pkg) === packageCoordinate(selected));

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !selected) return;
        e.stopPropagation();
        onSelect(null);
      }}
    >
      {selected ? (
        <PackageDetailPage
          key={packageCoordinate(selected)}
          address={selected}
          known={known ?? null}
          more={catalog.packages.filter(
            (pkg) => pkg.pubkey === selected.pubkey && pkg.identifier !== selected.identifier,
          )}
          handlers={handlers}
          tryOn={tryOn}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 @2xl:p-6">
            {query ? (
              <section className="flex flex-col gap-4" aria-label="Search results">
                <SectionHeader title={address ? `${capitalize(copy.noun)} at this address` : `Results for “${query}”`} />
                {address ? (
                  lookup.isPending ? (
                    <PackageGridSkeleton />
                  ) : lookup.data ? (
                    <PackageGrid packages={[lookup.data]} handlers={handlers} tryOn={tryOn} />
                  ) : (
                    <EmptyState message={`No ${copy.noun} is published at that address on your relays.`} />
                  )
                ) : matches.length > 0 ? (
                  <PackageGrid packages={matches} handlers={handlers} tryOn={tryOn} />
                ) : catalog.isLoading ? (
                  <PackageGridSkeleton />
                ) : (
                  <EmptyState
                    message={`No ${copy.noun}s match “${query}”. You can also paste an address to find one.`}
                  />
                )}
              </section>
            ) : catalog.isLoading ? (
              <section className="flex flex-col gap-4" aria-label={copy.title}>
                <SectionHeader title={copy.title} subtitle={copy.subtitle} />
                <PackageGridSkeleton />
              </section>
            ) : catalog.isError ? (
              <EmptyState message={`Could not load ${copy.noun}s. Check your relay connections and try refreshing.`} />
            ) : catalog.packages.length === 0 ? (
              <EmptyState message={copy.empty} />
            ) : (
              <>
                {friends.length > 0 && (
                  <section className="flex flex-col gap-4" aria-label="From people you follow">
                    <SectionHeader title="From People You Follow" />
                    <PackageGrid packages={friends} handlers={handlers} tryOn={tryOn} />
                  </section>
                )}
                {others.length > 0 && (
                  <section className="flex flex-col gap-4" aria-label={copy.title}>
                    <SectionHeader title={friends.length ? `More ${copy.title}` : copy.title} subtitle={copy.subtitle} />
                    <PackageGrid packages={others} handlers={handlers} tryOn={tryOn} />
                  </section>
                )}
                {catalog.hasMore && (
                  <MoreSentinel onReached={() => void catalog.loadMore()} paused={catalog.isLoadingMore} />
                )}
              </>
            )}
          </div>
        </div>
      )}
      {tryOn.trying && <TryOnBar tryOn={tryOn} handlers={handlers} />}
      <DeleteDialog handlers={handlers} />
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function PackageGrid({ packages, handlers, tryOn }: { packages: ThemePackage[]; handlers: PackageHandlers; tryOn: TryOn }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-5">
      {packages.map((pkg) => (
        <PackageCard key={packageCoordinate(pkg)} pkg={pkg} handlers={handlers} tryOn={tryOn} />
      ))}
    </div>
  );
}

function PackageCard({ pkg, handlers, tryOn }: { pkg: ThemePackage; handlers: PackageHandlers; tryOn: TryOn }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const author = usePackageAuthor(seen ? pkg.pubkey : undefined);
  const state = handlers.stateOf(pkg);
  const inUse = state.inUse && !state.outdated;

  return (
    <PackageContextMenu pkg={pkg} handlers={handlers} tryOn={tryOn}>
      <div
        ref={ref}
        className="relative flex flex-col overflow-hidden rounded-xl bg-card clay transition-shadow motion-safe:hover:shadow-md"
      >
        <button
          type="button"
          onClick={() => handlers.select(pkg)}
          aria-label={`View details for ${pkg.title}`}
          className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <PackagePreview pkg={pkg} visible={seen} className="h-44 border-b border-border" />
        <div className="flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold" title={pkg.title}>
              {pkg.title}
            </p>
            <p className="truncate text-sm text-muted-foreground">
              {[author.name ? `by ${author.name}` : null, pkg.size ? formatBytes(pkg.size) : null].filter(Boolean).join(' · ') || COPY[pkg.type].noun}
            </p>
          </div>
          {canTryOn(pkg) && !inUse && <TryOnButton pkg={pkg} tryOn={tryOn} />}
          <PackagePill pkg={pkg} handlers={handlers} />
        </div>
      </div>
    </PackageContextMenu>
  );
}

/** A cursor theme's or skin's picture, or an icon set's icons, on a soft backdrop. */
function PackagePreview({ pkg, visible, className, large = false }: { pkg: ThemePackage; visible: boolean; className?: string; large?: boolean }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  if (!visible) return <Skeleton className={cn('rounded-none', className)} />;
  const backdrop = 'bg-gradient-to-br from-muted/60 to-muted';

  if (pkg.type === 'extension') {
    return (
      <div className={cn('grid place-items-center p-4', backdrop, className)} aria-hidden>
        {pkg.image && !failed.has(pkg.image) ? (
          <img
            src={pkg.image}
            alt=""
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setFailed(new Set([pkg.image as string]))}
            className={cn('object-contain', large ? 'size-32' : 'size-16')}
          />
        ) : (
          <Puzzle className={cn('text-muted-foreground', large ? 'size-24' : 'size-12')} />
        )}
      </div>
    );
  }

  if (pkg.type === 'cursor' || pkg.type === 'skin') {
    const skin = pkg.type === 'skin';
    // Flex, not grid: a grid's auto row grows to a tall picture's own height
    // before its h-full resolves, spilling it out of the card.
    return (
      <div className={cn('flex items-center justify-center overflow-hidden p-4', backdrop, className)} aria-hidden>
        {pkg.image && !failed.has(pkg.image) ? (
          <img
            src={pkg.image}
            alt=""
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setFailed(new Set([pkg.image as string]))}
            className={cn(
              'min-h-0 min-w-0 max-h-full max-w-full object-contain',
              skin ? cn('[image-rendering:pixelated]', large ? 'h-64' : 'h-full') : large ? 'h-24' : 'h-14',
            )}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {skin ? (pkg.skin.format === 'winamp' ? 'Winamp skin' : 'Windows Media Player skin') : `${pkg.cursors.length} cursors`}
          </span>
        )}
      </div>
    );
  }

  const icons = iconPreviewUrls(pkg).filter((icon) => !failed.has(icon.src)).slice(0, large ? 12 : 6);
  return (
    <div className={cn('flex flex-wrap content-center items-center justify-center gap-3 p-4', backdrop, className)} aria-hidden>
      {icons.length ? (
        icons.map((icon) => (
          <img
            key={icon.src}
            src={icon.src}
            alt=""
            referrerPolicy="no-referrer"
            draggable={false}
            loading="lazy"
            onError={() => setFailed((prev) => new Set(prev).add(icon.src))}
            className={cn('object-contain', large ? 'size-14' : 'size-10')}
          />
        ))
      ) : (
        <span className="text-xs text-muted-foreground">No preview</span>
      )}
    </div>
  );
}

/** Get, Update, Use or In Use, as the theme stands here. */
function PackagePill({ pkg, handlers }: { pkg: ThemePackage; handlers: PackageHandlers }) {
  const state = handlers.stateOf(pkg);
  const done = state.inUse && !state.outdated;
  const label = state.busy ? (state.id && !state.outdated ? 'Switching…' : 'Getting…') : done ? (pkg.type === 'extension' ? 'Installed' : 'In Use') : state.outdated ? 'Update' : state.id ? 'Use' : 'Get';
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={done || state.busy ? undefined : () => handlers.act(pkg)}
      disabled={!handlers.canInstall}
      title={handlers.canInstall ? (state.id ? undefined : pkg.size ? `Downloads ${formatBytes(pkg.size)}` : undefined) : 'Din can’t change this on this computer'}
      aria-disabled={done || state.busy}
      aria-label={`${label} ${pkg.title}`}
      className={cn(
        'relative z-10 h-8 shrink-0 rounded-full px-5 font-semibold',
        'bg-secondary text-ink-accent hover:bg-secondary/80',
        (done || state.busy) && 'cursor-default text-muted-foreground hover:bg-secondary',
      )}
    >
      {state.busy ? <Loader2 className="animate-spin" aria-hidden /> : done ? <Check aria-hidden /> : state.outdated ? <RefreshCw aria-hidden /> : null}
      {label}
    </Button>
  );
}

/** A theme's right-click menu, mirroring its card's and page's buttons. */
export function PackageContextMenu({
  pkg,
  handlers,
  tryOn,
  children,
}: {
  pkg: ThemePackage;
  handlers: PackageHandlers;
  /** The App Store's Try On, for a cursor theme or icon set. */
  tryOn?: TryOn;
  children: ReactNode;
}) {
  const state = handlers.stateOf(pkg);
  const copy = useCopyAddress();
  const done = state.inUse && !state.outdated;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => handlers.act(pkg)} disabled={done || state.busy || !handlers.canInstall}>
          {state.outdated ? <RefreshCw aria-hidden /> : state.id ? <Check aria-hidden /> : <ArrowDownToLine aria-hidden />}
          {state.outdated ? 'Update' : state.id ? (pkg.type === 'extension' ? 'Installed' : 'Use') : 'Get'}
        </ContextMenuItem>
        {tryOn && canTryOn(pkg) && !done && (
          <ContextMenuItem onSelect={() => (tryOn.isTrying(pkg) ? tryOn.stop() : tryOn.start(pkg))}>
            {tryOn.isTrying(pkg) ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            {tryOn.isTrying(pkg) ? 'Stop Trying On' : 'Try On'}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => handlers.select(pkg)}>
          <Info aria-hidden />
          View Details
        </ContextMenuItem>
        {state.id && (
          <ContextMenuItem onSelect={() => handlers.remove(pkg)} disabled={state.busy}>
            <Trash2 aria-hidden />
            Remove from This Computer
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copy(pkg)}>
          <Copy aria-hidden />
          Copy Address
        </ContextMenuItem>
        {handlers.isOwn(pkg) && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => handlers.deleteOwn(pkg)}>
              <Trash2 aria-hidden />
              Delete from Nostr…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Asks before one of the user's own published themes is deleted from their relays. */
export function DeleteDialog({ handlers }: { handlers: PackageHandlers }) {
  const pkg = handlers.deleting;
  return (
    <AlertDialog open={!!pkg} onOpenChange={(open) => !open && handlers.cancelDelete()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pkg?.title} from Nostr?</AlertDialogTitle>
          <AlertDialogDescription>
            Asks your relays to delete it, so it leaves the App Store. Anyone who already has it keeps it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => pkg && handlers.confirmDelete(pkg)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A theme's page: a big preview, what's in it and how big it is, and who made it. */
function PackageDetailPage({
  address,
  known,
  more,
  handlers,
  tryOn,
}: {
  address: PackageAddress;
  known: ThemePackage | null;
  more: ThemePackage[];
  handlers: PackageHandlers;
  tryOn: TryOn;
}) {
  // An extension's release and package are fetched on opening it, when they aren't known yet.
  const lookup = useThemePackage(known && !(known.type === 'extension' && !known.asset) ? null : address);
  const pkg = known ?? lookup.data ?? null;
  const author = usePackageAuthor(address.pubkey);
  const copy = useCopyAddress();
  const ref = useRef<HTMLDivElement>(null);

  // Take focus so Escape goes back without a click first.
  useEffect(() => ref.current?.focus(), []);

  if (!pkg) {
    return (
      <div ref={ref} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
        <div className="mx-auto max-w-5xl p-4 @2xl:p-6">
          {lookup.isPending ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-48 w-full max-w-2xl rounded-2xl" />
              <Skeleton className="h-8 w-1/3" />
            </div>
          ) : (
            <EmptyState message="This isn’t on your relays. It may have been deleted." />
          )}
        </div>
      </div>
    );
  }

  const state = handlers.stateOf(pkg);
  const updated = new Date(pkg.createdAt * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div ref={ref} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none" aria-label={`${pkg.title} details`}>
      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 @2xl:p-6">
        <div className="flex flex-col gap-6 @5xl:flex-row @5xl:items-center">
          <div className="w-full max-w-2xl shrink-0 overflow-hidden rounded-2xl border border-border shadow-md @5xl:w-3/5">
            <PackagePreview pkg={pkg} visible large className="min-h-48" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="min-w-0">
              <h1 className="break-words text-3xl font-bold tracking-tight">{pkg.title}</h1>
              {author.name && (
                <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                  <Avatar className="size-5">
                    {author.picture && <AvatarImage src={author.picture} alt="" />}
                    <AvatarFallback className="text-[10px]">{author.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="truncate">{author.name}</span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PackagePill pkg={pkg} handlers={handlers} />
              {canTryOn(pkg) && !(state.inUse && !state.outdated) && <TryOnButton pkg={pkg} tryOn={tryOn} />}
              {state.id && (
                <Button size="sm" variant="ghost" onClick={() => handlers.remove(pkg)} disabled={state.busy} className="h-8 rounded-full px-4">
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => copy(pkg)} className="h-8 rounded-full px-4">
                <Copy aria-hidden />
                Copy Address
              </Button>
            </div>
          </div>
        </div>

        {(pkg.type === 'extension' ? pkg.description || pkg.summary : pkg.summary) ? (
          <p className="max-w-prose whitespace-pre-line text-base leading-relaxed">
            {pkg.type === 'extension' ? pkg.description || pkg.summary : pkg.summary}
          </p>
        ) : (
          <p className="text-muted-foreground">This {COPY[pkg.type].noun} doesn’t describe itself.</p>
        )}

        {pkg.type === 'cursor' && <TryCursors pkg={pkg} />}

        {pkg.type === 'extension' && <ExtensionAccess pkg={pkg} />}

        <section className="flex flex-col gap-4" aria-label="Information">
          <SectionHeader title="Information" />
          <dl className={cn(settingsGroup, 'text-sm')}>
            <InfoRow label="Download size">{pkg.size ? formatBytes(pkg.size) : 'Unknown'}</InfoRow>
            {pkg.type === 'cursor' ? (
              <InfoRow label="Cursors">{`${pkg.cursors.length.toLocaleString()}${pkg.links.length ? `, under ${(pkg.cursors.length + pkg.links.length).toLocaleString()} names` : ''}`}</InfoRow>
            ) : null}
            {pkg.type === 'skin' ? (
              <InfoRow label="Kind">{pkg.skin.format === 'winamp' ? 'Winamp classic skin (.wsz)' : 'Windows Media Player skin (.wmz)'}</InfoRow>
            ) : null}
            {pkg.type === 'extension' && pkg.version ? <InfoRow label="Version">{pkg.version}</InfoRow> : null}
            {pkg.type === 'extension' && pkg.minimumChrome ? <InfoRow label="Needs">{`Chrome ${pkg.minimumChrome} or later`}</InfoRow> : null}
            {pkg.type === 'extension' && pkg.license ? <InfoRow label="License">{pkg.license}</InfoRow> : null}
            {pkg.type === 'extension' && pkg.repository ? <InfoRow label="Source code">{pkg.repository}</InfoRow> : null}
            {pkg.inherits.length > 0 && <InfoRow label="Builds on">{pkg.inherits.join(', ')}</InfoRow>}
            <InfoRow label="Creator">{author.name ?? 'Unknown'}</InfoRow>
            <InfoRow label="Updated">{updated}</InfoRow>
            {state.id && <InfoRow label="Installed as">{state.id}</InfoRow>}
          </dl>
        </section>

        {more.length > 0 && (
          <section className="flex flex-col gap-4" aria-label="More from this creator">
            <SectionHeader title={author.name ? `More from ${author.name}` : 'More from this creator'} />
            <PackageGrid packages={more} handlers={handlers} tryOn={tryOn} />
          </section>
        )}
      </div>
    </div>
  );
}

/** Try On, or Stop Trying On the one being tried. */
function TryOnButton({ pkg, tryOn }: { pkg: ThemePackage; tryOn: TryOn }) {
  const trying = tryOn.isTrying(pkg);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => (trying ? tryOn.stop() : tryOn.start(pkg))}
      aria-label={trying ? `Stop trying on ${pkg.title}` : `Try on ${pkg.title}`}
      title={trying ? 'Stop Trying On' : 'Try On'}
      className="relative z-10 h-8 shrink-0 rounded-full px-4"
    >
      {trying && tryOn.loading ? <Loader2 className="animate-spin" aria-hidden /> : trying ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      {trying ? 'Stop' : 'Try On'}
    </Button>
  );
}

/** Shown while a theme is tried on: what it changed, Get, and taking it off. */
function TryOnBar({ tryOn, handlers }: { tryOn: TryOn; handlers: PackageHandlers }) {
  const pkg = tryOn.trying;
  if (!pkg) return null;
  return (
    <div
      role="region"
      aria-label="Trying on"
      className="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-3 shadow-[0_-4px_16px_-8px_rgb(0_0_0/0.2)]"
    >
      <Eye className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">
        {tryOn.loading ? 'Getting ' : 'Trying on '}
        <span className="font-semibold">{pkg.title}</span>
        <span className="text-muted-foreground">
          {pkg.type === 'cursor'
            ? ': your pointer everywhere until you stop, when yours comes back.'
            : ': a few of your apps’ icons, in the Dock and the apps menu.'}
        </span>
      </p>
      <PackagePill pkg={pkg} handlers={handlers} />
      <Button size="icon" variant="ghost" onClick={tryOn.stop} aria-label="Stop trying on" title="Stop Trying On" className="size-8 rounded-full">
        <X aria-hidden />
      </Button>
    </div>
  );
}

/** The cursors tried on by pointing, each the first that a theme has of its names. */
const TRY_ROLES: { label: string; names: string[] }[] = [
  { label: 'Arrow', names: ['left_ptr', 'default', 'arrow'] },
  { label: 'Link', names: ['pointer', 'hand2', 'pointing_hand', 'hand1'] },
  { label: 'Text', names: ['text', 'xterm', 'ibeam'] },
  { label: 'Busy', names: ['watch', 'wait', 'progress', 'left_ptr_watch'] },
  { label: 'Move', names: ['move', 'fleur', 'all-scroll', 'size_all'] },
  { label: 'Resize', names: ['nwse-resize', 'size_fdiag', 'bottom_right_corner'] },
];

const SHA256_HEX = (data: ArrayBuffer) =>
  crypto.subtle.digest('SHA-256', data).then((digest) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''));

/** A few of a published theme's cursors, downloaded and checked against their hashes, to try on before getting it. */
function TryCursors({ pkg }: { pkg: CursorPackage }) {
  const tries = useQuery({
    queryKey: ['theme-packages', 'try', packageCoordinate(pkg), pkg.createdAt],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const byName = new Map(pkg.cursors.map((c) => [c.name, c.sha256]));
      for (const [alias, target] of pkg.links) {
        const sha = byName.get(target);
        if (sha && !byName.has(alias)) byName.set(alias, sha);
      }
      const results = await Promise.all(
        TRY_ROLES.map(async ({ label, names }) => {
          const sha = names.map((name) => byName.get(name)).find(Boolean);
          const url = sha && blobUrl(pkg, sha);
          if (!sha || !url) return null;
          try {
            const response = await fetch(url, { signal, referrerPolicy: 'no-referrer' });
            if (!response.ok) return null;
            const data = await response.arrayBuffer();
            if ((await SHA256_HEX(data)) !== sha) return null;
            const frames = decodeXcursor(new Uint8Array(data), new Budget());
            const [frame] = frames ? framesNear(frames, 32) : [];
            if (!frame) return null;
            const src = frameUrl(frame);
            return { label, src, css: `url(${src}) ${frame.hotX} ${frame.hotY}, auto` };
          } catch {
            return null;
          }
        }),
      );
      return results.filter((r): r is { label: string; src: string; css: string } => r !== null);
    },
  });

  if (!tries.isPending && !tries.data?.length) return null;
  return (
    <section className="flex flex-col gap-4" aria-label="Try it">
      <SectionHeader title="Try It" subtitle="Point at each to see it as your pointer." />
      <div className="grid grid-cols-3 gap-3 @2xl:grid-cols-6">
        {tries.isPending
          ? TRY_ROLES.map(({ label }) => <Skeleton key={label} className="h-24 rounded-xl" />)
          : tries.data?.map(({ label, src, css }) => (
              <div
                key={label}
                style={{ cursor: css }}
                className="flex h-24 flex-col items-center justify-center gap-2 rounded-xl bg-card clay"
              >
                <img src={src} alt="" draggable={false} className="size-8 object-contain" />
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
      </div>
    </section>
  );
}

/** What an extension says it can do, from its manifest; Get shows the same before installing. */
export function ExtensionAccess({ pkg }: { pkg: ExtensionPackage }) {
  const sites = pkg.hosts.includes('<all_urls>') || pkg.hosts.some((h) => /^\*:\/\/\*\/\*$/.test(h) || /^https?:\/\/\*\/\*$/.test(h))
    ? ['Every site']
    : pkg.hosts;
  if (!sites.length && !pkg.permissions.length) return null;
  return (
    <section className="flex flex-col gap-4" aria-label="What it can do">
      <SectionHeader title="What It Can Do" />
      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
        {sites.length > 0 && (
          <div className="rounded-xl bg-card clay p-4">
            <p className="mb-2 text-sm font-medium">Read and change data on</p>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {sites.map((site) => (
                <li key={site} className="truncate font-mono text-xs" title={site}>{site}</li>
              ))}
            </ul>
          </div>
        )}
        {pkg.permissions.length > 0 && (
          <div className="rounded-xl bg-card clay p-4">
            <p className="mb-2 text-sm font-medium">Permissions</p>
            <ul className="flex flex-wrap gap-1.5">
              {pkg.permissions.map((permission) => (
                <li key={permission} className="rounded-full bg-muted px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {permission}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function PackageGridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-5">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl bg-card clay">
          <Skeleton className="h-44 rounded-none" />
          <div className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-5 w-3/5" />
              <Skeleton className="h-4 w-2/5" />
            </div>
            <Skeleton className="h-8 w-20 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
