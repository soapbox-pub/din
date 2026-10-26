import { useEffect } from 'react';
import { useDesktopTheme } from '@/hooks/useDesktopTheme';
import { useAppContext } from '@/hooks/useAppContext';
import { usesHour12 } from '@/lib/datetime';

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
 * Wallpaper draws it: the custom theme's image, none for a theme without
 * one, or Din's own) and the clock format set in Settings → Date & Time
 * (by default, the locale's). The boot screen keeps a copy on the boot
 * partition (electron/boot-screen.mts), so it's only sent once things have
 * settled.
 */
export function BootScreenSync() {
  const theme = useDesktopTheme();
  const background = theme?.background;
  const wallpaper = theme
    ? background?.mimeType.startsWith('image/') ? background.url : null
    : '/wallpaper.jpg';

  const { config } = useAppContext();
  const hour12 = usesHour12(config.clockFormat);

  useEffect(() => {
    const bridge = window.bootScreen;
    if (!bridge) return;
    const timer = setTimeout(() => {
      bridge.update(wallpaper, hour12).catch((error: unknown) => {
        console.error('boot screen: updating the wallpaper failed:', error);
      });
    }, 5_000);
    return () => clearTimeout(timer);
  }, [wallpaper, hour12]);

  return null;
}
