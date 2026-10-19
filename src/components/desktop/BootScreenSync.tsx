import { useEffect } from 'react';
import { useProfileTheme } from '@/hooks/useProfileTheme';

interface BootScreenBridge {
  update(wallpaper: string | null, hour12: boolean): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    bootScreen?: BootScreenBridge;
  }
}

/**
 * Gives DinOS's boot and unlock screen the wallpaper the desktop shows (as
 * Wallpaper draws it: the profile theme's image, none for a theme without
 * one, or Din's own) and the clock format this locale uses. The boot screen
 * keeps a copy on the boot partition (electron/boot-screen.mts), so it's
 * only sent once things have settled.
 */
export function BootScreenSync() {
  const theme = useProfileTheme();
  const background = theme?.background;
  const wallpaper = theme
    ? background?.mimeType.startsWith('image/') ? background.url : null
    : '/wallpaper.jpg';

  useEffect(() => {
    const bridge = window.bootScreen;
    if (!bridge) return;
    const { hourCycle } = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions();
    const hour12 = hourCycle === 'h11' || hourCycle === 'h12';
    const timer = setTimeout(() => {
      bridge.update(wallpaper, hour12).catch((error: unknown) => {
        console.error('boot screen: updating the wallpaper failed:', error);
      });
    }, 5_000);
    return () => clearTimeout(timer);
  }, [wallpaper]);

  return null;
}
