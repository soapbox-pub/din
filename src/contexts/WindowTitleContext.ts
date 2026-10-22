import { createContext, useContext, useEffect } from 'react';

/**
 * Lets an app name what its window is showing (the browser's page title, the
 * terminal's command), so several windows of one app can be told apart where
 * the window itself isn't visible: the Alt+Tab switcher, the Dock's menu, and
 * the title bar when the app doesn't draw its own.
 */
export const WindowTitleContext = createContext<
  ((title: string | null) => void) | undefined
>(undefined);

/**
 * Publish the current window's title while mounted; an empty or null title
 * goes back to the app's name.
 *
 * A no-op outside a Window (e.g. an app rendered on its own in tests), so
 * apps can call it unconditionally.
 */
export function useWindowTitle(title: string | null): void {
  const setTitle = useContext(WindowTitleContext);
  const value = title?.trim() || null;
  useEffect(() => {
    setTitle?.(value);
  }, [setTitle, value]);
  useEffect(() => () => setTitle?.(null), [setTitle]);
}
