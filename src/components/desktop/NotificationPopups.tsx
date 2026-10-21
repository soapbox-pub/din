import { useEffect, useState } from 'react';
import { NotificationCard } from '@/components/desktop/NotificationCard';
import { expirePopup, useNotificationCenter, type DesktopNotification } from '@/lib/notificationCenter';

/**
 * New notifications, popped up in the top-right corner under the menu bar.
 * Each goes after its timeout (held while the pointer is over it) and stays
 * in the bell's list.
 */
export function NotificationPopups() {
  const { notifications, popups } = useNotificationCenter();
  const shown = popups
    .map((id) => notifications.find((n) => n.id === id))
    .filter((n): n is DesktopNotification => n !== undefined);
  if (shown.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-11 z-[9998] flex w-80 flex-col gap-2">
      {shown.map((notification) => (
        <Popup key={notification.id} notification={notification} />
      ))}
    </div>
  );
}

function Popup({ notification }: { notification: DesktopNotification }) {
  const [hovered, setHovered] = useState(false);
  const { id, timeout, createdAt } = notification;

  // createdAt restarts the clock when a notification is replaced in place.
  useEffect(() => {
    if (hovered || timeout <= 0) return;
    const timer = window.setTimeout(() => expirePopup(id), timeout);
    return () => window.clearTimeout(timer);
  }, [id, timeout, createdAt, hovered]);

  return (
    <div
      className="pointer-events-auto"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <NotificationCard notification={notification} variant="popup" />
    </div>
  );
}
