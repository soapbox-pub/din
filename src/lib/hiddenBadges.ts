import type { AppConfig } from '@/contexts/AppContext';

/**
 * Apps whose Dock and taskbar badge the user hid (`AppConfig.hiddenBadges`),
 * for an app whose count is wrong or that they'd rather not hear from that
 * way. It stays hidden until they show it again; the app's notifications
 * still pop up and still reach the notification center. The tile's right-click
 * menu, Settings → Notifications and `din notifications hide-badge` all
 * change it here.
 */
export function hiddenBadges(config: Partial<AppConfig>): readonly string[] {
  return config.hiddenBadges ?? [];
}

/** The config with `appId`'s badge hidden or shown again. */
export function withBadgeHidden(config: Partial<AppConfig>, appId: string, hidden: boolean): Partial<AppConfig> {
  const current = hiddenBadges(config);
  if (current.includes(appId) === hidden) return config;
  return { ...config, hiddenBadges: hidden ? [...current, appId] : current.filter((id) => id !== appId) };
}
