import { useCallback, useMemo } from 'react';
import { useAppData, type AppDataMeta } from '@/hooks/useAppData';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NotificationSettingsSchema,
  type NotificationPreferences,
  type NotificationSettings,
} from '@/lib/notifications';

/** App-data key (becomes `computer.din.notifications`). */
const NOTIFICATIONS_KEY = 'notifications';

export interface UseNotificationSettings {
  /** Per-type preferences and the follow gate / OSD toggle. */
  preferences: NotificationPreferences;
  /** Unix seconds of the newest notification the user has marked as seen. */
  cursor: number;
  /** Merge a partial patch into the per-type preferences. */
  setPreferences: (patch: Partial<NotificationPreferences>) => void;
  /** Advance the read cursor (never moves it backwards). */
  setCursor: (cursor: number) => void;
  /** Relay-sync metadata for the underlying app-data key. */
  meta: AppDataMeta;
}

/**
 * Notification preferences + read cursor, persisted through Din's encrypted
 * app-data layer (NIP-78 + NIP-44) so they roam across the user's devices and
 * relays only ever see ciphertext.
 */
export function useNotificationSettings(): UseNotificationSettings {
  const [settings, setSettings, meta] = useAppData<NotificationSettings>(
    NOTIFICATIONS_KEY,
    NotificationSettingsSchema,
    DEFAULT_NOTIFICATION_SETTINGS,
  );

  const setPreferences = useCallback(
    (patch: Partial<NotificationPreferences>) => {
      setSettings((prev) => ({
        ...prev,
        preferences: { ...prev.preferences, ...patch },
      }));
    },
    [setSettings],
  );

  const setCursor = useCallback(
    (cursor: number) => {
      setSettings((prev) =>
        cursor > prev.cursor ? { ...prev, cursor } : prev,
      );
    },
    [setSettings],
  );

  return useMemo(
    () => ({
      preferences: settings.preferences,
      cursor: settings.cursor,
      setPreferences,
      setCursor,
      meta,
    }),
    [settings.preferences, settings.cursor, setPreferences, setCursor, meta],
  );
}
