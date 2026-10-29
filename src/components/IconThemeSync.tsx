import { useEffect } from 'react';
import { THEMED_APP_ICONS } from '@/lib/appIcons';
import { extraThemeIconRequests, getIconThemeBridge, onThemeIconRequest } from '@/lib/iconTheme';
import type { IconRequest } from '@/lib/iconTheme';
import { FILE_ICON_NAMES, setDesktopThemeIcons } from '@/shared/themeIcons';

const REQUESTS: IconRequest[] = [
  ...Object.values(THEMED_APP_ICONS).map((names) => ({ names, kind: 'apps' as const })),
  ...Object.values(FILE_ICON_NAMES).map((names) => ({ names, kind: 'files' as const })),
];

/** The most names main looks up in one call (icon-theme:lookup). */
const LOOKUP_BATCH = 200;

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
        const requests = [...REQUESTS, ...extraThemeIconRequests()];
        const batches: IconRequest[][] = [];
        for (let i = 0; i < requests.length; i += LOOKUP_BATCH) batches.push(requests.slice(i, i + LOOKUP_BATCH));
        const [status, ...found] = await Promise.all([bridge.status(), ...batches.map((batch) => bridge.lookup(batch))]);
        if (!alive || mine !== run) return;
        setDesktopThemeIcons(Object.assign({}, ...found));
        document.documentElement.dataset.iconTheme = status.din ? '' : status.theme;
      } catch (error) {
        console.warn('din: could not read the icon theme:', error);
      }
    };
    void load();
    const offRequest = onThemeIconRequest(() => void load());
    const off = bridge.onChanged(() => void load());
    return () => {
      alive = false;
      offRequest();
      off();
    };
  }, []);

  return null;
}
