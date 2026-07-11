import { useCallback, useMemo, useState } from 'react';
import { getApp } from '@/lib/apps';

/** Highest z among the given windows (0 if none). */
function maxZ(windows: WindowState[]): number {
  return windows.reduce((max, w) => Math.max(max, w.z), 0);
}

/** A live window instance on the desktop. */
export interface WindowState {
  /** Unique per-instance id. */
  id: string;
  /** The app definition id this window hosts. */
  appId: string;
  /** Position of the top-left corner, in pixels relative to the workspace. */
  x: number;
  y: number;
  /** Size in pixels. */
  width: number;
  height: number;
  /** Stacking order; higher renders on top. */
  z: number;
  /** Whether the window is minimized to the taskbar. */
  minimized: boolean;
  /** Whether the window fills the workspace. */
  maximized: boolean;
  /** Geometry to restore to when un-maximizing. */
  restore: { x: number; y: number; width: number; height: number } | null;
}

/** Minimum window size in pixels. */
export const MIN_WIDTH = 280;
export const MIN_HEIGHT = 160;

let nextId = 0;
const nextWindowId = () => `win-${nextId++}`;

/** Manages the set of open windows and their stacking/focus/geometry. */
export function useWindows() {
  const [windows, setWindows] = useState<WindowState[]>([]);

  const focus = useCallback((id: string) => {
    setWindows((ws) => {
      const top = maxZ(ws);
      return ws.map((w) =>
        w.id === id ? { ...w, z: top + 1, minimized: false } : w,
      );
    });
  }, []);

  const open = useCallback((appId: string) => {
    const app = getApp(appId);
    if (!app) return;

    const size = app.defaultSize ?? { width: 800, height: 560 };
    const id = nextWindowId();

    setWindows((ws) => {
      const offset = ws.length * 28;
      return [
        ...ws,
        {
          id,
          appId,
          x: 80 + offset,
          y: 60 + offset,
          width: size.width,
          height: size.height,
          z: maxZ(ws) + 1,
          minimized: false,
          maximized: false,
          restore: null,
        },
      ];
    });
  }, []);

  const close = useCallback((id: string) => {
    setWindows((ws) => ws.filter((w) => w.id !== id));
  }, []);

  const minimize = useCallback((id: string) => {
    setWindows((ws) =>
      ws.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
    );
  }, []);

  const move = useCallback((id: string, x: number, y: number) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, x, y } : w)));
  }, []);

  const resize = useCallback(
    (id: string, geometry: { x: number; y: number; width: number; height: number }) => {
      setWindows((ws) =>
        ws.map((w) =>
          w.id === id
            ? {
                ...w,
                x: geometry.x,
                y: geometry.y,
                width: Math.max(MIN_WIDTH, geometry.width),
                height: Math.max(MIN_HEIGHT, geometry.height),
              }
            : w,
        ),
      );
    },
    [],
  );

  const toggleMaximize = useCallback((id: string) => {
    setWindows((ws) => {
      const top = maxZ(ws);
      return ws.map((w) => {
        if (w.id !== id) return w;
        if (w.maximized && w.restore) {
          // Restore to the saved geometry.
          return {
            ...w,
            ...w.restore,
            maximized: false,
            restore: null,
            z: top + 1,
          };
        }
        // Maximize: remember the current geometry to restore later.
        return {
          ...w,
          maximized: true,
          restore: { x: w.x, y: w.y, width: w.width, height: w.height },
          z: top + 1,
        };
      });
    });
  }, []);

  // Stable identity as long as `windows` doesn't change (all callbacks are
  // stable), so context consumers and memoized components don't re-render
  // just because the owner of this hook re-rendered.
  return useMemo(
    () => ({ windows, open, close, minimize, focus, move, resize, toggleMaximize }),
    [windows, open, close, minimize, focus, move, resize, toggleMaximize],
  );
}

export type WindowManager = ReturnType<typeof useWindows>;
