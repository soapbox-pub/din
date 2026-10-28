/** React hooks over window.din (docs/din/README.md). */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { Din, DragInfo, FrameStyle, Menu, ThemeSnapshot, WindowState } from '@/sdk/din';

export const DinContext = createContext<Din | null>(null);


/** The connected window.din. Throws outside a DinProvider. */
export function useDin(): Din {
  const din = useContext(DinContext);
  if (!din) throw new Error('useDin must be used inside a DinProvider');
  return din;
}

/** The connected window.din, or null outside a DinProvider (code shared with the desktop). */
export function useDinOptional(): Din | null {
  return useContext(DinContext);
}

/** The window's state, re-rendering when it changes. */
export function useWindowState(): WindowState {
  const din = useDin();
  return useSyncExternalStore(
    (cb) => din.window.onChange(cb),
    () => din.window.state,
  );
}

/** The title bar's look (accent, dark), for drawing to match. */
export function useFrameStyle(): FrameStyle {
  const din = useDin();
  return useSyncExternalStore(
    (cb) => din.window.onFrameStyleChange(cb),
    () => din.window.frameStyle,
  );
}

/** The desktop's theme. */
export function useDinTheme(): ThemeSnapshot {
  const din = useDin();
  return useSyncExternalStore(
    (cb) => din.theme.onChange(cb),
    () => din.theme.current,
  );
}

/** The drag going on anywhere on the desktop, or null. */
export function useCurrentDrag(): DragInfo | null {
  const din = useDin();
  return useSyncExternalStore(
    (cb) => din.drag.onChange(cb),
    () => din.drag.current,
  );
}

/** Show this title while mounted (null: the app's name). */
export function useWindowTitle(title: string | null): void {
  const din = useDin();
  useEffect(() => {
    din.window.setTitle(title);
  }, [din, title]);
  useEffect(() => () => din.window.setTitle(null), [din]);
}

/**
 * Have a say when the window closes, while mounted: return true to keep it
 * open (and ask), then call din.window.close() yourself. Null for no guard.
 */
export function useCloseGuard(guard: (() => boolean) | null): void {
  const din = useDin();
  const latest = useRef(guard);
  useLayoutEffect(() => {
    latest.current = guard;
  });
  const on = guard !== null;
  useEffect(() => {
    if (!on) return;
    din.window.onCloseRequest(() => latest.current?.() ?? false);
    return () => din.window.onCloseRequest(null);
  }, [din, on]);
}

/** The app's menus in Din's menu bar, re-sent when they change, while mounted. */
export function useMenuBar(menus: Menu[] | null, onAction: (id: string) => void): void {
  const din = useDin();
  const latest = useRef(onAction);
  useLayoutEffect(() => {
    latest.current = onAction;
  });
  const json = JSON.stringify(menus);
  useEffect(() => {
    din.menus.setMenuBar(JSON.parse(json) as Menu[] | null);
  }, [din, json]);
  useEffect(() => () => din.menus.setMenuBar(null), [din]);
  useEffect(() => din.menus.onAction((id) => latest.current(id)), [din]);
}

/** Classes for title-bar controls, following the accent as the desktop's do. */
export function frameControlClasses(style: FrameStyle): { muted: string; hover: string } {
  if (!style.accent) {
    return { muted: 'text-muted-foreground', hover: 'hover:bg-foreground/10 hover:text-foreground' };
  }
  return style.dark
    ? { muted: 'text-white/70', hover: 'hover:bg-white/15 hover:text-white' }
    : { muted: 'text-black/60', hover: 'hover:bg-black/10 hover:text-black' };
}

