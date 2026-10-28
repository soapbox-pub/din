import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Eye, Info, Plus, X } from 'lucide-react';
import { EmptyState, MoreSentinel, SectionHeader } from '@/components/desktop/apps/appstore/common';
import { useSeen } from '@/components/desktop/apps/appstore/useSeen';
import { ThemeSwatch } from '@/components/desktop/ThemeSwatch';
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
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAuthor } from '@/hooks/useAuthor';
import { useDesktopThemeEditor } from '@/hooks/useDesktopTheme';
import { useToast } from '@/hooks/useToast';
import { useThemeActions, useThemeCatalog, useThemeDefinition } from '@/hooks/useThemes';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import {
  parseThemeNaddr,
  themeCoordinate,
  themeNaddr,
  type ThemeDefinition,
} from '@/lib/themeDefinition';
import { clearThemePreview, startThemePreview } from '@/lib/themePreview';
import { cn } from '@/lib/utils';

export type ThemeAddress = { pubkey: string; identifier: string };

type ThemeCatalog = ReturnType<typeof useThemeCatalog>;

/** What a card or detail page can do with a theme; shared by its buttons and right-click menu. */
interface ThemeHandlers {
  select: (theme: ThemeDefinition) => void;
  tryOn: (theme: ThemeDefinition) => void;
}

/**
 * The App Store's Themes: named themes (kind 36767) from the catalog's
 * publishers, the people the user follows, and the user (useThemeCatalog).
 *
 * "Try" paints the desktop in a theme without saving anything (themePreview)
 * and shows a bar to keep it or go back; the preview ends with Cancel,
 * Escape, going back from a theme's page, switching to Apps, or closing the
 * store. "Get" adds someone else's theme to the user's themes, which
 * Settings → Appearance lists.
 */
