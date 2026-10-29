import { useEffect } from 'react';
import { THEMED_APP_ICONS } from '@/lib/appIcons';
import { getIconThemeBridge } from '@/lib/iconTheme';
import type { IconRequest } from '@/lib/iconTheme';
import { FILE_ICON_NAMES, setDesktopThemeIcons } from '@/shared/themeIcons';

const REQUESTS: IconRequest[] = [
  ...Object.values(THEMED_APP_ICONS).map((names) => ({ names, kind: 'apps' as const })),
  ...Object.values(FILE_ICON_NAMES).map((names) => ({ names, kind: 'files' as const })),
];

/**
 * Looks Din's own icons up in the system's icon theme (electron/icon-theme.mts)
 * whenever it changes, for AppIcon, FileIcon and, through the theme
 * snapshot, apps. Marks the root with the theme's id, which is what tells
 * apps their theme changed.
 */
export function IconThemeSync() {
  useEffect(() => {
    const bridge = getIconThemeBridge();
    if (!bridge) return;
    let alive = true;
    let run = 0;
    const load = async () => {
      const mine = ++run;
      try {
        const [status, icons] = await Promise.all([bridge.status(), bridge.lookup(REQUESTS)]);
        if (!alive || mine !== run) return;
        setDesktopThemeIcons(icons);
        document.documentElement.dataset.iconTheme = status.din ? '' : status.theme;
      } catch (error) {
        console.warn('din: could not read the icon theme:', error);
      }
    };
    void load();
    const off = bridge.onChanged(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);

  return null;
}
