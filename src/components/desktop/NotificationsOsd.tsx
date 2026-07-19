import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNostr } from '@nostrify/react';
import { useQueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import { X } from 'lucide-react';
import type { NostrEvent } from '@nostrify/nostrify';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getAvatarShape } from '@/lib/avatarShape';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { useAuthor } from '@/hooks/useAuthor';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import {
  classifyNotification,
  getEnabledNotificationKinds,
  getNotificationActor,
  getZapAmountSats,
  notificationTargetUrl,
  NOTIFICATION_KIND_META,
  type NotificationKind,
} from '@/lib/notifications';

/** How long a notification popup stays on screen. */
const OSD_VISIBLE_MS = 6000;
/** Most popups shown at once; older ones drop off the top. */
const MAX_VISIBLE = 3;

interface OsdToast {
  id: string;
  event: NostrEvent;
  actor: string;
  type: NotificationKind;
}

/**
 * Notifications watcher + on-screen display.
 *
 * Holds a single always-on relay subscription (`#p: [user.pubkey]`, the
 * enabled kinds, `since: now`) so notifications arrive in real time without
 * polling. Every new event invalidates the notification query caches (so the
 * menu-bar bell badge and list refresh), and — when the OSD preference is on —
 * pops a transient macOS-style card in the top-right corner.
 *
 * Renders the popup stack; returns nothing while signed out.
 */
export function NotificationsOsd() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
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

  const [toasts, setToasts] = useState<OsdToast[]>([]);
  const timers = useRef(new Map<string, number>());

  // Read the OSD toggle without resubscribing when it flips: invalidation must
  // keep running for the badge even when the popup is disabled.
  const osdEnabled = preferences.osd;
  const osdEnabledRef = useRef(osdEnabled);
  useEffect(() => {
    osdEnabledRef.current = osdEnabled;
  }, [osdEnabled]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  useEffect(() => {
    if (!user) return;

    const ac = new AbortController();
    const since = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();

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

          // Refresh the bell badge + list.
          queryClient.invalidateQueries({ queryKey: ['notifications', user.pubkey] });
          queryClient.invalidateQueries({ queryKey: ['notifications-unread', user.pubkey] });

          if (!osdEnabledRef.current) continue;

          const toast: OsdToast = {
            id: event.id,
            event,
            actor,
            type: classifyNotification(event),
          };
          setToasts((prev) => [toast, ...prev].slice(0, MAX_VISIBLE));
          const handle = window.setTimeout(() => dismiss(event.id), OSD_VISIBLE_MS);
          timers.current.set(event.id, handle);
        }
      } catch {
        // AbortError on cleanup / resubscribe — expected.
      }
    })();

    // On logout / resubscribe, stop the stream and clear any visible popups
    // (clearing state in cleanup, not the effect body, avoids cascading renders).
    return () => {
      ac.abort();
      setToasts([]);
    };
  }, [nostr, user, queryClient, kindsKey, authorsKey, enabledKinds, authorsFilter, dismiss]);

  // Clear any pending dismiss timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) window.clearTimeout(handle);
      map.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-11 z-[9998] flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <OsdCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

/** A single macOS-style notification card. */
function OsdCard({ toast, onDismiss }: { toast: OsdToast; onDismiss: () => void }) {
  const author = useAuthor(toast.actor);
  const openUrl = useOpenUrl();
  const metadata = author.data?.metadata;
  const name = metadata?.name?.trim() || genericName(toast.actor);
  const picture = metadata?.picture ? sanitizeImageUrl(metadata.picture) ?? undefined : undefined;
  const meta = NOTIFICATION_KIND_META[toast.type];
  const Icon = meta.icon;
  const detail = osdDetail(toast);

  const openTarget = () => {
    onDismiss();
    openUrl(
      notificationTargetUrl({ type: toast.type, event: toast.event, actor: toast.actor }),
    );
  };

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex items-start gap-1 rounded-2xl border border-border/60 bg-background/85 p-3 shadow-lg backdrop-blur-md',
        'motion-safe:animate-in motion-safe:slide-in-from-right-4 motion-safe:fade-in',
      )}
    >
      <button
        type="button"
        onClick={openTarget}
        className="flex min-w-0 flex-1 gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="relative shrink-0">
          <Avatar className="size-9" shape={getAvatarShape(metadata)}>
            <AvatarImage src={picture} alt="" />
            <AvatarFallback className="text-xs">{name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 grid size-4.5 place-items-center rounded-full bg-background text-foreground ring-1 ring-border"
          >
            <Icon className="size-3" />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            <span className="font-medium">{name}</span>{' '}
            <span className="text-muted-foreground">{meta.verb}</span>
          </p>
          {detail && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detail}</p>}
        </div>
      </button>

      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Secondary line for an OSD card (zap amount / reaction / snippet). */
function osdDetail(toast: OsdToast): string {
  if (toast.type === 'zap') {
    const sats = getZapAmountSats(toast.event);
    return sats > 0 ? `${sats.toLocaleString()} sats` : 'A zap';
  }
  if (toast.type === 'reaction') {
    return toast.event.content && toast.event.content !== '+' ? toast.event.content : '❤️';
  }
  if (toast.type === 'mention' || toast.type === 'comment') {
    return toast.event.content.replace(/\s+/g, ' ').trim().slice(0, 120);
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
