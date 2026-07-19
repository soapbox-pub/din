import { useCallback, useMemo } from 'react';
import { useNostr } from '@nostrify/react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import {
  classifyNotification,
  getEnabledNotificationKinds,
  getNotificationActor,
  getReferencedEventId,
  type NotificationKind,
} from '@/lib/notifications';

const PAGE_SIZE = 30;

/** A single notification: the interaction event plus the post it refers to. */
export interface NotificationItem {
  /** The interaction event (reaction, repost, zap, mention, comment). */
  event: NostrEvent;
  /** The pubkey that performed the interaction (zap sender for zaps). */
  actor: string;
  /** Display bucket for the interaction. */
  type: NotificationKind;
  /** The referenced post (liked/reposted/zapped), if fetched. */
  referencedEvent?: NostrEvent;
  /** True when this event is newer than the read cursor. */
  isNew: boolean;
}

interface NotificationPage {
  items: NotificationItem[];
  /** Oldest event timestamp in the page, for cursor pagination. */
  oldestTimestamp: number;
  /** Newest raw event timestamp, for advancing the read cursor. */
  newestTimestamp: number;
}

export interface NotificationData {
  items: NotificationItem[];
  /** Whether any notification is newer than the read cursor. */
  hasUnread: boolean;
  /** Count of unread notifications currently loaded. */
  unreadCount: number;
  /** Advance the read cursor past everything currently loaded. */
  markAsRead: () => void;
  isLoading: boolean;
  hasFetched: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

/**
 * Query the logged-in user's notifications (mentions, reposts, reactions,
 * comments, zaps) with infinite-scroll pagination and unread tracking.
 *
 * Per-type preferences and the "only from people I follow" gate are applied at
 * query time (relay-level `kinds` / `authors`), matching the cheap unread
 * check in {@link useHasUnreadNotifications}. Real-time updates arrive through
 * the always-mounted notifications watcher, which invalidates this query when a
 * new event lands on the persistent relay subscription.
 */
export function useNotifications(): NotificationData {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const { preferences, cursor, setCursor } = useNotificationSettings();

  const enabledKinds = useMemo(
    () => getEnabledNotificationKinds(preferences),
    [preferences],
  );
  const kindsKey = [...enabledKinds].sort((a, b) => a - b).join(',');

  const following = useFollowingPubkeys(preferences.onlyFollowing);
  const authorsFilter =
    preferences.onlyFollowing && following.length > 0 ? following : undefined;
  const authorsKey = authorsFilter ? authorsFilter.slice().sort().join(',') : 'all';

  const query = useInfiniteQuery<NotificationPage, Error>({
    queryKey: ['notifications', user?.pubkey ?? '', kindsKey, authorsKey],
    enabled: !!user,
    staleTime: 30_000,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.items.length === 0 ? undefined : lastPage.oldestTimestamp - 1,
    queryFn: async ({ pageParam, signal }) => {
      if (!user) {
        return { items: [], oldestTimestamp: Math.floor(Date.now() / 1000), newestTimestamp: 0 };
      }

      const filter: {
        kinds: number[];
        '#p': string[];
        limit: number;
        authors?: string[];
        until?: number;
      } = { kinds: enabledKinds, '#p': [user.pubkey], limit: PAGE_SIZE };
      if (authorsFilter) filter.authors = authorsFilter;
      if (typeof pageParam === 'number') filter.until = pageParam;

      const events = await nostr.query([filter], {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });

      const filtered = events
        .filter((e) => getNotificationActor(e) !== user.pubkey)
        .sort((a, b) => b.created_at - a.created_at);

      const oldestTimestamp = filtered.length
        ? Math.min(...filtered.map((e) => e.created_at))
        : Math.floor(Date.now() / 1000);
      const newestTimestamp = filtered.length
        ? Math.max(...filtered.map((e) => e.created_at))
        : 0;

      // Batch-fetch the posts that reactions/reposts/zaps/comments refer to.
      const referencedIds = Array.from(
        new Set(
          filtered
            .filter((e) => e.kind !== 1)
            .map((e) => getReferencedEventId(e))
            .filter((id): id is string => !!id),
        ),
      );

      const referencedMap = new Map<string, NostrEvent>();
      const uncached: string[] = [];
      for (const id of referencedIds) {
        const cached = queryClient.getQueryData<NostrEvent | null>(['event', id]);
        if (cached) referencedMap.set(id, cached);
        else uncached.push(id);
      }
      if (uncached.length) {
        try {
          const refEvents = await nostr.query([{ ids: uncached, limit: uncached.length }], {
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          });
          for (const refEv of refEvents) {
            referencedMap.set(refEv.id, refEv);
            if (!queryClient.getQueryData(['event', refEv.id])) {
              queryClient.setQueryData(['event', refEv.id], refEv);
            }
          }
        } catch {
          // Timeout — referenced posts just render without their context.
        }
      }

      const items: NotificationItem[] = filtered.flatMap((event) => {
        const refId = event.kind !== 1 ? getReferencedEventId(event) : undefined;
        const referencedEvent = refId ? referencedMap.get(refId) : undefined;

        // Reactions/reposts on a post we can confirm belongs to someone else
        // are drops (the user was only tagged in them). When the referenced
        // post couldn't be fetched, keep the notification rather than lose it.
        if (event.kind === 6 || event.kind === 16 || event.kind === 7) {
          if (referencedEvent && referencedEvent.pubkey !== user.pubkey) return [];
        }

        return [{
          event,
          actor: getNotificationActor(event),
          type: classifyNotification(event),
          referencedEvent,
          isNew: event.created_at > cursor,
        }];
      });

      return { items, oldestTimestamp, newestTimestamp };
    },
  });

  const pages = query.data?.pages;

  const items = useMemo(() => {
    if (!pages) return [];
    const seen = new Set<string>();
    return pages
      .flatMap((page) => page.items)
      .filter((item) => {
        if (seen.has(item.event.id)) return false;
        seen.add(item.event.id);
        return true;
      })
      // Recompute freshness against the live cursor (it can change post-fetch).
      .map((item) => ({ ...item, isNew: item.event.created_at > cursor }));
  }, [pages, cursor]);

  const newestTimestamp = useMemo(() => {
    if (!pages) return 0;
    return Math.max(0, ...pages.map((p) => p.newestTimestamp));
  }, [pages]);

  const unreadCount = useMemo(
    () => items.filter((item) => item.isNew).length,
    [items],
  );
  const hasUnread = newestTimestamp > cursor;

  const markAsRead = useCallback(() => {
    if (newestTimestamp > cursor) setCursor(newestTimestamp);
  }, [newestTimestamp, cursor, setCursor]);

  return {
    items,
    hasUnread,
    unreadCount,
    markAsRead,
    isLoading: query.isLoading,
    hasFetched: query.isFetched,
    hasNextPage: query.hasNextPage ?? false,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  };
}

/**
 * Cheap check for whether the user has any unread notifications, for the
 * menu-bar bell badge. Fetches at most one event (relay-level `since` filter),
 * respecting the same per-type preferences and follow gate as the full list.
 */
export function useHasUnreadNotifications(): boolean {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { preferences, cursor } = useNotificationSettings();

  const enabledKinds = useMemo(
    () => getEnabledNotificationKinds(preferences),
    [preferences],
  );
  const kindsKey = [...enabledKinds].sort((a, b) => a - b).join(',');

  const following = useFollowingPubkeys(preferences.onlyFollowing);
  const authorsFilter =
    preferences.onlyFollowing && following.length > 0 ? following : undefined;
  const authorsKey = authorsFilter ? authorsFilter.slice().sort().join(',') : 'all';

  const { data = false } = useQuery<boolean>({
    queryKey: ['notifications-unread', user?.pubkey ?? '', kindsKey, authorsKey, cursor],
    enabled: !!user,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      if (!user) return false;
      const filter: {
        kinds: number[];
        '#p': string[];
        since: number;
        limit: number;
        authors?: string[];
      } = {
        kinds: enabledKinds,
        '#p': [user.pubkey],
        since: cursor + 1,
        limit: 1,
        ...(authorsFilter ? { authors: authorsFilter } : {}),
      };
      const events = await nostr.query([filter], {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      return events.some((e) => getNotificationActor(e) !== user.pubkey);
    },
  });

  return data;
}
