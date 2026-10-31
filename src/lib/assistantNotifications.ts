import type { DesktopNotification } from '@/lib/notificationCenter';

export const ASSISTANT_APP_ID = 'assistant';

/**
 * The `replaceKey` of an assistant notification about a conversation: what
 * it's about (`done`, `permission:<id>`…) after the conversation's id, so
 * the conversation it's from can be read back (unreadAssistantSessions).
 */
export function assistantNotificationKey(sessionID: string, about: string): string {
  return `assistant:${sessionID}:${about}`;
}

/**
 * The conversations with unread notifications in the notification center:
 * the ones that make up the Assistant's Dock badge, for its window to mark.
 */
export function unreadAssistantSessions(notifications: readonly DesktopNotification[]): string[] {
  const sessions = new Set<string>();
  for (const n of notifications) {
    if (!n.history || n.read || n.source.appId !== ASSISTANT_APP_ID || !n.replaceKey?.startsWith('assistant:')) continue;
    const sessionID = n.replaceKey.split(':')[1];
    if (sessionID) sessions.add(sessionID);
  }
  return [...sessions].sort();
}
