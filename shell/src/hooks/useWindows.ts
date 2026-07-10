import { useCallback, useState } from 'react';
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
}

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

  return { windows, open, close, minimize, focus, move };
}

export type WindowManager = ReturnType<typeof useWindows>;
