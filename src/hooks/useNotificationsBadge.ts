import { useNotificationCenter } from '@/lib/notificationCenter';

/**
 * What the menu-bar clock shows about notifications: whether any in the list
 * are unread, and whether Do Not Disturb is on.
 */
export function useNotificationsBadge(): { hasUnread: boolean; doNotDisturb: boolean } {
  const { notifications, doNotDisturb } = useNotificationCenter();
  const hasUnread = notifications.some((n) => n.history && !n.read);
  return { hasUnread, doNotDisturb };
}