export function ThemeStore({
  catalog,
  search,
  selected,
  onSelect,
}: {
  catalog: ThemeCatalog;
  search: string;
  selected: ThemeAddress | null;
  onSelect: (address: ThemeAddress | null) => void;
}) {
  // A preview belongs to the page it was started on, and ends with the store.
  const page = selected ? themeCoordinate(selected) : null;
  const [trial, setTrial] = useState<{ theme: ThemeDefinition; page: string | null } | null>(null);
  const trying = trial && trial.page === page ? trial.theme : null;
  useEffect(() => {
    if (!trying) clearThemePreview();
  }, [trying]);
  useEffect(() => clearThemePreview, []);

  const tryOn = (theme: ThemeDefinition) => {
    setTrial({ theme, page });
    startThemePreview(theme.theme);
  };
  const stopTrying = () => setTrial(null);

  const handlers: ThemeHandlers = {
    select: (theme) => onSelect({ pubkey: theme.pubkey, identifier: theme.identifier }),
    tryOn,
  };

  const query = search.trim();
  const address = parseThemeNaddr(query);
  const lookup = useThemeDefinition(address);

  const matches = useMemo(() => {
    if (!query || address) return [];
    const q = query.toLowerCase();
    return catalog.themes.filter((theme) =>
      `${theme.title}\u0000${theme.description}\u0000${theme.identifier}`.toLowerCase().includes(q),
    );
  }, [query, address, catalog.themes]);

  const selectedTheme =
    selected &&
    catalog.themes.find((theme) => themeCoordinate(theme) === themeCoordinate(selected));

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        if (trying) {
          e.stopPropagation();
          stopTrying();
        } else if (selected) {
          e.stopPropagation();
          onSelect(null);
        }
      }}
    >
      {selected ? (
        <ThemeDetailPage
          key={themeCoordinate(selected)}
          address={selected}
          known={selectedTheme ?? null}
          more={catalog.themes.filter(
            (theme) =>
              theme.pubkey === selected.pubkey && theme.identifier !== selected.identifier,
          )}
          handlers={handlers}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6">
            {query ? (
              <section className="flex flex-col gap-4" aria-label="Search results">
                <SectionHeader
                  title={address ? 'Theme at this address' : `Results for “${query}”`}
                />
                {address ? (
                  lookup.isPending ? (
                    <ThemeGridSkeleton />
                  ) : lookup.data ? (
                    <ThemeGrid themes={[lookup.data]} handlers={handlers} />
                  ) : (
                    <EmptyState message="No theme is published at that address on your relays." />
                  )
                ) : matches.length > 0 ? (
                  <ThemeGrid themes={matches} handlers={handlers} />
                ) : catalog.isLoading ? (
                  <ThemeGridSkeleton />
                ) : (
                  <EmptyState
                    message={`No themes match “${query}”. You can also paste a theme’s address to find it.`}
                  />
                )}
              </section>
            ) : (
              <section className="flex flex-col gap-4" aria-label="Themes">
                <SectionHeader
                  title="Themes"
                  subtitle="Colors, fonts and pictures for your desktop, from Din’s publishers and the people you follow. Try one on before you keep it."
                />
                {catalog.isLoading ? (
                  <ThemeGridSkeleton />
                ) : catalog.isError ? (
                  <EmptyState message="Could not load themes. Check your relay connections and try refreshing." />
                ) : catalog.themes.length === 0 ? (
                  <EmptyState message="No themes found on your relays yet. Make one in Settings → Appearance and save it, or follow people who share theirs." />
                ) : (
                  <>
                    <ThemeGrid themes={catalog.themes} handlers={handlers} />
                    {catalog.hasMore && (
                      <MoreSentinel
                        onReached={() => void catalog.loadMore()}
                        paused={catalog.isLoadingMore}
                      />
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        </div>
      )}
      {trying && <PreviewBar theme={trying} onDone={stopTrying} />}
    </div>
  );
}

/** A theme author's name and picture. */
function useThemeAuthor(pubkey: string | undefined) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  return {
    name: (metadata?.display_name || metadata?.name)?.trim() || null,
    picture: metadata?.picture ? sanitizeImageUrl(metadata.picture) : null,
  };
}

function ThemeGrid({ themes, handlers }: { themes: ThemeDefinition[]; handlers: ThemeHandlers }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {themes.map((theme) => (
        <ThemeCard key={themeCoordinate(theme)} theme={theme} handlers={handlers} />
      ))}
    </div>
  );
}

function ThemeCard({ theme, handlers }: { theme: ThemeDefinition; handlers: ThemeHandlers }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const author = useThemeAuthor(seen ? theme.pubkey : undefined);

  return (
    <ThemeContextMenu theme={theme} handlers={handlers}>
      <div
        ref={ref}
        className="relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-shadow motion-safe:hover:shadow-md"
      >
        <button
          type="button"
          onClick={() => handlers.select(theme)}
          aria-label={`View details for ${theme.title}`}
          className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        {seen ? (
          <ThemeSwatch theme={theme.theme} className="border-b border-border" />
        ) : (
          <Skeleton className="aspect-video rounded-none" />
        )}
        <div className="flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold" title={theme.title}>
              {theme.title}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {author.name ? `by ${author.name}` : 'Theme'}
            </p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => handlers.tryOn(theme)}
            aria-label={`Try ${theme.title}`}
            title="Try"
            className="relative z-10 size-8 shrink-0 rounded-full"
          >
            <Eye aria-hidden />
          </Button>
          <GetThemePill theme={theme} />
        </div>
      </div>
    </ThemeContextMenu>
  );
}

/** A theme's right-click menu, mirroring its card's and page's buttons. */
function ThemeContextMenu({
  theme,
  handlers,
  children,
}: {
  theme: ThemeDefinition;
  handlers: ThemeHandlers;
  children: ReactNode;
}) {
  const actions = useThemeActions();
  const copy = useCopyThemeAddress();
  const own = actions.isOwn(theme);
  const added = actions.isAdded(theme);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => handlers.select(theme)}>
          <Info aria-hidden />
          View Details
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handlers.tryOn(theme)}>
          <Eye aria-hidden />
          Try
        </ContextMenuItem>
        {!own &&
          (added ? (
            <ContextMenuItem onSelect={() => actions.removeFromLibrary(theme)}>
              <X aria-hidden />
              Remove from My Themes
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => actions.add(theme)}>
              <Plus aria-hidden />
              Get
            </ContextMenuItem>
          ))}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copy(theme)}>
          <Copy aria-hidden />
          Copy Address
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function useCopyThemeAddress() {
  const { toast } = useToast();
  return (theme: ThemeDefinition) => {
    void navigator.clipboard
      .writeText(themeNaddr(theme))
      .then(() => toast({ title: 'Address copied' }));
  };
}

/**
 * "Get" adds someone else's theme to the user's themes; "Added" once it's
 * there, and "Yours" on the user's own.
 */
function GetThemePill({ theme, className }: { theme: ThemeDefinition; className?: string }) {
  const actions = useThemeActions();
  const { toast } = useToast();
  const { open } = useWindowActions();
  const own = actions.isOwn(theme);
  const added = actions.isAdded(theme);

  const get = () => {
    actions.add(theme);
    toast({
      title: `${theme.title} added`,
      description: 'Find it under Your Themes in Settings → Appearance.',
      actions: [{ id: 'settings', label: 'Open Settings' }],
      onAction: () => open('settings', { section: 'appearance' }),
    });
  };

  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={added ? undefined : get}
      aria-disabled={added}
      aria-label={own ? `${theme.title} is yours` : added ? `${theme.title} added` : `Get ${theme.title}`}
      className={cn(
        'relative z-10 h-8 shrink-0 rounded-full px-5 font-semibold',
        'bg-secondary text-primary hover:bg-secondary/80',
        added && 'cursor-default text-muted-foreground hover:bg-secondary',
        className,
      )}
    >
      {added && <Check aria-hidden />}
      {own ? 'Yours' : added ? 'Added' : 'Get'}
    </Button>
  );
}

