import { createContext, useContext, useEffect } from 'react';

/**
 * Lets an app give its window an icon for what it's showing (Preview's
 * picture, video or other file), worn in the title bar, the Dock and the
 * Alt+Tab switcher in place of the app's own.
 */
export const WindowIconContext = createContext<
  ((icon: string | null) => void) | undefined
>(undefined);

/**
 * Publish the current window's icon (a root-relative image path, like an
 * app's) while mounted; null goes back to the app's icon.
 *
 * A no-op outside a Window, so apps can call it unconditionally.
 */
export function useWindowIcon(icon: string | null): void {
  const setIcon = useContext(WindowIconContext);
  useEffect(() => {
    setIcon?.(icon);
  }, [setIcon, icon]);
  useEffect(() => () => setIcon?.(null), [setIcon]);
}
