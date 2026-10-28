import { createContext, useContext, useLayoutEffect } from 'react';
import type { WindowState } from '@/hooks/useWindows';

/**
 * What a window's title bar is made of, for an app that lays out its own
 * (WindowHeader's drag region and controls). Changes with the window's
 * state, so only those pieces read it.
 */
export interface WindowFrame {
  win: WindowState;
  /** Title-bar drag: move the window, or tear it off a maximized/tiled spot. */
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  /** Classes for the controls' color and hover, which follow the window's accent. */
  muted: string;
  hover: string;
}

export const WindowFrameContext = createContext<WindowFrame | undefined>(undefined);

export function useWindowFrame(): WindowFrame | undefined {
  return useContext(WindowFrameContext);
}

/** Tells the window its app draws the title bar itself. Stable. */
export const WindowOwnHeaderContext = createContext<((own: boolean) => void) | undefined>(undefined);

/**
 * Take over the window's title bar while mounted: the window keeps its frame,
 * corners and resize handles, and the app lays out WindowDragRegion and
 * WindowControls where it likes (a sidebar running to the top, GNOME-style).
 * Outside a Window it does nothing.
 */
export function useOwnWindowHeader(own = true): void {
  const setOwn = useContext(WindowOwnHeaderContext);
  useLayoutEffect(() => {
    if (!setOwn || !own) return;
    setOwn(true);
    return () => setOwn(false);
  }, [setOwn, own]);
}
