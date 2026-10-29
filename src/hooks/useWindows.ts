import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppDefinition } from '@/lib/apps';
import { endLaunching } from '@/lib/appLaunches';
import { closeIntercepted } from '@/lib/closeGuards';
import { areaAt, areaFor, primaryArea, snapRect, type Rect, type WorkArea } from '@/lib/monitors';
import { launchNativeApp } from '@/lib/nativeApps';
import { closeNativeWindow, isNativeWindowOpen } from '@/lib/nativeDisplay';
import { fullscreenMonitorId } from '@/lib/pageFullscreen';
import {
  insertLeaf,
  layoutTree,
  removeLeaf,
  renameLeaves,
  resizeLeaf,
  tilingRect,
  toggleSplit as toggleTreeSplit,
  treeLeaves,
  type TileNode,
} from '@/lib/tiling';
import type { Direction } from '@/lib/wmBindings';

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
  /**
   * An icon the app publishes for what the window is showing (Preview's
   * picture, video or file), or null to go by the app's icon.
   */
  icon: string | null;
  /**
   * The title bar's tint as published by its app (a page's theme-color),
   * already sanitized, or null for the default chrome. The menu bar matches
   * it while the window is maximized beneath it.
   */
  accent: string | null;
  /**
   * The workspace (1-10) the window is on, of its monitor's. Each monitor
   * shows one of its workspaces at a time; see `away`.
   */
  workspace: number;
  /**
   * Whether the window stays out of the tiling layout while tiling is on
   * (Super+T, or an app that asks to float, like Calculator). Meaningless
   * while tiling is off, when every window floats.
   */
  floating: boolean;
  /**
   * The rect the tiling layout gives the window, in workspace coordinates,
   * or null when it isn't tiled. Derived by the manager on every commit;
   * x/y/width/height keep the floating geometry to return to.
   */
  tiled: Rect | null;
  /**
   * Whether the window's workspace isn't the one its monitor is showing.
   * Derived like `tiled`. An away window is hidden the way a minimized one
   * is (mounted, so its app keeps its state) and doesn't count for focus.
   */
  away: boolean;
}

/**
 * Where a window is painted, in workspace coordinates: its monitor's work
 * area when maximized, its tile while tiled, half its monitor's work area
 * when edge-tiled, else its own geometry.
 */
export function windowRect(w: WindowState, areas: WorkArea[]): Rect {
  if (w.tiled && !w.maximized) return w.tiled;
  if (!w.maximized && !w.snapped) return { x: w.x, y: w.y, width: w.width, height: w.height };
  const area = areas.find((a) => a.id === w.monitor) ?? areaFor(areas, w);
  return snapRect(area, w.maximized ? 'max' : (w.snapped ?? 'left'));
}

/** Whether a window is on screen: not minimized, closing, or on another workspace. */
export function isShown(w: WindowState): boolean {
  return !w.minimized && !w.closing && !w.away;
}

/** The focused window: the highest one on screen, or null. */
export function focusedWindow(windows: WindowState[]): WindowState | null {
  return windows.reduce<WindowState | null>((top, w) => (isShown(w) && (!top || w.z > top.z) ? w : top), null);
}

/** How the tiling layout is set up (AppConfig's tiling settings). */
export interface TilingSettings {
  enabled: boolean;
  /** Pixels between tiles, and between them and the monitor's edges. */
  gap: number;
}

/** The window manager's whole state. */
interface WmState {
  windows: WindowState[];
  /** The tiling tree of each monitor's workspace, by treeKey. */
  trees: Record<string, TileNode>;
  /** The workspace each monitor (work area id) shows; 1 when absent. */
  active: Record<string, number>;
  /** The workspace each monitor showed before, for Super+Ctrl+Tab. */
  previous: Record<string, number>;
}

/** Workspaces per monitor, Super+1 to Super+0. */
export const WORKSPACE_COUNT = 10;

const treeKey = (areaId: string, workspace: number) => `${workspace}@${areaId}`;

/** The workspace a monitor is showing. */
export function activeWorkspace(active: Record<string, number>, areaId: string): number {
  return active[areaId] ?? 1;
}

/**
 * The work area a window lives on: the one it's maximized or edge-tiled
 * on, else the one under its floating geometry (which a tiled window keeps
 * on the monitor it's tiled on).
 */
