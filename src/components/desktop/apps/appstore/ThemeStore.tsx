import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff, Info, Paintbrush, Undo2, X } from 'lucide-react';
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
import { useAuthor } from '@/hooks/useAuthor';
import { useDesktopThemeEditor, type ThemeSnapshot } from '@/hooks/useDesktopTheme';
import { useToast } from '@/hooks/useToast';
import { useThemeActions, useThemeCatalog, useThemeDefinition } from '@/hooks/useThemes';
import { sameThemeLook } from '@/lib/profileTheme';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import {
  parseThemeNaddr,
  themeCoordinate,
  themeNaddr,
  type ThemeDefinition,
} from '@/lib/themeDefinition';
import { cn } from '@/lib/utils';
import { settingsGroup } from '@/shared/settingsChromeStyles';

export type ThemeAddress = { pubkey: string; identifier: string };

type ThemeCatalog = ReturnType<typeof useThemeCatalog>;

/** What a card or detail page can do with a theme; shared by its buttons and right-click menu. */
interface ThemeHandlers {
  select: (theme: ThemeDefinition) => void;
  use: (theme: ThemeDefinition) => void;
  isWorn: (theme: ThemeDefinition) => boolean;
  /** Wear a theme without adding it to the user's themes, until it's stopped or used. */
  tryOn: (theme: ThemeDefinition) => void;
  stopTrying: () => void;
  isTrying: (theme: ThemeDefinition) => boolean;
}

/** A theme being tried on, and what was worn before it. */
interface Trial {
  theme: ThemeDefinition;
  previous: ThemeSnapshot;
}

/** What was worn before a run of themes was put on, and what that run added to the user's themes. */
interface Streak {
  previous: ThemeSnapshot;
  added: ThemeDefinition[];
  current: ThemeDefinition;
}

