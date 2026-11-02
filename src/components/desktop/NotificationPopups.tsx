import { useEffect, useRef, useState } from 'react';
import { NotificationCard } from '@/components/desktop/NotificationCard';
import { announce } from '@/lib/announce';
import { expirePopup, useNotificationCenter, type DesktopNotification } from '@/lib/notificationCenter';

/**
 * New notifications, popped up in the top-right corner under the menu bar.
 * Each goes after its timeout (held while the pointer is over it, its menu
 * is open, or its reply field is) and stays
 * in the notification center.
 */
export function NotificationPopups() {
  const { notifications, popups } = useNotificationCenter();
  const shown = popups
    .map((id) => notifications.find((n) => n.id === id))
    .filter((n): n is DesktopNotification => n !== undefined);

  // Each popup is read out as it comes (a replaced one again), urgent ones
  // interrupting; Ctrl+F6 takes the keyboard to them.
  const announced = useRef(new Map<string, number>());
  useEffect(() => {
    for (const n of shown) {
      if (announced.current.get(n.id) === n.createdAt) continue;
      announced.current.set(n.id, n.createdAt);
      announce(`${n.source.name}: ${n.title}. ${n.body}`, n.urgency === 'critical' ? 'assertive' : 'polite');
    }
    for (const id of announced.current.keys()) {
      if (!popups.includes(id)) announced.current.delete(id);
    }
  });

  if (shown.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Notifications"
      data-focus-area="notifications"
      className="pointer-events-none fixed right-4 top-11 z-[9998] flex w-80 flex-col gap-2"
    >
      {shown.map((notification) => (
        <Popup key={notification.id} notification={notification} />
      ))}
    </div>
  );
}

function Popup({ notification }: { notification: DesktopNotification }) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const { id, timeout, createdAt } = notification;

  // createdAt restarts the clock when a notification is replaced in place.
  useEffect(() => {
    if (hovered || menuOpen || replying || timeout <= 0) return;
    const timer = window.setTimeout(() => expirePopup(id), timeout);
    return () => window.clearTimeout(timer);
  }, [id, timeout, createdAt, hovered, menuOpen, replying]);

  return (
    <div
      className="pointer-events-auto"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <NotificationCard
        notification={notification}
        variant="popup"
        onMenuOpenChange={setMenuOpen}
        onReplyingChange={setReplying}
      />
    </div>
  );
}
