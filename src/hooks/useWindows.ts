import { useCallback, useMemo, useState } from 'react';
import type { AppDefinition } from '@/lib/apps';

/** Highest z among the given windows (0 if none). */
function maxZ(windows: WindowState[]): number {
  return windows.reduce((max, w) => Math.max(max, w.z), 0);
}

/**
 * The z counter only ever increments, so compact it back to 1..N once it
 * grows past this. Keeps window z-indexes bounded (the Dock sits at 9999,
 * and windows must never stack above it).
 */
const Z_COMPACT_THRESHOLD = 5000;

/**
 * Raise a window to the top of the stack (and un-minimize it).
 *
 * Returns the input array unchanged when the window is already the visible
 * top - this is the hot path: every pointer-down on a window calls focus(),
 * and clicks inside the already-focused window would otherwise rebuild the
 * array and re-render the whole desktop (all windows, dock, menu bar) for
 * nothing.
 */
function raise(ws: WindowState[], id: string): WindowState[] {
  const target = ws.find((w) => w.id === id);
  if (!target) return ws;
  const top = maxZ(ws);
  if (!target.minimized && target.z === top) return ws;
  if (top < Z_COMPACT_THRESHOLD) {
    return ws.map((w) =>
      w.id === id ? { ...w, z: top + 1, minimized: false } : w,
    );
  }
  // Compact: reassign 1..N in stacking order, with the target on top.
  const order = new Map(
    [...ws].sort((a, b) => a.z - b.z).map((w, i) => [w.id, i + 1]),
  );
  return ws.map((w) =>
    w.id === id
      ? { ...w, z: ws.length + 1, minimized: false }
      : { ...w, z: order.get(w.id)! },
  );
}

/**
 * Arbitrary launch parameters passed to an app instance when its window is
 * opened. Serializable, app-defined; the app reads them off its props.
 */
export type WindowParams = Record<string, unknown>;

/** A live window instance on the desktop. */
export interface WindowState {
  /** Unique per-instance id. */
  id: string;
  /** The app definition id this window hosts. */
  appId: string;
  /** Launch parameters passed at open() time, or undefined. */
  params?: WindowParams;
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

/**
 * Manages the set of open windows and their stacking/focus/geometry.
 *
 * @param getApp Resolver from app id to definition (built-in or installed
 *   web app). Must be referentially stable while the app list is unchanged.
 */
export function useWindows(getApp: (id: string) => AppDefinition | undefined) {
  const [windows, setWindows] = useState<WindowState[]>([]);

  const focus = useCallback((id: string) => {
    setWindows((ws) => raise(ws, id));
  }, []);

  const open = useCallback((appId: string, params?: WindowParams) => {
    const app = getApp(appId);
    if (!app) return undefined;

    const size = app.defaultSize ?? { width: 800, height: 560 };
    const id = nextWindowId();

    setWindows((ws) => {
      const offset = ws.length * 28;
      return [
        ...ws,
        {
          id,
          appId,
          params,
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
    return id;
  }, [getApp]);

  const close = useCallback((id: string) => {
    setWindows((ws) => ws.filter((w) => w.id !== id));
  }, []);

  const closeApp = useCallback((appId: string) => {
    setWindows((ws) =>
      ws.some((w) => w.appId === appId)
        ? ws.filter((w) => w.appId !== appId)
        : ws,
    );
  }, []);

  const minimize = useCallback((id: string) => {
    setWindows((ws) =>
      ws.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
    );
  }, []);

  const move = useCallback((id: string, x: number, y: number) => {
    setWindows((ws) => {
      // A click on the title bar without movement commits the same
      // geometry; skip the no-op update (it would re-render the desktop).
      const target = ws.find((w) => w.id === id);
      if (!target || (target.x === x && target.y === y)) return ws;
      return ws.map((w) => (w.id === id ? { ...w, x, y } : w));
    });
  }, []);

  const resize = useCallback(
    (id: string, geometry: { x: number; y: number; width: number; height: number }) => {
      const width = Math.max(MIN_WIDTH, geometry.width);
      const height = Math.max(MIN_HEIGHT, geometry.height);
      setWindows((ws) => {
        const t = ws.find((w) => w.id === id);
        if (
          !t ||
          (t.x === geometry.x &&
            t.y === geometry.y &&
            t.width === width &&
            t.height === height)
        ) {
          return ws;
        }
        return ws.map((w) =>
          w.id === id ? { ...w, x: geometry.x, y: geometry.y, width, height } : w,
        );
      });
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

  // The actions object is referentially stable for the lifetime of the
  // desktop (all callbacks have stable identities except `open`, which only
  // changes when the installed-app list changes). Components that only
  // dispatch actions subscribe to this via WindowActionsContext and are NOT
  // re-rendered when window state changes - that's what lets memo(Window)
  // and memo(DockItem) actually skip work.
  const actions = useMemo(
    () => ({ open, close, closeApp, minimize, focus, move, resize, toggleMaximize }),
    [open, close, closeApp, minimize, focus, move, resize, toggleMaximize],
  );

  // Back-compat full manager: state + actions in one object. Its identity
  // changes on every window mutation, so only components that genuinely
  // need `windows` should consume it.
  return useMemo(() => ({ windows, actions, ...actions }), [windows, actions]);
}

export type WindowManager = ReturnType<typeof useWindows>;

/** The stable action set of the window manager (no state). */
export type WindowActions = WindowManager['actions'];