/**
 * The App Store's Themes: named themes (kind 36767) from the catalog's
 * publishers, the people the user follows, and the user (useThemeCatalog).
 *
 * Clicking a theme opens its page. Try On wears it without adding it to
 * anything, until Stop Trying On (or leaving the Themes page) puts back what
 * was worn before. Use wears it and adds it to the user's themes, which
 * Settings → Themes lists. A bar then offers Revert, which puts back what
 * was worn before the first theme used and takes back what Use added.
 *
 * Themes used are held: the profile theme is published when the bar is
 * dismissed, the Themes page closes, or a while passes untouched, so
 * clicking around doesn't publish every theme on the way.
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
  const editor = useDesktopThemeEditor();
  const actions = useThemeActions();
  const { toast } = useToast();
  const [streak, setStreak] = useState<Streak | null>(null);
  const [trial, setTrial] = useState<Trial | null>(null);

  // Leaving takes off what's being tried on, and sends what was used.
  const { commit, restore } = editor;
  const leave = useRef(() => {});
  useEffect(() => {
    leave.current = () => {
      if (trial) restore(trial.previous);
      else commit();
    };
  }, [trial, restore, commit]);
  useEffect(() => () => leave.current(), []);

  const sameTheme = (a: ThemeDefinition, b: ThemeDefinition) => a.pubkey === b.pubkey && a.identifier === b.identifier;
  const isTrying = (theme: ThemeDefinition) => !!trial && sameTheme(trial.theme, theme);

  const isWorn = (theme: ThemeDefinition) =>
    !isTrying(theme) &&
    !!editor.theme &&
    editor.theme.source?.pubkey === theme.pubkey &&
    editor.theme.source.identifier === theme.identifier &&
    sameThemeLook(editor.theme, theme.theme);

  const wear = (theme: ThemeDefinition, failure: string): boolean => {
    try {
      editor.apply(theme.theme, { hold: true });
      return true;
    } catch (error) {
      toast({
        title: failure,
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
      return false;
    }
  };

  const tryOn = (theme: ThemeDefinition) => {
    if (isTrying(theme) || isWorn(theme)) return;
    const previous = trial?.previous ?? editor.snapshot();
    if (wear(theme, 'Couldn’t try on this theme')) setTrial({ theme, previous });
  };

  const stopTrying = () => {
    if (!trial) return;
    try {
      editor.restore(trial.previous);
    } catch (error) {
      toast({
        title: 'Couldn’t take it off',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
      return;
    }
    setTrial(null);
  };

  const use = (theme: ThemeDefinition) => {
    if (isWorn(theme)) return;
    // What was worn before trying on is what Revert puts back.
    const previous = trial?.previous ?? editor.snapshot();
    if (!isTrying(theme) && !wear(theme, 'Couldn’t use this theme')) return;
    setTrial(null);
    const adds = !actions.isAdded(theme);
    if (adds) actions.add(theme);
    setStreak((prev) => ({
      previous: prev?.previous ?? previous,
      added: adds ? [...(prev?.added ?? []), theme] : (prev?.added ?? []),
      current: theme,
    }));
  };

  const revert = () => {
    if (!streak) return;
    try {
      editor.restore(streak.previous);
    } catch (error) {
      toast({
        title: 'Couldn’t revert',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
      return;
    }
    for (const theme of streak.added) actions.removeFromLibrary(theme);
    setStreak(null);
  };

  const handlers: ThemeHandlers = {
    select: (theme) => onSelect({ pubkey: theme.pubkey, identifier: theme.identifier }),
    use,
    isWorn,
    tryOn,
    stopTrying,
    isTrying,
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
        if (e.key !== 'Escape' || !selected) return;
        e.stopPropagation();
        onSelect(null);
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
          <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 @2xl:p-6">
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
                  subtitle="Colors, fonts and pictures for your desktop, from Din’s publishers and the people you follow. Try one on to see it on your desktop."
                />
                {catalog.isLoading ? (
                  <ThemeGridSkeleton />
                ) : catalog.isError ? (
                  <EmptyState message="Could not load themes. Check your relay connections and try refreshing." />
                ) : catalog.themes.length === 0 ? (
                  <EmptyState message="No themes found on your relays yet. Make one in Settings → Themes and save it, or follow people who share theirs." />
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
      {trial ? (
        <TryOnBar theme={trial.theme} handlers={handlers} />
      ) : streak && (
        <RevertBar
          theme={streak.current}
          onRevert={revert}
          onDone={() => {
            commit();
            setStreak(null);
          }}
        />
      )}
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
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-5">
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
        className="relative flex flex-col overflow-hidden rounded-xl bg-card clay transition-shadow motion-safe:hover:shadow-md"
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
            <p className="truncate text-base font-semibold" title={theme.title}>
              {theme.title}
            </p>
            <p className="truncate text-sm text-muted-foreground">
              {author.name ? `by ${author.name}` : 'Theme'}
            </p>
          </div>
          {!handlers.isWorn(theme) && <TryOnThemeButton theme={theme} handlers={handlers} />}
          <UseThemePill theme={theme} handlers={handlers} />
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
  const removable = !actions.isOwn(theme) && actions.isAdded(theme);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => handlers.use(theme)} disabled={handlers.isWorn(theme)}>
          <Paintbrush aria-hidden />
          Use
        </ContextMenuItem>
        {!handlers.isWorn(theme) && (
          <ContextMenuItem onSelect={() => (handlers.isTrying(theme) ? handlers.stopTrying() : handlers.tryOn(theme))}>
            {handlers.isTrying(theme) ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            {handlers.isTrying(theme) ? 'Stop Trying On' : 'Try On'}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => handlers.select(theme)}>
          <Info aria-hidden />
          View Details
        </ContextMenuItem>
        {removable && (
          <ContextMenuItem onSelect={() => actions.removeFromLibrary(theme)}>
            <X aria-hidden />
            Remove from My Themes
          </ContextMenuItem>
        )}
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

/** "Use" wears a theme; "In Use" on the one worn. */
function UseThemePill({ theme, handlers }: { theme: ThemeDefinition; handlers: ThemeHandlers }) {
  const worn = handlers.isWorn(theme);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={worn ? undefined : () => handlers.use(theme)}
      aria-disabled={worn}
      aria-label={worn ? `${theme.title} is in use` : `Use ${theme.title}`}
      className={cn(
        'relative z-10 h-8 shrink-0 rounded-full px-5 font-semibold',
        'bg-secondary text-ink-accent hover:bg-secondary/80',
        worn && 'cursor-default text-muted-foreground hover:bg-secondary',
      )}
    >
      {worn && <Check aria-hidden />}
      {worn ? 'In Use' : 'Use'}
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
        <div className="mx-auto max-w-5xl p-4 @2xl:p-6">
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
      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 @2xl:p-6">
        <div className="flex flex-col gap-6 @5xl:flex-row @5xl:items-center">
          <button
            type="button"
            onClick={() => (handlers.isTrying(theme) ? handlers.stopTrying() : handlers.tryOn(theme))}
            aria-label={handlers.isTrying(theme) ? `Stop trying on ${theme.title}` : `Try on ${theme.title}`}
            className="w-full max-w-2xl shrink-0 overflow-hidden rounded-2xl border border-border shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 @5xl:w-3/5"
          >
            <ThemeSwatch theme={theme.theme} />
          </button>
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
              <UseThemePill theme={theme} handlers={handlers} />
              {!handlers.isWorn(theme) && <TryOnThemeButton theme={theme} handlers={handlers} />}
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
          <dl className={cn(settingsGroup, 'text-sm')}>
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

/** Try On, or Stop Trying On the one being tried. */
function TryOnThemeButton({ theme, handlers }: { theme: ThemeDefinition; handlers: ThemeHandlers }) {
  const trying = handlers.isTrying(theme);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => (trying ? handlers.stopTrying() : handlers.tryOn(theme))}
      aria-label={trying ? `Stop trying on ${theme.title}` : `Try on ${theme.title}`}
      title={trying ? 'Stop Trying On' : 'Try On'}
      className="relative z-10 h-8 shrink-0 rounded-full px-4"
    >
      {trying ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      {trying ? 'Stop' : 'Try On'}
    </Button>
  );
}

