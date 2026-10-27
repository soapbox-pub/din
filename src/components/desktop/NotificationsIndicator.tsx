import { useEffect } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NotificationCard } from '@/components/desktop/NotificationCard';
import {
  clearNotifications,
  markNotificationsRead,
  setDoNotDisturb,
  useNotificationCenter,
} from '@/lib/notificationCenter';
import { cn } from '@/lib/utils';

/**
 * The notification center, shown in the menu-bar clock's panel.
 *
 * Its list holds this session's notifications from apps, sites and installed
 * nsites (see notificationCenter.ts). The clock shows a badge dot while any
 * are unread (see useNotificationsBadge). Unread rows stay highlighted while the
 * list is open, and everything counts as read once it closes, so viewing the
 * list dismisses the badge.
 */
export function NotificationsPanel({
  onNavigate,
  className,
}: {
  onNavigate: () => void;
  className?: string;
}) {
  const { notifications, doNotDisturb } = useNotificationCenter();
  const appNotifications = notifications.filter((n) => n.history);

  // Dismiss-on-view: unread rows stay highlighted while the panel is open, and
  // count as read once it closes. The panel only mounts while the popover is
  // open, so its unmount cleanup is exactly "the user dismissed the list".
  useEffect(() => () => markNotificationsRead(), []);

  return (
    <div className={cn('flex flex-col', className)}>
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
        {appNotifications.length > 0 ? (
          <ul className="divide-y divide-border/40" aria-label="Notifications">
            {appNotifications.map((notification) => (
              <li key={notification.id}>
                <NotificationCard notification={notification} variant="list" onActivated={onNavigate} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-6 py-12 text-center">
            <Bell className="mx-auto mb-3 size-8 text-muted-foreground/50" aria-hidden />
            <p className="text-sm text-muted-foreground">No notifications</p>
          </div>
        )}
      </div>
    </div>
  );
}
