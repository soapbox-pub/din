/** React hooks over window.din (docs/din/README.md). */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { Din, DragInfo, FrameStyle, Menu, Snap, ThemeSnapshot } from '@/sdk/din';

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

/** Whether the window is the one keyboard input goes to: `document.hasFocus()`, as it changes. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('focus', cb);
      window.addEventListener('blur', cb);
      return () => {
        window.removeEventListener('focus', cb);
        window.removeEventListener('blur', cb);
      };
    },
    () => document.hasFocus(),
  );
}

/** Whether any of the window can be seen: `document.visibilityState`, as it changes. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
    () => document.visibilityState === 'visible',
  );
}

let outerSize = { width: 0, height: 0 };

/**
 * The window's size, frame included (`outerWidth`, `outerHeight`),
 * re-rendering on every step of a resize. For a breakpoint, `useMediaQuery`
 * re-renders only when it's crossed.
 */
export function useWindowSize(): { width: number; height: number } {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('resize', cb);
      return () => window.removeEventListener('resize', cb);
    },
    () => {
      if (outerSize.width !== window.outerWidth || outerSize.height !== window.outerHeight) {
        outerSize = { width: window.outerWidth, height: window.outerHeight };
      }
      return outerSize;
    },
  );
}

/** The half or quarter of the screen the window is snapped to, or null. */
export function useSnapped(): Snap | null {
  const din = useDin();
  return useSyncExternalStore(
    (cb) => din.window.onSnappedChange(cb),
    () => din.window.snapped,
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

/** Whether a media query matches (`(prefers-color-scheme: dark)`), re-rendering when that changes. */
export function useMediaQuery(query: string): boolean {
  const list = mediaQuery(query);
  return useSyncExternalStore(
    (cb) => {
      list.addEventListener('change', cb);
      return () => list.removeEventListener('change', cb);
    },
    () => list.matches,
  );
}

const mediaQueries = new Map<string, MediaQueryList>();

function mediaQuery(query: string): MediaQueryList {
  let list = mediaQueries.get(query);
  if (!list) mediaQueries.set(query, (list = matchMedia(query)));
  return list;
}

/** The drag going on anywhere on the desktop, or null. */
export function useCurrentDrag(): DragInfo | null {
  const din = useDin();
  return useSyncExternalStore(
    (cb) => din.drag.onChange(cb),
    () => din.drag.current,
  );
}

/** The page's own title, which the window shows as the app's name. */
const appTitle = typeof document === 'undefined' ? '' : document.title;

/**
 * Show this title while mounted (null: the app's name). It's the page's
 * `document.title`, which the window follows (docs/din/window.md).
 */
export function useWindowTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ?? appTitle;
  }, [title]);
  useEffect(
    () => () => {
      document.title = appTitle;
    },
    [],
  );
}

/** A `<link>` or `<meta>` in the head while mounted and given a value: the last added wins. */
function useHeadElement(tag: 'link' | 'meta', value: string | null, apply: (el: HTMLElement, value: string) => void): void {
  useEffect(() => {
    if (value === null) return;
    const el = document.createElement(tag);
    apply(el, value);
    document.head.append(el);
    return () => el.remove();
    // `apply` is a fixed function per hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, value]);
}

/**
 * Show this icon for the window while mounted (null: the app's): a
 * `<link rel="icon">` in the page's head, which the window follows.
 */
export function useWindowIcon(url: string | null): void {
  useHeadElement('link', url, (el, href) => {
    el.setAttribute('rel', 'icon');
    el.setAttribute('href', href);
  });
}

/**
 * Tint the title bar while mounted (null: the default): a
 * `<meta name="theme-color">` in the page's head, which the window follows.
 */
export function useWindowAccent(color: string | null): void {
  useHeadElement('meta', color, (el, content) => {
    el.setAttribute('name', 'theme-color');
    el.setAttribute('content', content);
  });
}

/**
 * Have a say when the window closes, while mounted: return true to keep it
 * open (and ask), then call window.close() yourself. Null for no guard.
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

