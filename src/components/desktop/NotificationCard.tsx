import { useState } from 'react';
import { Bell, BellOff, Loader2, Reply, SendHorizontal, X } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import {
  activateNotification,
  clearNotifications,
  closeNotification,
  type DesktopNotification,
} from '@/lib/notificationCenter';
import { getBrowserBridge } from '@/lib/browser';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { glassPanel } from '@/shared/appChromeStyles';

/**
 * One notification, as a popup or a row of the notification center's list: who sent it,
 * when, its title and text, a picture, and its actions. A click on the body
 * activates it. Everything shown is plain text: notifications come from web
 * pages and Linux apps, and none of it is trusted. A site's can be turned off
 * from its right-click menu.
 */
export function NotificationCard({
  notification,
  variant,
  onActivated,
  onMenuOpenChange,
  onReplyingChange,
}: {
  notification: DesktopNotification;
  variant: 'popup' | 'list';
  /** After a click on its body (the list closes); its actions leave the list open. */
  onActivated?: () => void;
  /** Its right-click menu opened or closed (a popup holds its timeout meanwhile). */
  onMenuOpenChange?: (open: boolean) => void;
  /** Its reply field opened or closed (a popup holds its timeout meanwhile). */
  onReplyingChange?: (replying: boolean) => void;
}) {
  const { getApp } = useInstalledApps();
  const { open } = useWindowActions();
  const { source } = notification;
  const app = source.appId ? getApp(source.appId) : undefined;
  const sourceName = app?.name ?? source.name;
  const sourceIcon = app?.icon ?? source.icon ?? Bell;
  const browser = getBrowserBridge();
  const blockable = browser && source.origin ? { browser, origin: source.origin } : null;

  const [replying, setReplyingState] = useState(false);
  const setReplying = (on: boolean) => {
    setReplyingState(on);
    onReplyingChange?.(on);
  };

  /** The body opens what it's about, so the list closes; an action is done in place. */
  const activate = (action?: string) => {
    activateNotification(notification.id, action);
    if (!action) onActivated?.();
  };

  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild>
        <div
          role={variant === 'popup' ? 'status' : undefined}
          className={cn(
            'group relative flex flex-col gap-1.5 p-3',
            variant === 'popup' &&
              'pointer-events-auto', glassPanel, 'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4',
            variant === 'list' && 'px-4 hover:bg-accent/60',
            variant === 'list' && !notification.read && 'bg-selected',
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
            onClick={() => activate()}
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

          {notification.progress !== undefined && (
            <div
              role="progressbar"
              aria-label={notification.title}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={notification.progress === null ? undefined : Math.round(notification.progress * 100)}
              className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
            >
              <div
                className={cn(
                  'h-full rounded-full bg-primary motion-safe:transition-[width]',
                  notification.progress === null && 'w-1/3 motion-safe:animate-pulse',
                )}
                style={notification.progress === null ? undefined : { width: `${Math.min(1, Math.max(0, notification.progress)) * 100}%` }}
              />
            </div>
          )}

          {notification.reply && replying ? (
            <ReplyField
              reply={notification.reply}
              onCancel={() => setReplying(false)}
              onSent={() => closeNotification(notification.id, 'closed')}
            />
          ) : (notification.actions.length > 0 || notification.reply) && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {notification.reply && (
                <button
                  type="button"
                  onClick={() => setReplying(true)}
                  className="flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate rounded-lg bg-foreground/10 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Reply className="size-3.5" aria-hidden />
                  Reply
                </button>
              )}
              {notification.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => activate(action.id)}
                  className="min-w-0 flex-1 truncate rounded-lg bg-foreground/10 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      {/* Above the popups (z-[9998]). */}
      <ContextMenuContent className="z-[10000] w-56">
        <ContextMenuItem onSelect={() => activate()}>Open</ContextMenuItem>
        {notification.reply && (
          <ContextMenuItem onSelect={() => setReplying(true)}>
            <Reply />
            Reply
          </ContextMenuItem>
        )}
        {notification.actions.map((action) => (
          <ContextMenuItem key={action.id} onSelect={() => activate(action.id)}>
            <span className="truncate">{action.label}</span>
          </ContextMenuItem>
        ))}
        <ContextMenuItem onSelect={() => closeNotification(notification.id)}>Dismiss</ContextMenuItem>
        <ContextMenuSeparator />
        {blockable && (
          <ContextMenuItem
            onSelect={() => void blockable.browser.setSitePermission(blockable.origin, 'notifications', false, false)}
          >
            <BellOff />
            <span className="truncate">Turn off notifications from {sourceName}</span>
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() => {
            onActivated?.();
            open('settings', { section: 'notifications' });
          }}
        >
          Notification settings
        </ContextMenuItem>
        <ContextMenuItem onSelect={clearNotifications}>Clear all</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ReplyField({
  reply,
  onCancel,
  onSent,
}: {
  reply: NonNullable<DesktopNotification['reply']>;
  onCancel: () => void;
  onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = () => {
    const answer = text.trim();
    if (!answer || sending) return;
    setSending(true);
    setError(null);
    reply.send(answer).then(onSent, (e: unknown) => {
      setSending(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <div className="flex flex-col gap-1 pt-0.5">
      <form
        className="flex items-end gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          autoFocus
          rows={1}
          value={text}
          disabled={sending}
          placeholder={reply.placeholder}
          aria-label={reply.placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              onCancel();
            }
          }}
          className="max-h-24 min-h-8 flex-1 resize-none rounded-lg bg-foreground/[0.06] px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [field-sizing:content]"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!text.trim() || sending}
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-pigment text-primary-foreground clay-pigment transition-opacity disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <SendHorizontal className="size-4" aria-hidden />}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
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
