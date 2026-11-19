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
import { trayHeader, trayRuleBottom, trayTitle } from './trayPanel';

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
  // Running tasks first, under their own heading: they stay until stopped.
  const running = notifications.filter((n) => n.history && n.ongoing);
  const appNotifications = notifications.filter((n) => n.history && !n.ongoing);

  // Dismiss-on-view: unread rows stay highlighted while the panel is open, and
  // count as read once it closes. The panel only mounts while the popover is
  // open, so its unmount cleanup is exactly "the user dismissed the list".
  useEffect(() => () => markNotificationsRead(), []);

  return (
    <div className={cn('flex flex-col', className)}>
      <div className={trayHeader}>
        <h2 className={trayTitle}>Notifications</h2>
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

      {/* Not sideways: a row swiped away slides out past its edge. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {running.length > 0 && (
          <section aria-labelledby="notifications-running" className={cn(appNotifications.length > 0 && trayRuleBottom)}>
            <h3 id="notifications-running" className="px-4 pt-1 text-xs font-semibold text-muted-foreground">
              Running
            </h3>
            <ul className="flex flex-col gap-1 p-2">
              {running.map((notification) => (
                <li key={notification.id}>
                  <NotificationCard notification={notification} variant="list" onActivated={onNavigate} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {appNotifications.length > 0 ? (
          <ul className="flex flex-col gap-1 p-2" aria-label="Notifications">
            {appNotifications.map((notification) => (
              <li key={notification.id}>
                <NotificationCard notification={notification} variant="list" onActivated={onNavigate} />
              </li>
            ))}
          </ul>
        ) : running.length > 0 ? null : (
          <div className="px-6 py-12 text-center">
            <Bell className="mx-auto mb-3 size-8 text-muted-foreground/50" aria-hidden />
            <p className="text-sm text-muted-foreground">No notifications</p>
          </div>
        )}
      </div>
    </div>
  );
}
