import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppDefinition } from '@/lib/apps';
import { areaAt, areaFor, primaryArea, snapRect, type Rect, type WorkArea } from '@/lib/monitors';
import { launchNativeApp } from '@/lib/nativeApps';
import { closeNativeWindow, isNativeWindowOpen } from '@/lib/nativeDisplay';

/** The X window a Din window hosts, if it hosts a live one. */
function liveNativeWindow(w: WindowState | undefined): number | null {
  const xid = w?.params?.xid;
  return typeof xid === 'number' && isNativeWindowOpen(xid) ? xid : null;
}

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
  // A closing window is already playing its exit animation; resurrecting it
  // on top of the stack would just have it die focused.
  if (!target || target.closing) return ws;
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
  /**
   * Whether the window is playing its close animation. close() marks the
   * window instead of removing it, so the Window component can animate the
   * farewell on the live element; destroy() then actually removes it.
   * Closing windows are excluded from focus/stacking and can't be raised.
   */
  closing: boolean;
  /** Whether the window fills its monitor's work area. */
  maximized: boolean;
  /**
   * Half-monitor edge tile, or null. Like `maximized`, this is a layout
   * derived from the monitor (the window renders at half its width against
   * the given edge); the window's own x/y/width/height keep their pre-tile
   * values so `restore` can return it there.
   */
  snapped: 'left' | 'right' | null;
  /**
   * The monitor (work area id) a maximized or tiled window fills; null
   * otherwise. Kept apart from x/y because those hold the restore spot,
   * which can be on another monitor (a window dragged across to snap).
   */
  monitor: string | null;
  /** Geometry to restore to when un-maximizing or un-tiling. */
  restore: { x: number; y: number; width: number; height: number } | null;
  /**
   * No title bar, border or resize handles: the content is the whole
   * window, at any size. For native apps that draw their own title bar (or
   * none), which also move themselves.
   */
  frameless: boolean;
  /**
   * What the window is showing, as published by its app (the browser's
   * page title, the terminal's command), or null to go by the app's name.
   * Tells apart several windows of one app in the Dock and the switcher.
   */
  title: string | null;
}

/**
 * Where a window is painted, in workspace coordinates: its monitor's work
 * area (or half of it) when maximized or tiled, else its own geometry.
 */
export function windowRect(w: WindowState, areas: WorkArea[]): Rect {
  if (!w.maximized && !w.snapped) return { x: w.x, y: w.y, width: w.width, height: w.height };
  const area = areas.find((a) => a.id === w.monitor) ?? areaFor(areas, w);
  return snapRect(area, w.maximized ? 'max' : (w.snapped ?? 'left'));
}

/** Minimum window size in pixels. */
export const MIN_WIDTH = 280;
export const MIN_HEIGHT = 160;

/**
 * A window size, held to the minimum - except for a frameless window,
 * which has no title bar to keep usable and is exactly as big as its app.
 */
function clampSize(width: number, height: number, frameless: boolean): { width: number; height: number } {
  return frameless
    ? { width: Math.max(1, width), height: Math.max(1, height) }
    : { width: Math.max(MIN_WIDTH, width), height: Math.max(MIN_HEIGHT, height) };
}

let nextId = 0;
const nextWindowId = () => `win-${nextId++}`;

/** The work area holding a window's (unsnapped) geometry. */
function areaOf(areas: WorkArea[], w: WindowState): WorkArea | null {
  return areas.length > 0 ? areaFor(areas, w) : null;
}

/** Spacing between successive windows opened on the same monitor. */
const CASCADE_PX = 28;

/**
 * Manages the set of open windows and their stacking/focus/geometry.
 *
 * @param getApp Resolver from app id to definition (built-in or installed
 *   web app). Must be referentially stable while the app list is unchanged.
 * @param getAreas The monitors' work areas, in workspace coordinates (read
 *   when an action needs them, so it must be stable but always current).
 */
