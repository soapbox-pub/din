import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { z } from 'zod';
import { useAppData } from '@/hooks/useAppData';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import { useManifestRelays } from '@/hooks/useNsiteCatalog';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useUploadLocalPicture } from '@/hooks/useUploadLocalPicture';
import { NSITE_CATALOG_PUBKEYS } from '@/lib/nsiteCatalog';
import { isLocalBackground, toProfileTheme, type DesktopTheme } from '@/lib/profileTheme';
import {
  THEME_DEFINITION_KIND,
  buildThemeCatalog,
  buildThemeDefinitionTags,
  parseThemeDefinition,
  themeCoordinate,
  titleToSlug,
  type ThemeDefinition,
} from '@/lib/themeDefinition';

/** How many named themes the store asks for at a time. */
const THEME_PAGE = 40;

/** Kind 5 deletions of named themes, by the given authors. */
function deletionsFilter(authors: string[]): NostrFilter {
  return { kinds: [5], authors, '#k': [String(THEME_DEFINITION_KIND)] };
}

/**
 * The App Store's themes: named themes (kind 36767) by the same publishers
 * whose apps it offers, plus the user and the people they follow, from the
 * user's read relays and the catalog relay. Paged newest first.
 */
export function useThemeCatalog(enabled = true) {
  const relays = useManifestRelays();
  const { user } = useCurrentUser();
  const following = useFollowingPubkeys();

  const authors = useMemo(() => {
    const set = new Set(NSITE_CATALOG_PUBKEYS);
    if (user) set.add(user.pubkey);
    for (const pubkey of following) set.add(pubkey);
    return [...set];
  }, [user, following]);

  const query = useInfiniteQuery({
    queryKey: ['theme-catalog', authors],
    enabled,
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const allowed = new Set(authors);
      const filters: NostrFilter[] = [
        { kinds: [THEME_DEFINITION_KIND], authors, limit: THEME_PAGE, until: pageParam },
      ];
      // Deletions only need asking for once.
      if (pageParam === undefined) filters.push(deletionsFilter(authors));
      const events = await relays.query(filters, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      // The author is the only trust boundary for an addressable event.
      return events.filter((event) => allowed.has(event.pubkey));
    },
    getNextPageParam: (page) => {
      const themes = page.filter((event) => event.kind === THEME_DEFINITION_KIND);
      if (themes.length < THEME_PAGE) return undefined;
      return Math.min(...themes.map((event) => event.created_at)) - 1;
    },
    staleTime: 60_000,
  });

  const themes = useMemo(
    () => buildThemeCatalog(query.data?.pages.flat() ?? []),
    [query.data],
  );

  return {
    themes,
    isLoading: query.isPending && query.fetchStatus !== 'idle',
    isError: query.isError,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: query.fetchNextPage,
    refresh: query.refetch,
    refreshing: query.isRefetching,
  };
}

