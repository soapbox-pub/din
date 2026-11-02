import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, Check, Copy, Info, Loader2, Puzzle, RefreshCw, Trash2 } from 'lucide-react';
import { EmptyState, MoreSentinel, SectionHeader } from '@/components/desktop/apps/appstore/common';
import { useSeen } from '@/components/desktop/apps/appstore/useSeen';
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
import { useAuthor } from '@/hooks/useAuthor';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import { useIconThemeStatus } from '@/hooks/useIconTheme';
import { canKeepPackages } from '@/hooks/useThemePackages';
import { useSystemCursorStatus } from '@/hooks/useSystemCursor';
import {
  useInstalledPackages,
  usePackageCatalog,
  useThemePackage,
  useThemePackageActions,
} from '@/hooks/useThemePackages';
import { useToast } from '@/hooks/useToast';
import { Budget } from '@/lib/cursorImport/bytes';
import { decodeXcursor } from '@/lib/cursorImport/xcursor';
import { formatBytes } from '@/lib/fs';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import {
  blobUrl,
  iconPreviewUrls,
  packageCoordinate,
  packageNaddr,
  parsePackageNaddr,
  type CursorPackage,
  type ExtensionPackage,
  type PackageAddress,
  type PackageType,
  type ThemePackage,
} from '@/lib/themePackages';
import { cn } from '@/lib/utils';
import { frameUrl, framesNear } from '@/shared/cursorFrames';

type PackageCatalog = ReturnType<typeof usePackageCatalog>;

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

/** What a theme becomes once it's got, for the toast. */
const BECOMES: Record<PackageType, string> = {
  cursor: 'It’s now your pointer.',
  icon: 'They’re now your icons.',
  skin: 'The Media Player is wearing it.',
  extension: 'It runs on the sites you browse.',
};

/** Where a published theme stands on this computer, and what its button does. */
interface PackageState {
  /** Its directory name, when installed. */
  id: string | null;
  /** Installed, but an older version than this. */
  outdated: boolean;
  /** The pointer's or the icons' now. */
  inUse: boolean;
  busy: boolean;
}

interface PackageHandlers {
  stateOf: (pkg: ThemePackage) => PackageState;
  /** Get, Update or Use, whichever it needs. */
  act: (pkg: ThemePackage) => void;
  remove: (pkg: ThemePackage) => void;
  /** Ask to delete one of the user's own from Nostr; `deleting` is the one asked about. */
  deleteOwn: (pkg: ThemePackage) => void;
  deleting: ThemePackage | null;
  cancelDelete: () => void;
  confirmDelete: (pkg: ThemePackage) => void;
  select: (pkg: ThemePackage) => void;
  canInstall: boolean;
  isOwn: (pkg: ThemePackage) => boolean;
}