/** Shown while a theme is tried on: Use keeps it, the X takes it off. */
function TryOnBar({ theme, handlers }: { theme: ThemeDefinition; handlers: ThemeHandlers }) {
  const author = useThemeAuthor(theme.pubkey);

  return (
    <div
      role="region"
      aria-label="Trying on"
      className="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-3 shadow-[0_-4px_16px_-8px_rgb(0_0_0/0.2)]"
    >
      <Eye className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 truncate text-sm">
        Trying on <span className="font-semibold">{theme.title}</span>
        {author.name && <span className="text-muted-foreground"> by {author.name}</span>}
      </p>
      <UseThemePill theme={theme} handlers={handlers} />
      <Button size="icon" variant="ghost" onClick={handlers.stopTrying} aria-label="Stop trying on" title="Stop Trying On" className="size-8 rounded-full">
        <X aria-hidden />
      </Button>
    </div>
  );
}

/** Shown once a theme is put on: Revert goes back to what was worn before. */
function RevertBar({
  theme,
  onRevert,
  onDone,
}: {
  theme: ThemeDefinition;
  onRevert: () => void;
  onDone: () => void;
}) {
  const author = useThemeAuthor(theme.pubkey);

  return (
    <div
      role="region"
      aria-label="Theme in use"
      className="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-3 shadow-[0_-4px_16px_-8px_rgb(0_0_0/0.2)]"
    >
      <Paintbrush className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 truncate text-sm">
        Now using <span className="font-semibold">{theme.title}</span>
        {author.name && <span className="text-muted-foreground"> by {author.name}</span>}
      </p>
      <Button size="sm" variant="secondary" onClick={onRevert}>
        <Undo2 aria-hidden />
        Revert
      </Button>
      <Button size="icon" variant="ghost" onClick={onDone} aria-label="Dismiss" className="size-8">
        <X aria-hidden />
      </Button>
    </div>
  );
}

function ThemeGridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-5">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl bg-card clay">
          <Skeleton className="aspect-video rounded-none" />
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
