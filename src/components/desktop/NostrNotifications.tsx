import { useEffect, useMemo, useRef } from 'react';
import { useNostr } from '@nostrify/react';
import { useQueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import type { NostrEvent, NostrMetadata } from '@nostrify/nostrify';

import { fetchAuthor } from '@/hooks/useAuthor';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { readProfileCache } from '@/lib/profileCache';
import { notify } from '@/lib/notificationCenter';
import {
  classifyNotification,
  getEnabledNotificationKinds,
  getNotificationActor,
  getZapAmountSats,
  notificationTargetUrl,
  NOTIFICATION_KIND_META,
  type NotificationKind,
} from '@/lib/notifications';

/**
 * Nostr notifications watcher.
 *
 * Holds a single always-on relay subscription (`#p: [user.pubkey]`, the
 * enabled kinds, `since: now`) so notifications arrive in real time without
 * polling. Every new event invalidates the notification query caches (so the
 * menu-bar clock's unread dot and list refresh), and - when the on-screen alerts
 * preference is on - pops it up through the notification center. Nostr's
 * history lives on relays, so these popups stay out of the center's list.
 *
 * Renders nothing.
 */
export function NostrNotifications() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const openUrl = useOpenUrl();
  const { preferences } = useNotificationSettings();

  const enabledKinds = useMemo(
    () => getEnabledNotificationKinds(preferences),
    [preferences],
  );
  const kindsKey = enabledKinds.join(',');

  const following = useFollowingPubkeys(preferences.onlyFollowing);
  const authorsFilter =
    preferences.onlyFollowing && following.length > 0 ? following : undefined;
  const authorsKey = authorsFilter ? authorsFilter.slice().sort().join(',') : 'all';

  // Read the OSD toggle and the opener without resubscribing when they
  // change: invalidation must keep running for the badge even when the popup
  // is disabled.
  const osdEnabledRef = useRef(preferences.osd);
  const openUrlRef = useRef(openUrl);
  useEffect(() => {
    osdEnabledRef.current = preferences.osd;
    openUrlRef.current = openUrl;
  }, [preferences.osd, openUrl]);

  useEffect(() => {
    if (!user) return;

    const ac = new AbortController();
    const since = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();

    const popUp = async (event: NostrEvent, actor: string) => {
      const author = await queryClient
        .fetchQuery({
          queryKey: ['nostr', 'author', actor],
          queryFn: () => fetchAuthor(nostr, actor),
          staleTime: 5 * 60 * 1000,
        })
        .catch(() => readProfileCache(actor));
      if (ac.signal.aborted) return;
      const metadata: NostrMetadata | undefined = author?.metadata;
      const type = classifyNotification(event);
      const meta = NOTIFICATION_KIND_META[type];
      notify({
        id: `nostr:${event.id}`,
        source: { name: 'Nostr', icon: meta.icon },
        title: `${metadata?.name?.trim() || genericName(actor)} ${meta.verb}`,
        body: popupDetail(type, event),
        image: metadata?.picture ?? null,
        imageRound: true,
        badge: meta.icon,
        history: false,
        onActivate: () => openUrlRef.current(notificationTargetUrl({ type, event, actor })),
      });
    };

    (async () => {
      try {
        for await (const msg of nostr.req(
          [{
            kinds: enabledKinds,
            '#p': [user.pubkey],
            since,
            ...(authorsFilter ? { authors: authorsFilter } : {}),
          }],
          { signal: ac.signal },
        )) {
          if (msg[0] !== 'EVENT') continue;
          const event = msg[2];
          const actor = getNotificationActor(event);
          if (actor === user.pubkey) continue; // ignore own actions
          if (seen.has(event.id)) continue;
          seen.add(event.id);

          // Refresh the clock's unread dot + list.
          queryClient.invalidateQueries({ queryKey: ['notifications', user.pubkey] });
          queryClient.invalidateQueries({ queryKey: ['notifications-unread', user.pubkey] });

          if (osdEnabledRef.current) void popUp(event, actor);
        }
      } catch {
        // AbortError on cleanup / resubscribe — expected.
      }
    })();

    return () => ac.abort();
  }, [nostr, user, queryClient, kindsKey, authorsKey, enabledKinds, authorsFilter]);

  return null;
}

/** The popup's text: zap amount, reaction, or a snippet. */
function popupDetail(type: NotificationKind, event: NostrEvent): string {
  if (type === 'zap') {
    const sats = getZapAmountSats(event);
    return sats > 0 ? `${sats.toLocaleString()} sats` : 'A zap';
  }
  if (type === 'reaction') {
    return event.content && event.content !== '+' ? event.content : '❤️';
  }
  if (type === 'mention' || type === 'comment') {
    return event.content.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  // Repost — no inline content to preview.
  return '';
}

/** npub-derived fallback name when profile metadata is missing. */
function genericName(pubkey: string): string {
  try {
    const npub = nip19.npubEncode(pubkey);
    return `${npub.slice(0, 8)}…${npub.slice(-4)}`;
  } catch {
    return 'Someone';
  }
}