export function useWindows(
  getApp: (id: string) => AppDefinition | undefined,
  getAreas: () => WorkArea[],
) {
  const [windows, setWindows] = useState<WindowState[]>([]);
  // For actions that must look before they leap without re-binding on every
  // commit (close, which asks native apps instead of deciding for them).
  const windowsRef = useRef(windows);
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  const focus = useCallback((id: string) => {
    setWindows((ws) => raise(ws, id));
  }, []);

  const open = useCallback((appId: string, params?: WindowParams) => {
    const app = getApp(appId);
    if (!app) return undefined;

    // Launching a native Linux app starts its process; its windows open Din
    // windows of their own as the app maps them (with an `xid` param, see
    // NativeDisplayHost). Routing it here means every launcher on the
    // desktop - Dock, apps menu, search - launches it without knowing the
    // difference.
    if (app.native && typeof params?.xid !== 'number') {
      launchNativeApp(appId);
      return undefined;
    }

    // Single-instance apps (e.g. Settings) reuse their existing window: focus
    // and un-minimize it, merging in any new launch params, rather than
    // spawning a duplicate.
    if (app.singleInstance) {
      const existing = windows.find((w) => w.appId === appId && !w.closing);
      if (existing) {
        setWindows((ws) =>
          raise(
            params
              ? ws.map((w) =>
                  w.id === existing.id
                    ? { ...w, params: { ...w.params, ...params } }
                    : w,
                )
              : ws,
            existing.id,
          ),
        );
        return existing.id;
      }
    }

    // A native window opens at the size its app asked for; a frameless one
    // exactly so, with no frame to keep usable.
    const frameless = params?.frameless === true;
    const size =
      typeof params?.width === 'number' && typeof params?.height === 'number'
        ? clampSize(params.width, params.height, frameless)
        : (app.defaultSize ?? { width: 800, height: 560 });
    const id = nextWindowId();

    setWindows((ws) => {
      // New windows open on the monitor of the focused window, cascading
      // from its top-left corner.
      const areas = getAreas();
      const focused = ws.reduce<WindowState | null>(
        (top, w) => (!w.minimized && !w.closing && (!top || w.z > top.z) ? w : top),
        null,
      );
      const area = focused
        ? focused.monitor
          ? areas.find((a) => a.id === focused.monitor) ?? areaOf(areas, focused)
          : areaOf(areas, focused)
        : areas.length > 0
          ? primaryArea(areas)
          : null;
      const offset = (area ? ws.filter((w) => areaOf(areas, w) === area).length : ws.length) * CASCADE_PX;
      return [
        ...ws,
        {
          id,
          appId,
          params,
          x: (area?.x ?? 0) + 80 + offset,
          y: (area?.y ?? 0) + 60 + offset,
          width: size.width,
          height: size.height,
          z: maxZ(ws) + 1,
          minimized: false,
          closing: false,
          maximized: false,
          snapped: null,
          monitor: null,
          restore: null,
          frameless,
          title: null,
        },
      ];
    });
    return id;
  }, [getApp, getAreas, windows]);

  /**
   * Begin closing a window: it stays mounted, marked `closing`, while the
   * Window component plays the exit animation; destroy() finishes the job.
   *
   * A native window is the app's to close: it's asked to (and may prompt to
   * save, or refuse), and its Din window closes when the X window goes away.
   */
  const close = useCallback((id: string) => {
    const xid = liveNativeWindow(windowsRef.current.find((w) => w.id === id));
    if (xid !== null) {
      closeNativeWindow(xid);
      return;
    }
    setWindows((ws) =>
      ws.some((w) => w.id === id && !w.closing)
        ? ws.map((w) => (w.id === id ? { ...w, closing: true } : w))
        : ws,
    );
  }, []);

  const closeApp = useCallback((appId: string) => {
    for (const w of windowsRef.current) {
      const xid = w.appId === appId ? liveNativeWindow(w) : null;
      if (xid !== null) closeNativeWindow(xid);
    }
    setWindows((ws) =>
      ws.some((w) => w.appId === appId && !w.closing && liveNativeWindow(w) === null)
        ? ws.map((w) =>
            w.appId === appId && liveNativeWindow(w) === null ? { ...w, closing: true } : w,
          )
        : ws,
    );
  }, []);

  /** Remove a window for real, once its close animation has finished. */
  const destroy = useCallback((id: string) => {
    setWindows((ws) =>
      ws.some((w) => w.id === id) ? ws.filter((w) => w.id !== id) : ws,
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
      setWindows((ws) => {
        const t = ws.find((w) => w.id === id);
        const { width, height } = clampSize(geometry.width, geometry.height, t?.frameless ?? false);
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

  /**
   * Take a window's frame away, or give it back (a native app changed its
   * mind), resizing it to `geometry` in the same commit so the content
   * doesn't jump.
   */
  const setFrameless = useCallback(
    (id: string, frameless: boolean, geometry: { x: number; y: number; width: number; height: number }) => {
      setWindows((ws) =>
        ws.map((w) =>
          w.id === id
            ? { ...w, frameless, x: geometry.x, y: geometry.y, ...clampSize(geometry.width, geometry.height, frameless) }
            : w,
        ),
      );
    },
    [],
  );

  /** Set (or clear, with null) the title a window's app publishes. */
  const setTitle = useCallback((id: string, title: string | null) => {
    setWindows((ws) =>
      ws.some((w) => w.id === id && w.title !== title)
        ? ws.map((w) => (w.id === id ? { ...w, title } : w))
        : ws,
    );
  }, []);

  /**
   * Maximize a window (no-op if already maximized). `restore` overrides the
   * geometry remembered for un-maximizing - the drag-to-top-edge snap passes
   * the window's pre-drag spot so a later restore returns it there, not to
   * wherever it was dropped along the top edge. `monitor` is the work area
   * to fill; by default, the one the window is on.
   */
  const maximize = useCallback(
    (id: string, restore?: { x: number; y: number; width: number; height: number }, monitor?: string) => {
      setWindows((ws) => {
        const top = maxZ(ws);
        return ws.map((w) =>
          w.id === id && !w.maximized
            ? {
                ...w,
                maximized: true,
                snapped: null,
                monitor: monitor ?? w.monitor ?? areaOf(getAreas(), w)?.id ?? null,
                restore: restore ?? w.restore ?? { x: w.x, y: w.y, width: w.width, height: w.height },
                z: top + 1,
              }
            : w,
        );
      });
    },
    [getAreas],
  );

  /**
   * Un-maximize / un-tile a window to an explicit geometry (no-op if neither
   * maximized nor tiled). Used by the title-bar tear-away drag, which
   * restores the window under the cursor rather than at its remembered spot.
   */
  const unmaximize = useCallback(
    (id: string, geometry: { x: number; y: number; width: number; height: number }) => {
      setWindows((ws) =>
        ws.map((w) =>
          w.id === id && (w.maximized || w.snapped)
            ? { ...w, ...geometry, maximized: false, snapped: null, monitor: null, restore: null }
            : w,
        ),
      );
    },
    [],
  );

  /**
   * Tile a window to the left or right half of a monitor (no-op if already
   * tiled to that side there). `restore` overrides the geometry remembered
   * for un-tiling - the drag-to-edge snap passes the window's pre-drag spot
   * so a later restore returns it there. Like `maximize`, the tile is
   * derived from the monitor, so the window's x/y/width/height are left
   * untouched. `monitor` defaults to the one the window is on.
   */
  const tile = useCallback(
    (
      id: string,
      side: 'left' | 'right',
      restore?: { x: number; y: number; width: number; height: number },
      monitor?: string,
    ) => {
      setWindows((ws) => {
        const top = maxZ(ws);
        return ws.map((w) => {
          if (w.id !== id) return w;
          const target = monitor ?? w.monitor ?? areaOf(getAreas(), w)?.id ?? null;
          return w.snapped !== side || w.monitor !== target
            ? {
                ...w,
                snapped: side,
                maximized: false,
                monitor: target,
                restore:
                  restore ??
                  w.restore ?? { x: w.x, y: w.y, width: w.width, height: w.height },
                z: top + 1,
              }
            : w;
        });
      });
    },
    [getAreas],
  );

  /**
   * Alt+Tab-style focus cycling through the non-minimized windows.
   * Forward raises the bottom-most window to the top, so repeated presses
   * visit every window in order; backward sends the top window to the back,
   * exactly undoing a forward step.
   */
  const cycleFocus = useCallback((backward = false) => {
    setWindows((ws) => {
      const visible = ws
        .filter((w) => !w.minimized && !w.closing)
        .sort((a, b) => a.z - b.z);
      if (visible.length < 2) return ws;
      const rotated = backward
        ? [visible[visible.length - 1], ...visible.slice(0, -1)]
        : [...visible.slice(1), visible[0]];
      // Reassign 1..N in the new order. Colliding with a minimized window's
      // z is harmless: hidden windows don't take part in stacking or focus.
      const zOf = new Map(rotated.map((w, i) => [w.id, i + 1]));
      return ws.map((w) => (zOf.has(w.id) ? { ...w, z: zOf.get(w.id)! } : w));
    });
  }, []);

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
            snapped: null,
            monitor: null,
            restore: null,
            z: top + 1,
          };
        }
        // Maximize. A tiled window keeps its pre-tile geometry (w.restore) as
        // the restore target, and its monitor; a normal window remembers its
        // current geometry and fills the monitor it's on.
        return {
          ...w,
          maximized: true,
          snapped: null,
          monitor: w.monitor ?? areaOf(getAreas(), w)?.id ?? null,
          restore: w.restore ?? { x: w.x, y: w.y, width: w.width, height: w.height },
          z: top + 1,
        };
      });
    });
  }, [getAreas]);

  /**
   * Bring windows home after the monitors change: a maximized or tiled
   * window whose monitor went away fills the primary instead, and a window
   * whose title bar no longer lands on any monitor (it was on one that was
   * unplugged, or now sits in the dead area beside a smaller one) moves to
   * the primary, keeping its size. Restore spots are moved the same way.
   */
  const fitToAreas = useCallback((areas: WorkArea[]) => {
    if (areas.length === 0) return;
    const primary = primaryArea(areas);
    const ids = new Set(areas.map((a) => a.id));
    /** A rect moved onto the primary if its title bar is lost, else null. */
    const rehome = (r: { x: number; y: number; width: number }, i: number) =>
      [40, r.width / 2, r.width - 40].some((dx) => areaAt(areas, r.x + dx, r.y + 18))
        ? null
        : { x: primary.x + 80 + i * CASCADE_PX, y: primary.y + 60 + i * CASCADE_PX };
    setWindows((ws) => {
      let changed = false;
      let lost = 0;
      const next = ws.map((w) => {
        let out = w;
        if (w.monitor !== null && !ids.has(w.monitor)) out = { ...out, monitor: primary.id };
        const moved = rehome(w, lost);
        if (moved) out = { ...out, ...moved };
        const restoreMoved = w.restore ? rehome(w.restore, lost) : null;
        if (w.restore && restoreMoved) out = { ...out, restore: { ...w.restore, ...restoreMoved } };
        if (out !== w) {
          changed = true;
          if (moved || restoreMoved) lost++;
        }
        return out;
      });
      return changed ? next : ws;
    });
  }, []);

  // The actions object is referentially stable for the lifetime of the
  // desktop (all callbacks have stable identities except `open`, which only
  // changes when the installed-app list changes). Components that only
  // dispatch actions subscribe to this via WindowActionsContext and are NOT
  // re-rendered when window state changes - that's what lets memo(Window)
  // and memo(DockItem) actually skip work.
  const actions = useMemo(
    () => ({
      open,
      close,
      closeApp,
      destroy,
      minimize,
      focus,
      move,
      resize,
      maximize,
      unmaximize,
      tile,
      toggleMaximize,
      cycleFocus,
      setFrameless,
      setTitle,
      fitToAreas,
    }),
    [open, close, closeApp, destroy, minimize, focus, move, resize, maximize, unmaximize, tile, toggleMaximize, cycleFocus, setFrameless, setTitle, fitToAreas],
  );

  // Back-compat full manager: state + actions in one object. Its identity
  // changes on every window mutation, so only components that genuinely
  // need `windows` should consume it.
  return useMemo(() => ({ windows, actions, ...actions }), [windows, actions]);
}

export type WindowManager = ReturnType<typeof useWindows>;

/** The stable action set of the window manager (no state). */
export type WindowActions = WindowManager['actions'];
