import { useState } from 'react';
import { Bell, X } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { activateNotification, closeNotification, type DesktopNotification } from '@/lib/notificationCenter';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';

/**
 * One notification, as a popup or a row of the bell's list: who sent it,
 * when, its title and text, a picture, and its actions. A click on the body
 * activates it. Everything shown is plain text: notifications come from web
 * pages and Linux apps, and none of it is trusted.
 */
export function NotificationCard({
  notification,
  variant,
  onActivated,
}: {
  notification: DesktopNotification;
  variant: 'popup' | 'list';
  /** After a click on it or one of its actions (the list closes). */
  onActivated?: () => void;
}) {
  const { getApp } = useInstalledApps();
  const { source } = notification;
  const app = source.appId ? getApp(source.appId) : undefined;
  const sourceName = app?.name ?? source.name;
  const sourceIcon = app?.icon ?? source.icon ?? Bell;

  return (
    <div
      role={variant === 'popup' ? 'status' : undefined}
      className={cn(
        'group relative flex flex-col gap-1.5 p-3',
        variant === 'popup' &&
          'pointer-events-auto rounded-2xl border border-border/60 bg-background/85 shadow-lg backdrop-blur-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4',
        variant === 'list' && 'px-4 hover:bg-accent/60',
        variant === 'list' && !notification.read && 'bg-primary/5',
      )}
    >
      <div className="flex items-center gap-1.5 pr-6 text-xs text-muted-foreground">
        <AppIcon icon={sourceIcon} className="size-3.5 shrink-0 object-contain" />
        <span className="truncate">{sourceName}</span>
        <span aria-hidden>·</span>
        <time className="shrink-0" dateTime={new Date(notification.createdAt).toISOString()}>
          {formatAge(notification.createdAt)}
        </time>
      </div>

      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => closeNotification(notification.id)}
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" />
      </button>

      <button
        type="button"
        onClick={() => {
          activateNotification(notification.id);
          onActivated?.();
        }}
        className="flex min-w-0 gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <NotificationImage notification={notification} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words text-sm font-medium text-foreground">{notification.title}</p>
          {notification.body && (
            <p className="mt-0.5 line-clamp-3 whitespace-pre-line break-words text-xs text-muted-foreground">
              {notification.body}
            </p>
          )}
        </div>
      </button>

      {notification.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {notification.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => {
                activateNotification(notification.id, action.id);
                onActivated?.();
              }}
              className="min-w-0 flex-1 truncate rounded-lg bg-foreground/10 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationImage({ notification }: { notification: DesktopNotification }) {
  const [failed, setFailed] = useState(false);
  const src = notification.image ? safeImage(notification.image) : null;
  if (!src || failed) return null;
  const Badge = notification.badge;
  return (
    <div className="relative shrink-0 self-start">
      <img
        src={src}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className={cn('size-10 object-cover', notification.imageRound ? 'rounded-full' : 'rounded-lg')}
      />
      {Badge && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 grid size-4.5 place-items-center rounded-full bg-background text-foreground ring-1 ring-border"
        >
          <Badge className="size-3" />
        </span>
      )}
    </div>
  );
}

/** Root-relative paths are Din's own; anything else must pass the sanitizer. */
function safeImage(url: string): string | null {
  return url.startsWith('/') && !url.startsWith('//') ? url : sanitizeImageUrl(url);
}

/** "now", "5m", "2h", then a date. */
function formatAge(createdAt: number): string {
  const minutes = Math.floor((Date.now() - createdAt) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
