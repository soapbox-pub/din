import { closeNotificationByKey, useNotificationCenter } from '@/lib/notificationCenter';

/**
 * The notification UpdateNotifier puts up for a DinOS update that's ready
 * or waiting on a restart. While it's there, Settings and its About section
 * carry a dot; seeing About takes it down.
 */
export const UPDATE_NOTICE_KEY = 'din-update';

/** Whether the update's notification is still waiting to be seen. */
export function useUpdateNoticePending(): boolean {
  const { notifications } = useNotificationCenter();
  return notifications.some((n) => n.replaceKey === UPDATE_NOTICE_KEY);
}

/** The update's been seen to: take its notification down. */
export function dismissUpdateNotice(): void {
  closeNotificationByKey(UPDATE_NOTICE_KEY);
}
