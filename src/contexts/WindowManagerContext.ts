import { createContext, useContext } from 'react';
import type { WindowManager } from '@/hooks/useWindows';

/** Provides the desktop window manager to the taskbar and workspace. */
export const WindowManagerContext = createContext<WindowManager | undefined>(
  undefined,
);

/** Access the desktop window manager. Must be used within the Desktop. */
export function useWindowManager(): WindowManager {
  const ctx = useContext(WindowManagerContext);
  if (!ctx) {
    throw new Error('useWindowManager must be used within a Desktop');
  }
  return ctx;
}