/** One named theme, by its author and `d` tag. */
export function useThemeDefinition(address: { pubkey: string; identifier: string } | null) {
  const relays = useManifestRelays();
  return useQuery({
    queryKey: ['theme-definition', address?.pubkey, address?.identifier],
    enabled: !!address,
    queryFn: async ({ signal }) => {
      if (!address) return null;
      const events = await relays.query(
        [
          { kinds: [THEME_DEFINITION_KIND], authors: [address.pubkey], '#d': [address.identifier] },
          { ...deletionsFilter([address.pubkey]), '#a': [themeCoordinate(address)] },
        ],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return (
        buildThemeCatalog(events.filter((event) => event.pubkey === address.pubkey))[0] ?? null
      );
    },
  });
}

const ThemeLibrarySchema = z.array(
  z.object({
    /** The theme's `36767:<pubkey>:<d>` coordinate. */
    a: z.string(),
    /** When it was added, in Unix seconds. */
    addedAt: z.number(),
  }),
);

type ThemeLibraryEntries = z.infer<typeof ThemeLibrarySchema>;

const NO_THEMES: ThemeLibraryEntries = [];

/** The other people's themes the user has added, kept as encrypted app data. */
function useLibraryEntries() {
  return useAppData('themes', ThemeLibrarySchema, NO_THEMES);
}

function parseCoordinate(a: string): { pubkey: string; identifier: string } | null {
  const [kind, pubkey, ...rest] = a.split(':');
  const identifier = rest.join(':');
  if (kind !== String(THEME_DEFINITION_KIND) || !/^[0-9a-f]{64}$/.test(pubkey ?? '') || !identifier) {
    return null;
  }
  return { pubkey, identifier };
}

/**
 * The user's themes: the named themes they've published, and the ones by
 * other people they've added from the store, each the newest version on
 * their relays.
 */
export function useThemeLibrary() {
  const relays = useManifestRelays();
  const { user } = useCurrentUser();
  const [entries] = useLibraryEntries();
  const pubkey = user?.pubkey;

  const added = useMemo(
    () =>
      entries.flatMap((entry) => {
        const address = parseCoordinate(entry.a);
        return address && address.pubkey !== pubkey ? [{ ...address, a: entry.a }] : [];
      }),
    [entries, pubkey],
  );

  const query = useQuery<ThemeDefinition[]>({
    queryKey: ['theme-library', pubkey ?? '', added.map((entry) => entry.a)],
    enabled: !!pubkey || added.length > 0,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) => {
      const filters: NostrFilter[] = [];
      if (pubkey) {
        filters.push({ kinds: [THEME_DEFINITION_KIND], authors: [pubkey] }, deletionsFilter([pubkey]));
      }
      const byAuthor = new Map<string, string[]>();
      for (const entry of added) {
        byAuthor.set(entry.pubkey, [...(byAuthor.get(entry.pubkey) ?? []), entry.identifier]);
      }
      for (const [author, identifiers] of byAuthor) {
        filters.push({ kinds: [THEME_DEFINITION_KIND], authors: [author], '#d': identifiers });
      }
      if (byAuthor.size) filters.push(deletionsFilter([...byAuthor.keys()]));

      const events = await relays.query(filters, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      const wanted = new Set(added.map((entry) => entry.a));
      const trusted = events.filter(
        (event) =>
          event.pubkey === pubkey ||
          (byAuthor.has(event.pubkey) &&
            (event.kind === 5 || wanted.has(themeCoordinateOf(event)))),
      );
      return buildThemeCatalog(trusted);
    },
  });

  const themes = query.data;
  return useMemo(() => {
    const all = themes ?? [];
    const order = new Map(entries.map((entry, i) => [entry.a, i]));
    return {
      own: all.filter((theme) => theme.pubkey === pubkey),
      added: all
        .filter((theme) => theme.pubkey !== pubkey)
        .sort((a, b) => (order.get(themeCoordinate(b)) ?? 0) - (order.get(themeCoordinate(a)) ?? 0)),
      isLoading: query.isPending && query.fetchStatus !== 'idle',
    };
  }, [themes, entries, pubkey, query.isPending, query.fetchStatus]);
}

function themeCoordinateOf(event: NostrEvent): string {
  const d = event.tags.find(([name]) => name === 'd')?.[1] ?? '';
  return `${event.kind}:${event.pubkey}:${d}`;
}

/**
 * Adding, saving and deleting themes: other people's go in the library,
 * the user's own are published as kind 36767 and deleted with kind 5.
 */
export function useThemeActions() {
  const { user } = useCurrentUser();
  const [entries, setEntries] = useLibraryEntries();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const uploadPicture = useUploadLocalPicture();
  const queryClient = useQueryClient();
  const pubkey = user?.pubkey;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['theme-library'] });
    void queryClient.invalidateQueries({ queryKey: ['theme-catalog'] });
  }, [queryClient]);

  const isOwn = useCallback(
    (theme: { pubkey: string }) => theme.pubkey === pubkey,
    [pubkey],
  );

  const isAdded = useCallback(
    (theme: { pubkey: string; identifier: string }) =>
      theme.pubkey === pubkey || entries.some((entry) => entry.a === themeCoordinate(theme)),
    [entries, pubkey],
  );

  const add = useCallback(
    (theme: ThemeDefinition) => {
      const a = themeCoordinate(theme);
      setEntries((prev) =>
        prev.some((entry) => entry.a === a)
          ? prev
          : [...prev, { a, addedAt: Math.floor(Date.now() / 1000) }],
      );
    },
    [setEntries],
  );

  const removeFromLibrary = useCallback(
    (theme: ThemeDefinition) => {
      const a = themeCoordinate(theme);
      setEntries((prev) => prev.filter((entry) => entry.a !== a));
    },
    [setEntries],
  );

  /**
   * Publish a named theme: a new one under a `d` made from its title, or a
   * new version of one of the user's own under its `d`. A background on this
   * computer is uploaded first.
   */
  const publish = useCallback(
    async ({
      theme,
      title,
      description,
      identifier,
    }: {
      theme: DesktopTheme;
      title: string;
      description?: string;
      identifier?: string;
    }): Promise<ThemeDefinition> => {
      if (!pubkey) throw new Error('Log in to save themes.');
      let look = theme;
      const background = theme.background;
      if (background && isLocalBackground(background.url)) {
        const path = decodeURIComponent(new URL(background.url).pathname);
        const url = await uploadPicture(path, background.mimeType);
        look = { ...theme, background: { ...background, url } };
      }
      const profile = toProfileTheme(look);
      if (!profile) throw new Error('This theme can’t be published.');
      const d = identifier ?? (titleToSlug(title) || `theme-${Date.now()}`);
      const event = await publishEvent({
        kind: THEME_DEFINITION_KIND,
        content: '',
        tags: buildThemeDefinitionTags(profile, { identifier: d, title, description }),
      });
      const published = parseThemeDefinition(event);
      if (!published) throw new Error('The theme was published, but can’t be read back.');
      refresh();
      return published;
    },
    [pubkey, uploadPicture, publishEvent, refresh],
  );

  /** Delete one of the user's own named themes (NIP-09). */
  const remove = useCallback(
    async (theme: ThemeDefinition) => {
      await publishEvent({
        kind: 5,
        content: '',
        tags: [
          ['e', theme.event.id],
          ['a', themeCoordinate(theme)],
          ['k', String(THEME_DEFINITION_KIND)],
        ],
      });
      // Out of the lists at once, before the relays are asked again.
      queryClient.setQueriesData<ThemeDefinition[]>({ queryKey: ['theme-library'] }, (old) =>
        old?.filter((t) => themeCoordinate(t) !== themeCoordinate(theme)),
      );
      refresh();
    },
    [publishEvent, queryClient, refresh],
  );

  return { isOwn, isAdded, add, removeFromLibrary, publish, remove };
}