/**
 * The App Store's Cursors, Icons and Skins, and the Web Browser's
 * about:extensions: cursor themes (kind 34628), icon themes (kind 34642),
 * skins (kind 34675) and browser extensions (kind 34639) published by the catalog's publishers, the people the
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
  const handlers = usePackageHandlers(type, onSelect);
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
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6">
            {query ? (
              <section className="flex flex-col gap-4" aria-label="Search results">
                <SectionHeader title={address ? `${capitalize(copy.noun)} at this address` : `Results for “${query}”`} />
                {address ? (
                  lookup.isPending ? (
                    <PackageGridSkeleton />
                  ) : lookup.data ? (
                    <PackageGrid packages={[lookup.data]} handlers={handlers} />
                  ) : (
                    <EmptyState message={`No ${copy.noun} is published at that address on your relays.`} />
                  )
                ) : matches.length > 0 ? (
                  <PackageGrid packages={matches} handlers={handlers} />
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
                    <PackageGrid packages={friends} handlers={handlers} />
                  </section>
                )}
                {others.length > 0 && (
                  <section className="flex flex-col gap-4" aria-label={copy.title}>
                    <SectionHeader title={friends.length ? `More ${copy.title}` : copy.title} subtitle={copy.subtitle} />
                    <PackageGrid packages={others} handlers={handlers} />
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
      <DeleteDialog handlers={handlers} />
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

/** What every card, page and menu of a tab does, sharing one installed list and one set of busy flags. */
function usePackageHandlers(type: PackageType, onSelect: (address: PackageAddress | null) => void): PackageHandlers {
  const installed = useInstalledPackages(type);
  const cursorStatus = useSystemCursorStatus();
  const iconStatus = useIconThemeStatus();
  const actions = useThemePackageActions();
  const { user } = useCurrentUser();
  const { toast } = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<ThemePackage | null>(null);

  // Which skin the Media Player wears is its own, so a skin is never In Use here.
  const current = type === 'cursor' ? cursorStatus.data?.theme : type === 'icon' ? iconStatus.data?.theme : undefined;
  const canInstall = canKeepPackages(type) && (
    type === 'cursor' ? cursorStatus.data?.canChange !== false
      : type === 'icon' ? iconStatus.data?.canChange !== false
        : true);

  const stateOf = (pkg: ThemePackage): PackageState => {
    const entry = installed.data?.get(packageCoordinate(pkg));
    return {
      id: entry?.id ?? null,
      outdated: !!entry && entry.publishedAt < pkg.createdAt,
      // An extension is at work as soon as it's installed.
      inUse: !!entry && (pkg.type === 'extension' || entry.id === current),
      busy: busy.has(packageCoordinate(pkg)),
    };
  };

  const track = async (pkg: ThemePackage, run: () => Promise<unknown>, failure: string) => {
    const key = packageCoordinate(pkg);
    setBusy((prev) => new Set(prev).add(key));
    try {
      await run();
    } catch (error) {
      toast({ title: failure, description: cleanError(error), variant: 'destructive' });
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const act = (pkg: ThemePackage) => {
    const state = stateOf(pkg);
    if (state.busy || (state.inUse && !state.outdated)) return;
    if (state.id && !state.outdated) {
      void track(pkg, () => actions.use(pkg.type, state.id as string), `Couldn’t use ${pkg.title}`);
      return;
    }
    void track(
      pkg,
      async () => {
        await actions.install(pkg);
        toast({ title: `${pkg.title} ${state.id ? 'updated' : 'installed'}`, description: BECOMES[pkg.type] });
      },
      `Couldn’t get ${pkg.title}`,
    );
  };

  const remove = (pkg: ThemePackage) => {
    const { id } = stateOf(pkg);
    if (id) void track(pkg, () => actions.remove(pkg.type, id), `Couldn’t remove ${pkg.title}`);
  };

  return {
    stateOf,
    act,
    remove,
    deleteOwn: setDeleting,
    select: (pkg) => onSelect({ type: pkg.type, pubkey: pkg.pubkey, identifier: pkg.identifier }),
    canInstall,
    isOwn: (pkg) => pkg.pubkey === user?.pubkey,
    deleting,
    cancelDelete: () => setDeleting(null),
    confirmDelete: (pkg) => {
      setDeleting(null);
      void track(pkg, () => actions.deleteOwn(pkg), `Couldn’t delete ${pkg.title}`);
    },
  };
}

/** The author's name and picture. */
function usePackageAuthor(pubkey: string | undefined) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  return {
    name: (metadata?.display_name || metadata?.name)?.trim() || null,
    picture: metadata?.picture ? sanitizeImageUrl(metadata.picture) : null,
  };
}

function PackageGrid({ packages, handlers }: { packages: ThemePackage[]; handlers: PackageHandlers }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {packages.map((pkg) => (
        <PackageCard key={packageCoordinate(pkg)} pkg={pkg} handlers={handlers} />
      ))}
    </div>
  );
}

