import { createContext, useContext } from 'react';
import type { WindowActions, WindowManager } from '@/hooks/useWindows';

/**
 * Provides the full desktop window manager (state + actions) to the taskbar
 * and workspace. Its value identity changes on EVERY window mutation
 * (open/close/focus/move/resize/...), so every consumer re-renders on every
 * commit. Only subscribe to this when you actually need the `windows` array;
 * if you only dispatch actions, use useWindowActions() instead.
 */
export const WindowManagerContext = createContext<WindowManager | undefined>(
  undefined,
);

/**
 * Provides just the window-manager actions (open/close/focus/move/...).
 * The value is referentially stable across window mutations, so consumers
 * never re-render when window state changes.
 */
export const WindowActionsContext = createContext<WindowActions | undefined>(
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

/**
 * Access the window-manager actions without subscribing to window state.
 * Prefer this over useWindowManager() whenever the `windows` array isn't
 * needed - it keeps the component out of the per-commit re-render cascade.
 */
export function useWindowActions(): WindowActions {
  const ctx = useContext(WindowActionsContext);
  if (!ctx) {
    throw new Error('useWindowActions must be used within a Desktop');
  }
  return ctx;
}
