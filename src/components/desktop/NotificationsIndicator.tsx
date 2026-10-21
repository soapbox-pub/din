import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { NotificationCard } from '@/components/desktop/NotificationCard';
import { getAvatarShape } from '@/lib/avatarShape';
import {
  clearNotifications,
  markNotificationsRead,
  setDoNotDisturb,
  useNotificationCenter,
} from '@/lib/notificationCenter';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { useAuthor } from '@/hooks/useAuthor';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import {
  useHasUnreadNotifications,
  useNotifications,
  type NotificationItem,
} from '@/hooks/useNotifications';
import {
  getZapAmountSats,
  notificationTargetUrl,
  NOTIFICATION_KIND_META,
} from '@/lib/notifications';

/**
 * Menu-bar notifications bell: the notification center.
 *
 * Its list holds this session's notifications from apps (see
 * notificationCenter.ts) above the signed-in account's Nostr interactions,
 * which come from relays. The bell shows a badge dot while either has unread
 * entries (for Nostr, a cheap one-event relay check). Unread rows stay
 * highlighted while the list is open, and everything counts as read once it
 * closes, so viewing the list dismisses the badge.
 */
export const NotificationsMenuItem = memo(function NotificationsMenuItem() {
  const hasUnreadNostr = useHasUnreadNotifications();
  const { notifications, doNotDisturb } = useNotificationCenter();
  const hasUnread = hasUnreadNostr || notifications.some((n) => n.history && !n.read);
  const BellIcon = doNotDisturb ? BellOff : Bell;
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={hasUnread ? 'Notifications, unread' : 'Notifications'}
          title={doNotDisturb ? 'Notifications (Do Not Disturb)' : 'Notifications'}
          className="relative size-7 rounded-md text-foreground/90 hover:bg-foreground/10 hover:text-foreground"
        >
          <BellIcon className="size-4.5" />
          {hasUnread && (
            <span
              aria-hidden
              className="absolute right-1 top-1 size-2 rounded-full bg-primary ring-2 ring-background"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-96 overflow-hidden p-0"
      >
        <NotificationsPanel onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
});

/** The popover body: header, then app notifications above Nostr's. */
function NotificationsPanel({ onNavigate }: { onNavigate: () => void }) {
  const { user } = useCurrentUser();
  const { notifications, doNotDisturb } = useNotificationCenter();
  const appNotifications = notifications.filter((n) => n.history);

  // Dismiss-on-view: unread rows stay highlighted while the panel is open, and
  // count as read once it closes. The panel only mounts while the popover is
  // open, so its unmount cleanup is exactly "the user dismissed the list".
  useEffect(() => () => markNotificationsRead(), []);

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <p className="text-sm font-semibold text-foreground">Notifications</p>
        <div className="flex items-center gap-1">
          {appNotifications.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={clearNotifications}
            >
              Clear
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={doNotDisturb}
            aria-label="Do Not Disturb"
            title={doNotDisturb ? 'Do Not Disturb is on' : 'Do Not Disturb'}
            className={cn(
              'size-7 text-muted-foreground hover:text-foreground',
              doNotDisturb && 'bg-foreground/10 text-foreground',
            )}
            onClick={() => setDoNotDisturb(!doNotDisturb)}
          >
            <BellOff className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {appNotifications.length > 0 && (
          <ul className="divide-y divide-border/40" aria-label="App notifications">
            {appNotifications.map((notification) => (
              <li key={notification.id}>
                <NotificationCard notification={notification} variant="list" onActivated={onNavigate} />
              </li>
            ))}
          </ul>
        )}
        {user ? (
          <NostrNotificationsList separated={appNotifications.length > 0} />
        ) : (
          appNotifications.length === 0 && (
            <div className="px-6 py-12 text-center">
              <Bell className="mx-auto mb-3 size-8 text-muted-foreground/50" aria-hidden />
              <p className="text-sm text-muted-foreground">
                No notifications. Log in to get your Nostr mentions, reactions and zaps here too.
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** The signed-in account's Nostr interactions, from relays. */
function NostrNotificationsList({ separated }: { separated: boolean }) {
  const { items, isLoading, hasFetched, hasNextPage, isFetchingNextPage, fetchNextPage, hasUnread, markAsRead } =
    useNotifications();

  // The read cursor advances when the list closes. A ref keeps the latest
  // markAsRead so the once-only cleanup still closes over the freshest
  // cursor/newest-timestamp.
  const markAsReadRef = useRef(markAsRead);
  useEffect(() => {
    markAsReadRef.current = markAsRead;
  }, [markAsRead]);
  useEffect(() => () => markAsReadRef.current(), []);

  return (
    <section aria-label="Nostr notifications" className={cn(separated && 'border-t border-border/60')}>
      <div className="flex items-center justify-between px-4 pb-1 pt-2.5">
        <p className="text-xs font-medium text-muted-foreground">Nostr</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          disabled={!hasUnread}
          onClick={markAsRead}
        >
          <CheckCheck className="size-3.5" aria-hidden />
          Mark all read
        </Button>
      </div>
      {isLoading && !hasFetched ? (
        <NotificationsSkeleton />
      ) : items.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <Bell className="mx-auto mb-3 size-8 text-muted-foreground/50" aria-hidden />
          <p className="text-sm text-muted-foreground">
            No notifications yet. Mentions, reactions, reposts and zaps will show up here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/40">
          {items.map((item) => (
            <li key={item.event.id}>
              <NotificationRow item={item} />
            </li>
          ))}
          {hasNextPage && (
            <li className="p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-xs text-muted-foreground"
                disabled={isFetchingNextPage}
                onClick={() => fetchNextPage()}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** A single notification row: actor avatar, action, and a content preview. */
function NotificationRow({ item }: { item: NotificationItem }) {
  const author = useAuthor(item.actor);
  const openUrl = useOpenUrl();
  const metadata = author.data?.metadata;
  const name = metadata?.name?.trim() || genericName(item.actor);
  const picture = metadata?.picture ? sanitizeImageUrl(metadata.picture) ?? undefined : undefined;
  const meta = NOTIFICATION_KIND_META[item.type];
  const Icon = meta.icon;

  const detail = useMemo(() => rowDetail(item), [item]);

  return (
    <PopoverClose asChild>
      <button
        type="button"
        onClick={() =>
          openUrl(
            notificationTargetUrl({
              type: item.type,
              event: item.event,
              actor: item.actor,
              referencedEvent: item.referencedEvent,
            }),
          )
        }
        className={cn(
          'flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:bg-accent',
          item.isNew && 'bg-primary/5',
        )}
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
            {item.isNew && (
              <span className="ml-1.5 inline-block size-1.5 -translate-y-0.5 rounded-full bg-primary align-middle" aria-label="New" />
            )}
          </p>
          {detail && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detail}</p>
          )}
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {formatRelativeTime(item.event.created_at)}
          </p>
        </div>
      </button>
    </PopoverClose>
  );
}

/** Secondary line: zap amount, reaction emoji + post snippet, or post snippet. */
function rowDetail(item: NotificationItem): string {
  if (item.type === 'zap') {
    const sats = getZapAmountSats(item.event);
    const snippet = previewText(item.referencedEvent);
    const amount = sats > 0 ? `${sats.toLocaleString()} sats` : 'A zap';
    return snippet ? `${amount} · ${snippet}` : amount;
  }
  if (item.type === 'reaction') {
    const emoji = item.event.content && item.event.content !== '+' ? item.event.content : '❤️';
    const snippet = previewText(item.referencedEvent);
    return snippet ? `${emoji}  ${snippet}` : emoji;
  }
  if (item.type === 'mention' || item.type === 'comment') {
    return previewText(item.event);
  }
  return previewText(item.referencedEvent);
}

/** A single-line, plain-text preview of an event's content. */
function previewText(event: NostrEvent | undefined): string {
  if (!event?.content) return '';
  return event.content.replace(/\s+/g, ' ').trim().slice(0, 140);
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

/** Compact relative time (e.g. "3m", "2h", "5d"), else a date. */
function formatRelativeTime(createdAt: number): string {
  const seconds = Math.floor(Date.now() / 1000) - createdAt;
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(createdAt * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function NotificationsSkeleton() {
  return (
    <div className="divide-y divide-border/40" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex gap-3 px-4 py-3">
          <Skeleton className="size-9 shrink-0 rounded-full bg-foreground/10" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40 bg-foreground/10" />
            <Skeleton className="h-3 w-full bg-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}