export function homeArea(areas: WorkArea[], w: WindowState): WorkArea | null {
  if (areas.length === 0) return null;
  if (w.monitor !== null) {
    const area = areas.find((a) => a.id === w.monitor);
    if (area) return area;
  }
  return areaFor(areas, w);
}

/** Whether a window takes part in the tiling layout. */
function tileable(w: WindowState, tiling: TilingSettings): boolean {
  return tiling.enabled && !w.floating && !w.frameless && !w.closing && !w.minimized && w.snapped === null;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Bring the derived parts of the state in line after a change: a window
 * that went to another monitor joins the workspace showing there; the
 * tiling trees gain and lose windows to match who's tileable where; then
 * every window gets its tile rect and whether it's away. Unchanged windows
 * (and trees) keep their identity, so memoized windows don't re-render.
 */
function settle(prev: WmState, next: WmState, areas: WorkArea[], tiling: TilingSettings): WmState {
  if (areas.length === 0) return next;
  const before = new Map(prev.windows.map((w) => [w.id, w]));
  let windows = next.windows.map((w) => {
    const old = before.get(w.id);
    if (!old || old === w) return w;
    const to = homeArea(areas, w)!;
    if (homeArea(areas, old)!.id === to.id) return w;
    const workspace = activeWorkspace(next.active, to.id);
    return w.workspace === workspace ? w : { ...w, workspace };
  });

  // Who tiles where.
  const groups = new Map<string, { area: WorkArea; members: WindowState[] }>();
  const homes = new Map<string, WorkArea>();
  for (const w of windows) {
    const area = homeArea(areas, w)!;
    homes.set(w.id, area);
    if (!tileable(w, tiling)) continue;
    const key = treeKey(area.id, w.workspace);
    const group = groups.get(key);
    if (group) group.members.push(w);
    else groups.set(key, { area, members: [w] });
  }

  let trees = next.trees;
  if (tiling.enabled) {
    const updated: Record<string, TileNode> = { ...trees };
    let changed = false;
    for (const [key, tree] of Object.entries(trees)) {
      const members = new Set(groups.get(key)?.members.map((w) => w.id));
      let t: TileNode | null = tree;
      for (const id of treeLeaves(tree)) if (!members.has(id)) t = removeLeaf(t, id);
      if (t === tree) continue;
      changed = true;
      if (t) updated[key] = t;
      else delete updated[key];
    }
    for (const [key, { area, members }] of groups) {
      let t: TileNode | null = updated[key] ?? null;
      const present = new Set(treeLeaves(t));
      const added = members.filter((w) => !present.has(w.id)).sort((a, b) => a.z - b.z);
      if (added.length === 0) continue;
      const rect = tilingRect(area, tiling.gap);
      for (const w of added) {
        // A new window splits the focused tile: the highest one already in.
        const target = members.reduce<WindowState | null>(
          (top, m) => (present.has(m.id) && (!top || m.z > top.z) ? m : top),
          null,
        );
        t = insertLeaf(t, w.id, target?.id ?? null, rect, tiling.gap);
        present.add(w.id);
      }
      updated[key] = t!;
      changed = true;
    }
    if (changed) trees = updated;
  }

  const rects = new Map<string, Rect>();
  if (tiling.enabled) {
    for (const [key, { area }] of groups) {
      layoutTree(trees[key] ?? null, tilingRect(area, tiling.gap), tiling.gap, rects);
    }
  }
  let windowsChanged = windows.some((w, i) => w !== next.windows[i]);
  windows = windows.map((w) => {
    const away = w.workspace !== activeWorkspace(next.active, homes.get(w.id)!.id);
    const tiled = rects.get(w.id) ?? null;
    if (away === w.away && sameRect(tiled, w.tiled)) return w;
    windowsChanged = true;
    return { ...w, away, tiled };
  });
  if (!windowsChanged && trees === next.trees) return next;
  return { ...next, windows: windowsChanged ? windows : next.windows, trees };
}

/**
 * The geometry of `w` carried over from one work area to another, keeping
 * its place relative to the monitor (held inside it), restore spot too.
 */
function carryTo(w: WindowState, from: WorkArea, to: WorkArea): WindowState {
  const carry = (r: { x: number; y: number; width: number; height: number }) => {
    const width = Math.min(r.width, to.width);
    const height = Math.min(r.height, to.height);
    return {
      x: to.x + Math.max(0, Math.min(r.x - from.x, to.width - width)),
      y: to.y + Math.max(0, Math.min(r.y - from.y, to.height - height)),
      width,
      height,
    };
  };
  return {
    ...w,
    ...carry(w),
    restore: w.restore ? carry(w.restore) : null,
    monitor: w.monitor !== null ? to.id : null,
  };
}

/**
 * The best of `candidates` in direction `dir` from `from`: centers that lie
 * that way, nearest along the axis, with a penalty for being off to the side.
 */
export function inDirection<T>(from: Rect, dir: Direction, candidates: { item: T; rect: Rect }[]): T | null {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  const horizontal = dir === 'left' || dir === 'right';
  let best: T | null = null;
  let bestScore = Infinity;
  for (const { item, rect } of candidates) {
    const dx = rect.x + rect.width / 2 - cx;
    const dy = rect.y + rect.height / 2 - cy;
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    if (along <= 1) continue;
    // How far apart the two are across the axis (0 when their spans overlap).
    const gap = horizontal
      ? Math.max(0, rect.y - (from.y + from.height), from.y - (rect.y + rect.height))
      : Math.max(0, rect.x - (from.x + from.width), from.x - (rect.x + rect.width));
    if (gap > along) continue;
    const score = along + gap * 2;
    if (score < bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
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
 * Show workspace `n` on a monitor, remembering the one it showed for
 * Super+Ctrl+Tab. With `raiseTop`, its highest window comes up on top, so
 * it has focus (a raise on its own does that when focusing a window).
 */
function showWorkspace(s: WmState, areas: WorkArea[], areaId: string, n: number, raiseTop: boolean): WmState {
  const current = activeWorkspace(s.active, areaId);
  if (current === n) return s;
  const next: WmState = {
    ...s,
    active: { ...s.active, [areaId]: n },
    previous: { ...s.previous, [areaId]: current },
  };
  if (!raiseTop) return next;
  const top = s.windows.reduce<WindowState | null>(
    (t, w) =>
      w.workspace === n && !w.minimized && !w.closing && homeArea(areas, w)?.id === areaId && (!t || w.z > t.z)
        ? w
        : t,
    null,
  );
  return top ? { ...next, windows: raise(next.windows, top.id) } : next;
}

/**
 * Manages the set of open windows and their stacking/focus/geometry.
 *
 * @param getApp Resolver from app id to definition (built-in or installed
 *   web app). Must be referentially stable while the app list is unchanged.
 * @param getAreas The monitors' work areas, in workspace coordinates (read
 *   when an action needs them, so it must be stable but always current).
 * @param getLaunchMonitor The monitor the user just clicked on, if any: new
 *   windows open there (stable, like getAreas).
 * @param getTiling The tiling settings (stable, like getAreas; call
 *   `relayout` when they change).
 */
export function useWindows(
  getApp: (id: string) => AppDefinition | undefined,
  getAreas: () => WorkArea[],
  getLaunchMonitor: () => string | null,
  getTiling: () => TilingSettings,
) {
  const [state, setState] = useState<WmState>({ windows: [], trees: {}, active: {}, previous: {} });
  const { windows, active } = state;

  /** Change the state; settle() then brings the derived parts in line. */
  const update = useCallback(
    (fn: (s: WmState) => WmState) => {
      setState((s) => {
        const next = fn(s);
        return next === s ? s : settle(s, next, getAreas(), getTiling());
      });
    },
    [getAreas, getTiling],
  );
  const setWindows = useCallback(
    (fn: (ws: WindowState[]) => WindowState[]) =>
      update((s) => {
        const ws = fn(s.windows);
        return ws === s.windows ? s : { ...s, windows: ws };
      }),
    [update],
  );

  // The monitor keyboard commands act on: the one last clicked on, or
  // holding the window last focused. A ref, since every click sets it and
  // nothing renders from it.
  const currentMonitor = useRef<string | null>(null);
  const setCurrentMonitor = useCallback((id: string) => {
    currentMonitor.current = id;
  }, []);
  // For actions that must look before they leap without re-binding on every
  // commit (close, which asks native apps instead of deciding for them, and
  // open, which reuses a single-instance app's window). A layout effect, so
  // it is current before any input the commit could have prompted.
  const windowsRef = useRef(windows);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    windowsRef.current = windows;
    stateRef.current = state;
  }, [windows, state]);

  // A native app's new window is the end of its launch. After the commit,
  // so a launching app's Dock tile never blinks out between the two.
  const seenIds = useRef(new Set<string>());
  useEffect(() => {
    for (const w of windows) {
      if (!seenIds.current.has(w.id)) endLaunching(w.appId);
    }
    seenIds.current = new Set(windows.map((w) => w.id));
  }, [windows]);

  /** Raise a window, first showing its workspace if it's on another one. */
  const focus = useCallback((id: string) => {
    const known = windowsRef.current.find((w) => w.id === id);
    const knownArea = known ? homeArea(getAreas(), known) : null;
    if (knownArea) currentMonitor.current = knownArea.id;
    update((s) => {
      const target = s.windows.find((w) => w.id === id);
      if (!target) return s;
      const area = homeArea(getAreas(), target);
      const shown = area ? showWorkspace(s, getAreas(), area.id, target.workspace, false) : s;
      const ws = raise(shown.windows, id);
      return ws === shown.windows ? shown : { ...shown, windows: ws };
    });
  }, [update, getAreas]);

  const open = useCallback((requestedId: string, requestedParams?: WindowParams) => {
    let appId = requestedId;
    let params = requestedParams;
    let app = getApp(appId);
    if (!app) return undefined;

    // A terminal app (htop) opens a Terminal window running it.
    if (app.native && app.terminal) {
      params = { ...params, app: appId, appName: app.name };
      appId = 'terminal';
      app = getApp(appId);
      if (!app) return undefined;
    }

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
      // Read through the ref, not `windows`: depending on the array would
      // re-create open() - and with it every action consumers hold - on
      // each focus, move and resize.
      const existing = windowsRef.current.find((w) => w.appId === appId && !w.closing);
      if (existing) {
        if (params) {
          setWindows((ws) =>
            ws.map((w) =>
              w.id === existing.id
                ? { ...w, params: { ...w.params, ...params } }
                : w,
            ),
          );
        }
        focus(existing.id);
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

    const launchMonitor = getLaunchMonitor() ?? currentMonitor.current;
    // Dialogs and small tools float in the tiling layout, as Hyprland's
    // window rules have them.
    const floating = params?.floating === true || app.floating === true;
    update((s) => {
      const ws = s.windows;
      // New windows open on the monitor the user just clicked on (or last
      // worked on from the keyboard), else the focused window's, cascading
      // from its top-left corner, on the workspace that monitor shows.
      const areas = getAreas();
      const focused = focusedWindow(ws);
      const clicked = launchMonitor ? areas.find((a) => a.id === launchMonitor) : undefined;
      const picked =
        clicked ??
        (focused ? homeArea(areas, focused) : areas.length > 0 ? primaryArea(areas) : null);
      // Not behind a fullscreen page: on the primary monitor, else another.
      const covered = fullscreenMonitorId();
      const area =
        picked && picked.id === covered
          ? (areas.find((a) => a.primary && a.id !== covered) ?? areas.find((a) => a.id !== covered) ?? picked)
          : picked;
      const workspace = area ? activeWorkspace(s.active, area.id) : 1;
      const offset =
        (area
          ? ws.filter((w) => w.workspace === workspace && areaOf(areas, w) === area).length
          : ws.length) * CASCADE_PX;
      const windows: WindowState[] = [
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
          icon: null,
          accent: null,
          workspace,
          floating,
          tiled: null,
          away: false,
        },
      ];
      return { ...s, windows };
    });
    return id;
  }, [getApp, getAreas, getLaunchMonitor, update, setWindows, focus]);

  /**
   * Begin closing a window: it stays mounted, marked `closing`, while the
   * Window component plays the exit animation; destroy() finishes the job.
   *
   * A native window is the app's to close: it's asked to (and may prompt to
   * save, or refuse), and its Din window closes when the X window goes away.
   * A built-in app with unsaved work may likewise ask first (closeGuards).
   */
  const close = useCallback((id: string) => {
    const xid = liveNativeWindow(windowsRef.current.find((w) => w.id === id));
    if (xid !== null) {
      closeNativeWindow(xid);
      return;
    }
    if (closeIntercepted(id)) return;
    setWindows((ws) =>
      ws.some((w) => w.id === id && !w.closing)
        ? ws.map((w) => (w.id === id ? { ...w, closing: true } : w))
        : ws,
    );
  }, [setWindows]);

  const closeApp = useCallback((appId: string) => {
    const kept = new Set<string>();
    for (const w of windowsRef.current) {
      if (w.appId !== appId) continue;
      const xid = liveNativeWindow(w);
      if (xid !== null) closeNativeWindow(xid);
      else if (!w.closing && closeIntercepted(w.id)) kept.add(w.id);
    }
    const closes = (w: WindowState) =>
      w.appId === appId && !kept.has(w.id) && liveNativeWindow(w) === null;
    setWindows((ws) =>
      ws.some((w) => closes(w) && !w.closing)
        ? ws.map((w) => (closes(w) ? { ...w, closing: true } : w))
        : ws,
    );
  }, [setWindows]);

  /** Remove a window for real, once its close animation has finished. */
  const destroy = useCallback((id: string) => {
    setWindows((ws) =>
      ws.some((w) => w.id === id) ? ws.filter((w) => w.id !== id) : ws,
    );
  }, [setWindows]);

  const minimize = useCallback((id: string) => {
    setWindows((ws) =>
      ws.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
    );
  }, [setWindows]);

  const move = useCallback((id: string, x: number, y: number) => {
    setWindows((ws) => {
      // A click on the title bar without movement commits the same
      // geometry; skip the no-op update (it would re-render the desktop).
      const target = ws.find((w) => w.id === id);
      if (!target || (target.x === x && target.y === y)) return ws;
      return ws.map((w) => (w.id === id ? { ...w, x, y } : w));
    });
  }, [setWindows]);

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
    [setWindows],
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
    [setWindows],
  );

  /** Set (or clear, with null) the title a window's app publishes. */
  const setTitle = useCallback((id: string, title: string | null) => {
    setWindows((ws) =>
      ws.some((w) => w.id === id && w.title !== title)
        ? ws.map((w) => (w.id === id ? { ...w, title } : w))
        : ws,
    );
  }, [setWindows]);

  /** Set (or clear, with null) the icon a window's app publishes. */
  const setIcon = useCallback((id: string, icon: string | null) => {
    setWindows((ws) =>
      ws.some((w) => w.id === id && w.icon !== icon)
        ? ws.map((w) => (w.id === id ? { ...w, icon } : w))
        : ws,
    );
  }, [setWindows]);

  /** Set (or clear, with null) a window's sanitized title-bar accent. */
  const setAccent = useCallback((id: string, accent: string | null) => {
    setWindows((ws) =>
      ws.some((w) => w.id === id && w.accent !== accent)
        ? ws.map((w) => (w.id === id ? { ...w, accent } : w))
        : ws,
    );
  }, [setWindows]);

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
    [getAreas, setWindows],
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
    [setWindows],
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
    [getAreas, setWindows],
  );

  /**
   * Alt+Tab-style focus cycling through the non-minimized windows.
   * Forward raises the bottom-most window to the top, so repeated presses
   * visit every window in order; backward sends the top window to the back,
   * exactly undoing a forward step.
   */
  const cycleFocus = useCallback((backward = false) => {
    setWindows((ws) => {
      const visible = ws.filter(isShown).sort((a, b) => a.z - b.z);
      if (visible.length < 2) return ws;
      const rotated = backward
        ? [visible[visible.length - 1], ...visible.slice(0, -1)]
        : [...visible.slice(1), visible[0]];
      // Reassign 1..N in the new order. Colliding with a minimized window's
      // z is harmless: hidden windows don't take part in stacking or focus.
      const zOf = new Map(rotated.map((w, i) => [w.id, i + 1]));
      return ws.map((w) => (zOf.has(w.id) ? { ...w, z: zOf.get(w.id)! } : w));
    });
  }, [setWindows]);

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
  }, [getAreas, setWindows]);

  /**
   * Bring windows home after the monitors change: a maximized or tiled
   * window whose monitor went away fills the primary instead, and a window
   * whose title bar no longer lands on any monitor (it was on one that was
   * unplugged, or now sits in the dead area beside a smaller one) moves to
   * the primary, keeping its size. Restore spots are moved the same way.
   * Either way it joins the workspace the primary is showing, whichever
   * workspace it was on before. Tiled windows then re-tile there.
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
    update((s) => {
      let changed = false;
      let lost = 0;
      const workspace = activeWorkspace(s.active, primary.id);
      const next = s.windows.map((w) => {
        let out = w;
        if (w.monitor !== null && !ids.has(w.monitor)) out = { ...out, monitor: primary.id, workspace };
        const moved = rehome(w, lost);
        if (moved) out = { ...out, ...moved, workspace };
        const restoreMoved = w.restore ? rehome(w.restore, lost) : null;
        if (w.restore && restoreMoved) out = { ...out, restore: { ...w.restore, ...restoreMoved } };
        if (out !== w) {
          changed = true;
          if (moved || restoreMoved) lost++;
        }
        return out;
      });
      return changed ? { ...s, windows: next } : s;
    });
  }, [update]);

  /** The monitor keyboard commands act on. */
  const commandArea = useCallback((): WorkArea | null => {
    const areas = getAreas();
    if (areas.length === 0) return null;
    const current = areas.find((a) => a.id === currentMonitor.current);
    if (current) return current;
    const focused = focusedWindow(windowsRef.current);
    return (focused && homeArea(areas, focused)) || primaryArea(areas);
  }, [getAreas]);

  /**
   * Show workspace `n` on a monitor (by default, the one keyboard commands
   * act on), its top window taking focus.
   */
  const showWorkspaceOn = useCallback((n: number, areaId?: string) => {
    const id = areaId ?? commandArea()?.id;
    if (!id) return;
    currentMonitor.current = id;
    update((s) => showWorkspace(s, getAreas(), id, n, true));
  }, [commandArea, getAreas, update]);

  /**
   * Step through the workspaces with windows on the current monitor (and
   * the one it's showing), as Hyprland's `m+1` / `m-1`, wrapping around.
   */
  const stepWorkspace = useCallback((step: 1 | -1) => {
    const area = commandArea();
    if (!area) return;
    const areas = getAreas();
    const current = activeWorkspace(stateRef.current.active, area.id);
    const used = new Set([current]);
    for (const w of windowsRef.current) {
      if (!w.closing && homeArea(areas, w)?.id === area.id) used.add(w.workspace);
    }
    const list = [...used].sort((a, b) => a - b);
    const next = list[(list.indexOf(current) + step + list.length) % list.length];
    showWorkspaceOn(next, area.id);
  }, [commandArea, getAreas, showWorkspaceOn]);

  /** Back to the workspace the current monitor showed before (Super+Ctrl+Tab). */
  const previousWorkspace = useCallback(() => {
    const area = commandArea();
    const previous = area ? stateRef.current.previous[area.id] : undefined;
    if (area && previous !== undefined) showWorkspaceOn(previous, area.id);
  }, [commandArea, showWorkspaceOn]);

  /** Put a window on workspace `n` of its monitor, and with `follow`, go there too. */
  const moveToWorkspace = useCallback((id: string, n: number, follow: boolean) => {
    update((s) => {
      const target = s.windows.find((w) => w.id === id);
      if (!target || target.workspace === n) return s;
      const moved = { ...s, windows: s.windows.map((w) => (w.id === id ? { ...w, workspace: n } : w)) };
      const area = homeArea(getAreas(), target);
      if (!follow || !area) return moved;
      const shown = showWorkspace(moved, getAreas(), area.id, n, false);
      return { ...shown, windows: raise(shown.windows, id) };
    });
  }, [getAreas, update]);

  /** The work area beside `from` in direction `dir`, if there is one. */
  const neighborArea = useCallback((from: WorkArea, dir: Direction): WorkArea | null => {
    const others = getAreas()
      .filter((a) => a.id !== from.id)
      .map((a) => ({ item: a, rect: a.bounds }));
    return inDirection(from.bounds, dir, others);
  }, [getAreas]);

  /**
   * Focus the window on screen in direction `dir` from the focused one,
   * across monitors. With none that way, the monitor that way (if any)
   * becomes the current one, so Super+1 and new windows go there.
   */
  const focusDirection = useCallback((dir: Direction) => {
    const areas = getAreas();
    const ws = windowsRef.current;
    const focused = focusedWindow(ws);
    const area = commandArea();
    if (!area) return;
    const from = focused ? windowRect(focused, areas) : area;
    const candidates = ws
      .filter((w) => isShown(w) && w.id !== focused?.id)
      .map((w) => ({ item: w, rect: windowRect(w, areas) }));
    const next = inDirection(from, dir, candidates);
    if (next) {
      focus(next.id);
      return;
    }
    const neighbor = neighborArea(focused ? (homeArea(areas, focused) ?? area) : area, dir);
    if (neighbor) currentMonitor.current = neighbor.id;
  }, [commandArea, focus, getAreas, neighborArea]);

  /** Send a window to the monitor in direction `dir`, onto the workspace it shows. */
  const moveToMonitor = useCallback((id: string, dir: Direction) => {
    const areas = getAreas();
    const w = windowsRef.current.find((x) => x.id === id);
    const from = w ? homeArea(areas, w) : null;
    const to = from ? neighborArea(from, dir) : null;
    if (!from || !to) return;
    currentMonitor.current = to.id;
    setWindows((ws) => raise(ws.map((x) => (x.id === id ? carryTo(x, from, to) : x)), id));
  }, [getAreas, neighborArea, setWindows]);

  /**
   * Trade places between two tiled windows: their tiles, and if they're on
   * different monitors, their monitors and workspaces too.
   */
  const swapTiles = useCallback((a: string, b: string) => {
    update((s) => {
      const areas = getAreas();
      const wa = s.windows.find((w) => w.id === a);
      const wb = s.windows.find((w) => w.id === b);
      if (!wa || !wb || a === b) return s;
      const names = new Map([[a, b], [b, a]]);
      const trees: Record<string, TileNode> = {};
      for (const [key, tree] of Object.entries(s.trees)) trees[key] = renameLeaves(tree, names)!;
      const areaA = homeArea(areas, wa)!;
      const areaB = homeArea(areas, wb)!;
      const windows =
        areaA.id === areaB.id
          ? s.windows
          : s.windows.map((w) =>
              w.id === a
                ? { ...carryTo(w, areaA, areaB), workspace: wb.workspace }
                : w.id === b
                  ? { ...carryTo(w, areaB, areaA), workspace: wa.workspace }
                  : w,
            );
      return { ...s, trees, windows: raise(windows, a) };
    });
  }, [getAreas, update]);

  /**
   * Super+Shift+arrow: a tiled window swaps with the tiled window that way
   * (or, at the edge, moves to the monitor that way). A floating window
   * snaps instead, as Windows' Win+arrows do: left and right tile it to that
   * half (or bring it back from the other one), up maximizes, and down
   * restores, or minimizes a window that's already restored.
   */
  const swapDirection = useCallback((dir: Direction) => {
    const areas = getAreas();
    const ws = windowsRef.current;
    const focused = focusedWindow(ws);
    if (!focused) return;
    if (focused.tiled && !focused.maximized) {
      const candidates = ws
        .filter((w) => isShown(w) && w.id !== focused.id && w.tiled && !w.maximized)
        .map((w) => ({ item: w, rect: w.tiled! }));
      const other = inDirection(focused.tiled, dir, candidates);
      if (other) swapTiles(focused.id, other.id);
      else moveToMonitor(focused.id, dir);
      return;
    }
    const restore = () =>
      unmaximize(focused.id, focused.restore ?? { x: focused.x, y: focused.y, width: focused.width, height: focused.height });
    if (dir === 'left' || dir === 'right') {
      const other = dir === 'left' ? 'right' : 'left';
      if (focused.snapped === other) restore();
      else tile(focused.id, dir, undefined, homeArea(areas, focused)?.id);
    } else if (dir === 'up') {
      maximize(focused.id);
    } else if (focused.maximized || focused.snapped) {
      restore();
    } else {
      minimize(focused.id);
    }
  }, [getAreas, maximize, minimize, moveToMonitor, swapTiles, tile, unmaximize]);

  /**
   * End a drag of a tiled window: dropped on another tiled window, the two
   * trade places; dropped on another monitor, it tiles there.
   */
  const dropTile = useCallback((id: string, target: string | null, x: number, y: number) => {
    if (target) {
      swapTiles(id, target);
      return;
    }
    const areas = getAreas();
    const w = windowsRef.current.find((x) => x.id === id);
    const from = w ? homeArea(areas, w) : null;
    const to = areaAt(areas, x, y);
    if (!from || !to || from.id === to.id) return;
    currentMonitor.current = to.id;
    setWindows((ws) => ws.map((x) => (x.id === id ? carryTo(x, from, to) : x)));
  }, [getAreas, setWindows, swapTiles]);

  /** Float a tiled window, or tile a floating one (Super+T). */
  const toggleFloating = useCallback((id: string) => {
    setWindows((ws) => {
      const top = maxZ(ws);
      return ws.map((w) =>
        w.id === id
          ? { ...w, floating: w.tiled !== null, snapped: null, z: top + 1 }
          : w,
      );
    });
  }, [setWindows]);

  /** Flip the split a tiled window's tile came from (Super+J). */
  const toggleSplit = useCallback((id: string) => {
    update((s) => {
      for (const [key, tree] of Object.entries(s.trees)) {
        if (!treeLeaves(tree).includes(id)) continue;
        return { ...s, trees: { ...s.trees, [key]: toggleTreeSplit(tree, id)! } };
      }
      return s;
    });
  }, [update]);

  /**
   * Grow (or, negative, shrink) a window by `dx` / `dy` pixels: a tiled one
   * by moving the splits beside it, a floating one around its center.
   */
  const resizeBy = useCallback((id: string, dx: number, dy: number) => {
    const w = windowsRef.current.find((x) => x.id === id);
    if (!w || w.maximized || w.snapped || w.frameless) return;
    if (!w.tiled) {
      resize(id, {
        x: Math.round(w.x - dx / 2),
        y: Math.round(w.y - dy / 2),
        width: w.width + dx,
        height: w.height + dy,
      });
      return;
    }
    update((s) => {
      const areas = getAreas();
      const area = homeArea(areas, w);
      const key = area ? treeKey(area.id, w.workspace) : null;
      const tree = key ? s.trees[key] : undefined;
      if (!area || !key || !tree) return s;
      const { gap } = getTiling();
      const next = resizeLeaf(tree, id, dx, dy, tilingRect(area, gap), gap);
      return next === tree ? s : { ...s, trees: { ...s.trees, [key]: next! } };
    });
  }, [getAreas, getTiling, resize, update]);

  /** Lay the tiles out again, after the tiling settings changed. */
  const relayout = useCallback(() => {
    update((s) => ({ ...s }));
  }, [update]);

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
      setIcon,
      setAccent,
      fitToAreas,
      setCurrentMonitor,
      showWorkspace: showWorkspaceOn,
      stepWorkspace,
      previousWorkspace,
      moveToWorkspace,
      focusDirection,
      swapDirection,
      moveToMonitor,
      dropTile,
      toggleFloating,
      toggleSplit,
      resizeBy,
      relayout,
    }),
    [open, close, closeApp, destroy, minimize, focus, move, resize, maximize, unmaximize, tile, toggleMaximize, cycleFocus, setFrameless, setTitle, setIcon, setAccent, fitToAreas, setCurrentMonitor, showWorkspaceOn, stepWorkspace, previousWorkspace, moveToWorkspace, focusDirection, swapDirection, moveToMonitor, dropTile, toggleFloating, toggleSplit, resizeBy, relayout],
  );

  // Back-compat full manager: state + actions in one object. Its identity
  // changes on every window mutation, so only components that genuinely
  // need `windows` should consume it. `active` is the workspace each
  // monitor shows (see activeWorkspace).
  return useMemo(() => ({ windows, active, actions, ...actions }), [windows, active, actions]);
}

export type WindowManager = ReturnType<typeof useWindows>;

/** The stable action set of the window manager (no state). */
export type WindowActions = WindowManager['actions'];
