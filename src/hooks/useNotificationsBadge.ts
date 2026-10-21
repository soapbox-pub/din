import { useHasUnreadNotifications } from '@/hooks/useNotifications';
import { useNotificationCenter } from '@/lib/notificationCenter';

/**
 * What the menu-bar clock shows about notifications: whether apps or Nostr
 * have unread ones (for Nostr, a cheap one-event relay check), and whether
 * Do Not Disturb is on.
 */
export function useNotificationsBadge(): { hasUnread: boolean; doNotDisturb: boolean } {
  const hasUnreadNostr = useHasUnreadNotifications();
  const { notifications, doNotDisturb } = useNotificationCenter();
  const hasUnread = hasUnreadNostr || notifications.some((n) => n.history && !n.read);
  return { hasUnread, doNotDisturb };
}