function PackageCard({ pkg, handlers }: { pkg: ThemePackage; handlers: PackageHandlers }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const author = usePackageAuthor(seen ? pkg.pubkey : undefined);

  return (
    <PackageContextMenu pkg={pkg} handlers={handlers}>
      <div
        ref={ref}
        className="relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-shadow motion-safe:hover:shadow-md"
      >
        <button
          type="button"
          onClick={() => handlers.select(pkg)}
          aria-label={`View details for ${pkg.title}`}
          className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <PackagePreview pkg={pkg} visible={seen} className="h-28 border-b border-border" />
        <div className="flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold" title={pkg.title}>
              {pkg.title}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {[author.name ? `by ${author.name}` : null, pkg.size ? formatBytes(pkg.size) : null].filter(Boolean).join(' · ') || COPY[pkg.type].noun}
            </p>
          </div>
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
    return (
      <div className={cn('grid place-items-center p-4', backdrop, className)} aria-hidden>
        {pkg.image && !failed.has(pkg.image) ? (
          <img
            src={pkg.image}
            alt=""
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setFailed(new Set([pkg.image as string]))}
            className={cn(
              'max-h-full max-w-full object-contain',
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
        'bg-secondary text-primary hover:bg-secondary/80',
        (done || state.busy) && 'cursor-default text-muted-foreground hover:bg-secondary',
      )}
    >
      {state.busy ? <Loader2 className="animate-spin" aria-hidden /> : done ? <Check aria-hidden /> : state.outdated ? <RefreshCw aria-hidden /> : null}
      {label}
    </Button>
  );
}

/** A theme's right-click menu, mirroring its card's and page's buttons. */
function PackageContextMenu({ pkg, handlers, children }: { pkg: ThemePackage; handlers: PackageHandlers; children: ReactNode }) {
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

function useCopyAddress() {
  const { toast } = useToast();
  return (pkg: ThemePackage) => {
    void navigator.clipboard.writeText(packageNaddr(pkg)).then(() => toast({ title: 'Address copied' }));
  };
}

/** Asks before one of the user's own published themes is deleted from their relays. */
function DeleteDialog({ handlers }: { handlers: PackageHandlers }) {
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
}: {
  address: PackageAddress;
  known: ThemePackage | null;
  more: ThemePackage[];
  handlers: PackageHandlers;
}) {
  const lookup = useThemePackage(known ? null : address);
  const pkg = known ?? lookup.data ?? null;
  const author = usePackageAuthor(address.pubkey);
  const copy = useCopyAddress();
  const ref = useRef<HTMLDivElement>(null);

  // Take focus so Escape goes back without a click first.
  useEffect(() => ref.current?.focus(), []);

  if (!pkg) {
    return (
      <div ref={ref} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
        <div className="mx-auto max-w-5xl p-4 sm:p-6">
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
      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="w-full max-w-2xl shrink-0 overflow-hidden rounded-2xl border border-border shadow-md lg:w-3/5">
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

        {pkg.summary ? (
          <p className="max-w-prose whitespace-pre-line text-base leading-relaxed">{pkg.summary}</p>
        ) : (
          <p className="text-muted-foreground">This {COPY[pkg.type].noun} doesn’t describe itself.</p>
        )}

        {pkg.type === 'cursor' && <TryCursors pkg={pkg} />}

        {pkg.type === 'extension' && <ExtensionAccess pkg={pkg} />}

        <section className="flex flex-col gap-4" aria-label="Information">
          <SectionHeader title="Information" />
          <dl className="grid grid-cols-1 divide-y divide-border rounded-2xl border border-border bg-card text-sm">
            <InfoRow label="Download size">{pkg.size ? formatBytes(pkg.size) : 'Unknown'}</InfoRow>
            {pkg.type === 'cursor' ? (
              <InfoRow label="Cursors">{`${pkg.cursors.length.toLocaleString()}${pkg.links.length ? `, under ${(pkg.cursors.length + pkg.links.length).toLocaleString()} names` : ''}`}</InfoRow>
            ) : null}
            {pkg.type === 'skin' ? (
              <InfoRow label="Kind">{pkg.skin.format === 'winamp' ? 'Winamp classic skin (.wsz)' : 'Windows Media Player skin (.wmz)'}</InfoRow>
            ) : null}
            {pkg.type === 'extension' && pkg.version ? <InfoRow label="Version">{pkg.version}</InfoRow> : null}
            {pkg.type === 'extension' && pkg.manifestVersion ? <InfoRow label="Manifest">{`Version ${pkg.manifestVersion}`}</InfoRow> : null}
            {pkg.inherits.length > 0 && <InfoRow label="Builds on">{pkg.inherits.join(', ')}</InfoRow>}
            <InfoRow label="Creator">{author.name ?? 'Unknown'}</InfoRow>
            <InfoRow label="Updated">{updated}</InfoRow>
            {state.id && <InfoRow label="Installed as">{state.id}</InfoRow>}
          </dl>
        </section>

        {more.length > 0 && (
          <section className="flex flex-col gap-4" aria-label="More from this creator">
            <SectionHeader title={author.name ? `More from ${author.name}` : 'More from this creator'} />
            <PackageGrid packages={more} handlers={handlers} />
          </section>
        )}
      </div>
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
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {tries.isPending
          ? TRY_ROLES.map(({ label }) => <Skeleton key={label} className="h-24 rounded-xl" />)
          : tries.data?.map(({ label, src, css }) => (
              <div
                key={label}
                style={{ cursor: css }}
                className="flex h-24 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card"
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
function ExtensionAccess({ pkg }: { pkg: ExtensionPackage }) {
  const sites = pkg.hosts.includes('<all_urls>') || pkg.hosts.some((h) => /^\*:\/\/\*\/\*$/.test(h) || /^https?:\/\/\*\/\*$/.test(h))
    ? ['Every site']
    : pkg.hosts;
  if (!sites.length && !pkg.permissions.length) return null;
  return (
    <section className="flex flex-col gap-4" aria-label="What it can do">
      <SectionHeader title="What It Can Do" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {sites.length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="mb-2 text-sm font-medium">Read and change data on</p>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {sites.map((site) => (
                <li key={site} className="truncate font-mono text-xs" title={site}>{site}</li>
              ))}
            </ul>
          </div>
        )}
        {pkg.permissions.length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-4">
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

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function PackageGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-border bg-card">
          <Skeleton className="h-28 rounded-none" />
          <div className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
            <Skeleton className="h-8 w-16 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
