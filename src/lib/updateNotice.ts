import { closeNotificationByKey, useNotificationCenter } from '@/lib/notificationCenter';

/**
 * The notification UpdateNotifier puts up for a DinOS update that's ready
 * or waiting on a restart. While it's there, Settings and its About section
 * carry a dot; seeing About takes it down.
 */
export const UPDATE_NOTICE_KEY = 'din-update';

/**
 * The one UpdateNotifier puts up when an update can't go ahead (the user's
 * changes stopped it), or a security fix is waiting: one replaces the other.
 */
export const UPDATE_PROBLEM_KEY = 'din-update-problem';

/** Whether the update's notification is still waiting to be seen. */
export function useUpdateNoticePending(): boolean {
  const { notifications } = useNotificationCenter();
  return notifications.some((n) => n.replaceKey === UPDATE_NOTICE_KEY);
}

/** The update's been seen to: take its notification down. */
export function dismissUpdateNotice(): void {
  closeNotificationByKey(UPDATE_NOTICE_KEY);
}

/**
 * What the user has dismissed of the update's problems, across restarts: a
 * failure, by why and the commit of theirs it stopped on
 * (`failure:<reason>:<commit>`), so the branch moving on doesn't bring it
 * back; a security fix, by its commit (`security:<commit>`).
 */
const DISMISSED_KEY = 'din.update.dismissed';
/** Kept at most, the newest last. */
const MAX_DISMISSED = 100;

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function isUpdateProblemDismissed(key: string): boolean {
  return readDismissed().includes(key);
}

export function dismissUpdateProblems(keys: string[]): void {
  const kept = readDismissed().filter((k) => !keys.includes(k));
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...kept, ...keys].slice(-MAX_DISMISSED)));
  } catch {
    // Full or unavailable: it comes back next time, which is the safe way to fail.
  }
}

/** A failure's key in the dismissed list: why, and the user's commit it stopped on. */
export function failureKey(reason: string, commit: string | null): string {
  return `failure:${reason}:${commit ?? ''}`;
}

export function securityKey(commit: string): string {
  return `security:${commit}`;
}