/** A theme's page: a big preview, what it's made of, and who made it. */
function ThemeDetailPage({
  address,
  known,
  more,
  handlers,
}: {
  address: ThemeAddress;
  known: ThemeDefinition | null;
  more: ThemeDefinition[];
  handlers: ThemeHandlers;
}) {
  const lookup = useThemeDefinition(known ? null : address);
  const theme = known ?? lookup.data ?? null;
  const author = useThemeAuthor(address.pubkey);
  const copy = useCopyThemeAddress();
  const ref = useRef<HTMLDivElement>(null);

  // Take focus so Escape goes back without a click first.
  useEffect(() => ref.current?.focus(), []);

  if (!theme) {
    return (
      <div ref={ref} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
        <div className="mx-auto max-w-5xl p-4 sm:p-6">
          {lookup.isPending ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="aspect-video w-full max-w-2xl rounded-2xl" />
              <Skeleton className="h-8 w-1/3" />
            </div>
          ) : (
            <EmptyState message="This theme isn’t on your relays. It may have been deleted." />
          )}
        </div>
      </div>
    );
  }

  const updated = new Date(theme.createdAt * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const { colors, fonts, background } = theme.theme;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-y-auto outline-none"
      aria-label={`${theme.title} details`}
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          <ThemeSwatch
            theme={theme.theme}
            className="w-full max-w-2xl shrink-0 rounded-2xl border border-border shadow-md lg:w-3/5"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="min-w-0">
              <h1 className="break-words text-3xl font-bold tracking-tight">{theme.title}</h1>
              {author.name && (
                <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                  <Avatar className="size-5">
                    {author.picture && <AvatarImage src={author.picture} alt="" />}
                    <AvatarFallback className="text-[10px]">
                      {author.name.slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">{author.name}</span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => handlers.tryOn(theme)} className="h-8 rounded-full px-4">
                <Eye aria-hidden />
                Try
              </Button>
              <GetThemePill theme={theme} />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copy(theme)}
                className="h-8 rounded-full px-4"
              >
                <Copy aria-hidden />
                Copy Address
              </Button>
            </div>
          </div>
        </div>

        {theme.description ? (
          <p className="max-w-prose whitespace-pre-line text-base leading-relaxed">
            {theme.description}
          </p>
        ) : (
          <p className="text-muted-foreground">This theme doesn’t describe itself.</p>
        )}

        <section className="flex flex-col gap-4" aria-label="Information">
          <SectionHeader title="Information" />
          <dl className="grid grid-cols-1 divide-y divide-border rounded-2xl border border-border bg-card text-sm">
            <InfoRow label="Colors">
              <span className="flex items-center justify-end gap-2">
                {(['background', 'text', 'primary'] as const).map((role) => (
                  <span
                    key={role}
                    title={`${role === 'primary' ? 'Accent' : role === 'text' ? 'Text' : 'Background'} ${colors[role]}`}
                    className="size-5 rounded-full border border-border"
                    style={{ backgroundColor: colors[role] }}
                  />
                ))}
              </span>
            </InfoRow>
            <InfoRow label="Text font">{fonts.body?.family ?? 'Default (Inter)'}</InfoRow>
            <InfoRow label="Title font">{fonts.title?.family ?? 'Default (Inter)'}</InfoRow>
            <InfoRow label="Picture">
              {background ? (background.mode === 'tile' ? 'Tiled' : 'Fills the screen') : 'None'}
            </InfoRow>
            <InfoRow label="Creator">{author.name ?? 'Unknown'}</InfoRow>
            <InfoRow label="Updated">{updated}</InfoRow>
          </dl>
        </section>

        {more.length > 0 && (
          <section className="flex flex-col gap-4" aria-label="More from this creator">
            <SectionHeader title={author.name ? `More from ${author.name}` : 'More from this creator'} />
            <ThemeGrid themes={more} handlers={handlers} />
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
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/**
 * Shown while a theme is tried on: keep it (with Undo in the notification)
 * or go back to the one worn.
 */
function PreviewBar({ theme, onDone }: { theme: ThemeDefinition; onDone: () => void }) {
  const editor = useDesktopThemeEditor();
  const { toast } = useToast();
  const author = useThemeAuthor(theme.pubkey);

  const keep = () => {
    const previous = editor.snapshot();
    try {
      editor.apply(theme.theme);
    } catch (error) {
      toast({
        title: 'Couldn’t use this theme',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
      return;
    }
    onDone();
    toast({
      title: `Now using ${theme.title}`,
      description: editor.syncing ? 'It’s your profile theme too.' : undefined,
      actions: [{ id: 'undo', label: 'Undo' }],
      onAction: () => editor.restore(previous),
    });
  };

  return (
    <div
      role="region"
      aria-label="Theme preview"
      className="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-3 shadow-[0_-4px_16px_-8px_rgb(0_0_0/0.2)]"
    >
      <Eye className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 truncate text-sm">
        Trying <span className="font-semibold">{theme.title}</span>
        {author.name && <span className="text-muted-foreground"> by {author.name}</span>}
      </p>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      <Button size="sm" onClick={keep}>
        Use This Theme
      </Button>
    </div>
  );
}

function ThemeGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-border bg-card">
          <Skeleton className="aspect-video rounded-none" />
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
