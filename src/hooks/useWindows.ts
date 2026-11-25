import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppDefinition } from '@/lib/apps';
import { endLaunching } from '@/lib/appLaunches';
import { closeIntercepted } from '@/lib/closeGuards';
import {
  areaAt,
  areaFor,
  EVEN_SPLIT,
  primaryArea,
  snapRect,
  zoneRow,
  zoneSide,
  type Rect,
  type SnapSplit,
  type SnapZone,
  type WorkArea,
} from '@/lib/monitors';
import { launchNativeApp } from '@/lib/nativeApps';
import { closeNativeWindow, isNativeWindowOpen } from '@/lib/nativeDisplay';
import { fullscreenMonitorIds } from '@/lib/pageFullscreen';
import {
  beginWorkspaceTransition,
  finishWorkspaceTransition,
  workspaceAnimates,
  type WorkspaceTransition,
  type WorkspaceTransitionSpec,
} from '@/lib/workspaceTransition';
import {
  insertLeaf,
  layoutTree,
  nearestLeaf,
  placeLeaf,
  removeLeaf,
  renameLeaves,
  resizeLeaf,
  tilingRect,
  toggleSplit as toggleTreeSplit,
  treeLeaves,
  type Point,
  type ResizeEdges,
  type TileNode,
} from '@/lib/tiling';
import { takeNativePlacement, type SavedWindow } from '@/lib/windowSession';
import type { Direction } from '@/lib/wmBindings';

/** The X window a Din window hosts, if it hosts a live one. */
function liveNativeWindow(w: WindowState | undefined): number | null {
  const xid = w?.params?.xid;
  return typeof xid === 'number' && isNativeWindowOpen(xid) ? xid : null;
}

/**
 * A window's params without the app that opened it last time: a relaunch
 * says who opens it now, if anyone, rather than keeping the last one's.
 */
function withoutOpener(params: WindowParams | undefined): WindowParams {
  const { opener: _opener, ...rest } = params ?? {};
  return rest;
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
   * The half or quarter of its monitor the window is snapped to, or null.
   * Like `maximized`, this is a layout derived from the monitor; the
   * window's own x/y/width/height keep their pre-tile values so `restore`
   * can return it there.
   */
  snapped: SnapZone | null;
  /**
   * Where the borders between snapped windows sit, shared by every window
   * snapped on its monitor's workspace (see snapGroup); null is even.
   */
  split: SnapSplit | null;
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
   * The workspace the window is on: 1–10 on its monitor, or the shared scratchpad.
   */
  workspace: number;
  /**
   * Whether the window stays out of the tiling layout while tiling is on
   * (Super+T, or an app that asks to float, like Calculator). Meaningless
   * while tiling is off, when every window floats.
   */
  floating: boolean;
  /**
   * Full screen: over its whole monitor, menu bar and Dock included
   * (`screen`, Super+F while windows tile), or still in its tile with its
   * app told it's full screen (`client`, Super+Ctrl+F, Hyprland's
   * fullscreenstate 0 2). Not saved with the session.
   */
  presentation?: 'screen' | 'client';
  /**
   * Whether a tiled window keeps its floating size, centered in its tile,
   * instead of filling it (Hyprland's pseudotile, Super+P).
   */
  pseudo: boolean;
  /**
   * Whether a tiled window takes its whole layout, gaps kept, over the
   * other tiles (Hyprland's maximized fullscreen, Super+Alt+F).
   */
  zoomed: boolean;
  /**
   * Whether the window shows on every workspace of its monitor, above the
   * others (Hyprland's pin; Super+O pops a window out, floating and pinned).
   */
  pinned: boolean;
  /**
   * Set while a tiled window is dragged: it's out of its tile, floating
   * under the pointer, and this is the floating geometry it gets back when
   * it's dropped into a tile again.
   */
  lifted: Rect | null;
  /**
   * The rect the tiling layout gives the window, in workspace coordinates,
   * or null when it isn't tiled. Derived by the manager on every commit;
   * x/y/width/height keep the floating geometry to return to.
   */
  tiled: Rect | null;
  /**
   * The window's tile in the layout, which `tiled` is unless the window is
   * pseudotiled (smaller, inside it) or zoomed (the whole layout). Derived
   * like `tiled`; tells which tiles are beside which.
   */
  slot: Rect | null;
  /**
   * Whether the window's workspace isn't the one its monitor is showing.
   * Derived like `tiled`. An away window is hidden the way a minimized one
   * is (mounted, so its app keeps its state) and doesn't count for focus.
   */
  away: boolean;
}

/**
 * Where a window is painted, in workspace coordinates: its monitor's work
 * area when maximized, its tile while tiled, its half or quarter of its
 * monitor's work area when snapped, else its own geometry.
 */
export function windowRect(w: WindowState, areas: WorkArea[]): Rect {
  if (w.presentation === 'screen') {
    const area = homeArea(areas, w);
    if (area) return area.bounds;
  }
  if (w.tiled && !w.maximized) return w.tiled;
  if (!w.maximized && !w.snapped) return { x: w.x, y: w.y, width: w.width, height: w.height };
  const area = areas.find((a) => a.id === w.monitor) ?? areaFor(areas, w);
  return snapRect(area, w.maximized ? 'max' : (w.snapped ?? 'left'), w.split ?? EVEN_SPLIT);
}

/**
 * The windows snapped on a monitor's workspace, which share their borders
 * (`split`).
 */
export function snapGroup(windows: WindowState[], areaId: string, workspace: number): WindowState[] {
  return windows.filter(
    (w) => w.snapped !== null && !w.maximized && !w.closing && w.monitor === areaId && w.workspace === workspace,
  );
}

/** Whether a window is on screen: not minimized, closing, or on another workspace. */
export function isShown(w: WindowState): boolean {
  return !w.minimized && !w.closing && !w.away;
}

/** Where windows that aren't tiles stack, inside the workspace: above every tile. */
const FLOATING_LAYER_Z = 250_000;
/** Where the scratchpad's backdrop sits: above the workspace's windows, below the scratchpad's. */
export const SCRATCHPAD_BACKDROP_Z = 500_000;

/**
 * The z-index a window paints at. `z` is the focus order; the layers keep
 * floating windows (and dialogs, and a window maximized or snapped while
 * tiling is on) above every tile, as Hyprland does, so focusing a tile, by
 * hovering it or otherwise, never buries one; and the scratchpad's above
 * them all. With tiling off nothing is a tile, so it's `z` alone.
 */
export function windowStackZ(w: WindowState): number {
  if (w.workspace === SCRATCHPAD) return w.z + SCRATCHPAD_BACKDROP_Z;
  const layer = w.presentation === 'screen' ? 2 : w.pinned ? 1 : 0;
  return w.z + (w.tiled && !w.maximized && !w.zoomed && layer === 0 ? 0 : FLOATING_LAYER_Z + layer * 10_000);
}

/** The focused window: the highest one on screen, or null. */
export function focusedWindow(windows: WindowState[]): WindowState | null {
  return windows.reduce<WindowState | null>((top, w) => (isShown(w) && (!top || w.z > top.z) ? w : top), null);
}

/**
 * The windows the Dock and taskbar have tiles and buttons for: every one,
 * or only those on the workspace their monitor is showing (AppConfig's
 * dockAllWorkspaces).
 */
export function dockWindows(windows: WindowState[], allWorkspaces: boolean): WindowState[] {
  return allWorkspaces ? windows : windows.filter((w) => !w.away);
}

/** How the tiling layout is set up (AppConfig's tiling settings). */
export interface TilingSettings {
  enabled: boolean;
  /** Pixels between tiles. */
  gap: number;
  /** Pixels between the tiles and the monitor's edges. */
  outerGap: number;
}

/** Whether a tiled window covers the other tiles of its layout: maximized, or zoomed. */
function fillsLayout(w: WindowState): boolean {
  return w.maximized || w.zoomed || w.presentation === 'screen';
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
  /** The monitor showing the scratchpad overlay, or null when hidden. */
  scratchpad: string | null;
}

/** The window manager's state, as the saved session sees it. */
export type WindowSession = WmState;

/** Workspaces per monitor, Super+1 to Super+0. */
export const WORKSPACE_COUNT = 10;
export const SCRATCHPAD = 0;

const treeKey = (areaId: string, workspace: number) => workspace === SCRATCHPAD ? 'scratchpad' : `${workspace}@${areaId}`;

function workspaceTileRect(area: WorkArea, outerGap: number, workspace: number): Rect {
  const rect = tilingRect(area, outerGap);
  if (workspace !== SCRATCHPAD) return rect;
  const x = Math.round(rect.width * 0.1);
  const y = Math.round(rect.height * 0.1);
  return { x: rect.x + x, y: rect.y + y, width: rect.width - 2 * x, height: rect.height - 2 * y };
}

/** The workspace a monitor is showing. */
export function activeWorkspace(active: Record<string, number>, areaId: string): number {
  return active[areaId] ?? 1;
}

/** How a monitor goes to another workspace. */
export interface ShowWorkspaceOptions {
  /** The side the new one comes from: 1 the right (the default for a higher number), -1 the left. */
  dir?: 1 | -1;
  /** Without the animation: something else has played it (a swipe). */
  instant?: boolean;
}

/** A monitor's workspaces to step through: the ones with windows, and the one showing. */
export interface WorkspaceSteps {
  areaId: string;
  current: number;
  /** In order; stepping wraps around. */
  list: number[];
}

/**
 * The work area a window lives on: the one it's maximized or edge-tiled
 * on, else the one under its floating geometry (which a tiled window keeps
 * on the monitor it's tiled on, a tile being dragged included).
 */
export function homeArea(areas: WorkArea[], w: WindowState): WorkArea | null {
  if (areas.length === 0) return null;
  if (w.monitor !== null) {
    const area = areas.find((a) => a.id === w.monitor);
    if (area) return area;
  }
  // A tile being dragged stays on its monitor's books until it's dropped.
  return areaFor(areas, w.lifted ?? w);
}

/** Din windows without a frame can have a fixed shape, like a player skin. */
function hasCustomShape(w: WindowState): boolean {
  return w.frameless && typeof w.params?.xid !== 'number';
}

/** Whether a window takes part in the tiling layout. */
function tileable(w: WindowState, tiling: TilingSettings): boolean {
  return (
    tiling.enabled &&
    !w.floating &&
    !w.pinned &&
    !w.lifted &&
    !hasCustomShape(w) &&
    !w.closing &&
    !w.minimized &&
    w.snapped === null
  );
}

/**
 * Where a tiled window paints in its tile: all of it, or pseudotiled, at
 * its floating size (no bigger than the tile) in the middle of it.
 */
function paintedTile(w: WindowState, slot: Rect): Rect {
  if (!w.pseudo) return slot;
  const width = Math.min(w.width, slot.width);
  const height = Math.min(w.height, slot.height);
  return {
    x: slot.x + Math.round((slot.width - width) / 2),
    y: slot.y + Math.round((slot.height - height) / 2),
    width,
    height,
  };
}

/** A maximized window back at its floating geometry (as toggleMaximize restores it). */
function restored(w: WindowState): WindowState {
  return { ...w, ...(w.restore ?? {}), maximized: false, snapped: null, monitor: null, restore: null };
}

/**
 * Give a tile the layout when it's focused under one that fills it: on
 * Hyprland (Omarchy's `on_focus_under_fullscreen = 1`) the window focused
 * takes the fullscreen over, rather than showing through it.
 */
function takeOverLayout(s: WmState, id: string, areas: WorkArea[], tiling: TilingSettings): WmState {
  const target = s.windows.find((w) => w.id === id);
  if (!target || !tileable(target, tiling) || fillsLayout(target)) return s;
  const area = homeArea(areas, target);
  if (!area) return s;
  const over = s.windows.find(
    (w) =>
      w.id !== id &&
      fillsLayout(w) &&
      tileable(w, tiling) &&
      w.workspace === target.workspace &&
      homeArea(areas, w)?.id === area.id,
  );
  if (!over) return s;
  return {
    ...s,
    windows: s.windows.map((w) => {
      if (w.id === over.id) return { ...(w.maximized ? restored(w) : w), zoomed: false, presentation: undefined };
      if (w.id !== id) return w;
      if (over.presentation === 'screen') return { ...w, presentation: 'screen' };
      if (!over.maximized) return { ...w, zoomed: true };
      return {
        ...w,
        maximized: true,
        monitor: area.id,
        restore: w.restore ?? { x: w.x, y: w.y, width: w.width, height: w.height },
      };
    }),
  };
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
    if (w.pinned) return w;
    if (w.workspace === SCRATCHPAD && (old.workspace !== SCRATCHPAD || !next.scratchpad || next.scratchpad === to.id)) return w;
    const workspace = activeWorkspace(next.active, to.id);
    return w.workspace === workspace ? w : { ...w, workspace };
  });

  // A pinned window is on whichever workspace its monitor shows.
  windows = windows.map((w) => {
    if (!w.pinned) return w;
    const workspace = activeWorkspace(next.active, homeArea(areas, w)!.id);
    return w.workspace === workspace ? w : { ...w, workspace };
  });

  // Who tiles where.
  const groups = new Map<string, { area: WorkArea; workspace: number; members: WindowState[] }>();
  const homes = new Map<string, WorkArea>();
  for (const w of windows) {
    const area = homeArea(areas, w)!;
    homes.set(w.id, area);
    if (!tileable(w, tiling)) continue;
    const key = treeKey(area.id, w.workspace);
    const group = groups.get(key);
    if (group) group.members.push(w);
    else groups.set(key, { area, workspace: w.workspace, members: [w] });
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
    for (const [key, { area, workspace, members }] of groups) {
      let t: TileNode | null = updated[key] ?? null;
      const present = new Set(treeLeaves(t));
      const added = members.filter((w) => !present.has(w.id)).sort((a, b) => a.z - b.z);
      if (added.length === 0) continue;
      const rect = workspaceTileRect(area, tiling.outerGap, workspace);
      for (const w of added) {
        // A new window splits the focused tile: the highest one already in.
        const target = members.reduce<WindowState | null>(
          (top, m) => (present.has(m.id) && (!top || m.z > top.z) ? m : top),
          null,
        );
        t = insertLeaf(t, w.id, rect, tiling.gap, { target: target?.id ?? null });
        present.add(w.id);
      }
      updated[key] = t!;
      changed = true;
    }
    if (changed) trees = updated;
  }

  const rects = new Map<string, Rect>();
  /** The whole layout each tile is part of, which a zoomed one takes. */
  const layouts = new Map<string, Rect>();
  if (tiling.enabled) {
    for (const [key, { area, workspace, members }] of groups) {
      const layout = workspaceTileRect(area, tiling.outerGap, workspace);
      layoutTree(trees[key] ?? null, layout, tiling.gap, rects);
      for (const w of members) layouts.set(w.id, layout);
    }
  }

  // Closing the focused tile gives focus to the tile that takes its place
  // (the one nearest its middle), as Hyprland does, unless something else
  // was focused in the same change.
  const was = focusedWindow(prev.windows);
  if (tiling.enabled && was?.slot && !was.maximized) {
    const now = windows.find((w) => w.id === was.id);
    const top = focusedWindow(windows);
    if ((!now || now.closing) && (!top || top.z < was.z)) {
      const area = homeArea(areas, was)!;
      const heir = nearestLeaf(
        trees[treeKey(area.id, was.workspace)] ?? null,
        { x: was.slot.x + was.slot.width / 2, y: was.slot.y + was.slot.height / 2 },
        workspaceTileRect(area, tiling.outerGap, was.workspace),
        tiling.gap,
      );
      if (heir) windows = raise(windows, heir);
    }
  }
  let windowsChanged = windows.length !== next.windows.length || windows.some((w, i) => w !== next.windows[i]);
  windows = windows.map((w) => {
    const areaId = homes.get(w.id)!.id;
    const away = w.pinned
      ? false
      : w.workspace === SCRATCHPAD
        ? next.scratchpad !== areaId
        : w.workspace !== activeWorkspace(next.active, areaId);
    // Neighbors can fill the vacated tile immediately, but the departing
    // window still needs its last tile rect for the close effect.
    const slot = w.closing ? w.slot : (rects.get(w.id) ?? null);
    const tiled = w.closing
      ? w.tiled
      : slot && (w.zoomed ? (layouts.get(w.id) ?? slot) : paintedTile(w, slot));
    if (away === w.away && sameRect(tiled, w.tiled) && sameRect(slot, w.slot)) return w;
    windowsChanged = true;
    return { ...w, away, tiled, slot };
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

/** Show the shared scratchpad here, carrying its windows and raising them in order. */
function revealScratchpad(s: WmState, areas: WorkArea[], area: WorkArea): WmState {
  const members = s.windows.filter((w) => w.workspace === SCRATCHPAD && !w.closing);
  if (members.length === 0) return { ...s, scratchpad: area.id };
  let windows = s.windows.map((w) => {
    if (w.workspace !== SCRATCHPAD) return w;
    const from = homeArea(areas, w);
    return from && from.id !== area.id ? carryTo(w, from, area) : w;
  });
  for (const w of members.sort((a, b) => a.z - b.z)) {
    if (!w.minimized) windows = raise(windows, w.id);
  }
  return { ...s, windows, scratchpad: area.id };
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

/**
 * A tile's box as the layout means it, for telling which tiles are beside
 * which: half the gap out on every side, so neighbors' boxes meet, and all
 * the way out to the monitor's edge where the tile is at the layout's (so
 * tiles on monitors side by side meet too, across any bar between them).
 */
function tileBox(tile: Rect, area: WorkArea, gap: number, outerGap: number): Rect {
  const inner = tilingRect(area, outerGap);
  const { bounds } = area;
  const left = tile.x <= inner.x ? bounds.x : tile.x - gap / 2;
  const top = tile.y <= inner.y ? bounds.y : tile.y - gap / 2;
  const right = tile.x + tile.width >= inner.x + inner.width ? bounds.x + bounds.width : tile.x + tile.width + gap / 2;
  const bottom = tile.y + tile.height >= inner.y + inner.height ? bounds.y + bounds.height : tile.y + tile.height + gap / 2;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Whether span a starts where span b ends, give or take: touching, or
 * overlapping by no more than half the smaller (Hyprland's isAdjacent).
 */
function startsAtEndOf(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  const delta = aMin - bMax;
  if (Math.abs(delta) < 2) return true;
  if (delta >= 0) return false;
  if ((bMin <= aMin && bMax >= aMax) || (aMin <= bMin && aMax >= bMax)) return false;
  return -delta <= Math.min(aMax - aMin, bMax - bMin) * 0.5;
}

/**
 * The tile beside `from` in direction `dir`, as Hyprland's movefocus and
 * swapwindow pick it: of the tiles sharing that edge with it, the one
 * focused most recently (`z`), not the nearest by center - so going right
 * and back left returns to the window just left.
 */
export function tileInDirection<T extends { z: number }>(
  from: Rect,
  dir: Direction,
  candidates: { item: T; rect: Rect }[],
): T | null {
  let best: T | null = null;
  for (const { item, rect } of candidates) {
    const beside =
      dir === 'left'
        ? startsAtEndOf(from.x, from.x + from.width, rect.x, rect.x + rect.width)
        : dir === 'right'
          ? startsAtEndOf(rect.x, rect.x + rect.width, from.x, from.x + from.width)
          : dir === 'up'
            ? startsAtEndOf(from.y, from.y + from.height, rect.y, rect.y + rect.height)
            : startsAtEndOf(rect.y, rect.y + rect.height, from.y, from.y + from.height);
    if (!beside) continue;
    const shared =
      dir === 'left' || dir === 'right'
        ? Math.min(from.y + from.height, rect.y + rect.height) - Math.max(from.y, rect.y)
        : Math.min(from.x + from.width, rect.x + rect.width) - Math.max(from.x, rect.x);
    if (shared <= 1) continue;
    if (!best || item.z > best.z) best = item;
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

/** How big a popped-out window is (Omarchy's), where its monitor has the room. */
const POP_WIDTH = 1300;
const POP_HEIGHT = 900;

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
      w.workspace === n && !w.pinned && !w.minimized && !w.closing && homeArea(areas, w)?.id === areaId && (!t || w.z > t.z)
        ? w
        : t,
    null,
  );
  return top ? { ...next, windows: raise(next.windows, top.id) } : next;
}

/**
 * Bring windows home to the monitors there are: a maximized or tiled
 * window whose monitor went away fills the primary instead, and a window
 * whose title bar no longer lands on any monitor (it was on one that was
 * unplugged, or now sits in the dead area beside a smaller one) moves to
 * the primary, keeping its size. Restore spots are moved the same way.
 * Either way it joins the workspace the primary is showing, whichever
 * workspace it was on before.
 */
function fitWindows(s: WmState, areas: WorkArea[]): WmState {
  if (areas.length === 0) return s;
  const primary = primaryArea(areas);
  const ids = new Set(areas.map((a) => a.id));
  /** A rect moved onto the primary if its title bar is lost, else null. */
  const rehome = (r: { x: number; y: number; width: number }, i: number) =>
    [40, r.width / 2, r.width - 40].some((dx) => areaAt(areas, r.x + dx, r.y + 18))
      ? null
      : { x: primary.x + 80 + i * CASCADE_PX, y: primary.y + 60 + i * CASCADE_PX };
  let changed = false;
  let lost = 0;
  const next = s.windows.map((w) => {
    let out = w;
    const workspace = w.workspace === SCRATCHPAD ? SCRATCHPAD : activeWorkspace(s.active, primary.id);
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
  const scratchpad = s.scratchpad && ids.has(s.scratchpad) ? s.scratchpad : null;
  return changed || scratchpad !== s.scratchpad ? { ...s, windows: next, scratchpad } : s;
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
 * @param getPointer Where the pointer is, in workspace coordinates, if
 *   known (stable, like getAreas): a floating window tiled again goes
 *   beside the tile nearest it.
 */
export function useWindows(
  getApp: (id: string) => AppDefinition | undefined,
  getAreas: () => WorkArea[],
  getLaunchMonitor: () => string | null,
  getTiling: () => TilingSettings,
  getPointer: () => Point | null = () => null,
  jumpPointer?: (point: Point) => void,
) {
  const [state, setState] = useState<WmState>({ windows: [], trees: {}, active: {}, previous: {}, scratchpad: null });
  const { windows, active, scratchpad } = state;

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
  const pointerTarget = useRef<string | null>(null);
  // Repeated switches before React commits count from the intended workspace.
  const shownSince = useRef<Record<string, number>>({});
  const shownWorkspace = useCallback(
    (areaId: string) => shownSince.current[areaId] ?? activeWorkspace(stateRef.current.active, areaId),
    [],
  );
  useLayoutEffect(() => {
    const previous = windowsRef.current;
    windowsRef.current = windows;
    stateRef.current = state;
    shownSince.current = {};

    // Only after focus moved from the keyboard (focusAndJump), and only
    // while windows tile: a click or a close leaves the pointer where it is.
    const id = pointerTarget.current;
    pointerTarget.current = null;
    if (!id || !jumpPointer || previous === windows || !getTiling().enabled) return;
    const target = focusedWindow(windows);
    if (target?.id !== id) return;

    // The middle of what's on screen of it, once the layout has settled.
    const areas = getAreas();
    const rect = windowRect(target, areas);
    const area = homeArea(areas, target)?.bounds;
    if (!area) return;
    const left = Math.max(rect.x, area.x);
    const top = Math.max(rect.y, area.y);
    const right = Math.min(rect.x + rect.width, area.x + area.width);
    const bottom = Math.min(rect.y + rect.height, area.y + area.height);
    if (right > left && bottom > top) jumpPointer({ x: (left + right) / 2, y: (top + bottom) / 2 });
  }, [windows, state, getAreas, getTiling, jumpPointer]);

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
      if (!target || target.closing) return s;
      const areas = getAreas();
      const area = homeArea(areas, target);
      const shown = !area || target.pinned
        ? s
        : target.workspace === SCRATCHPAD
          ? (s.scratchpad === area.id ? s : revealScratchpad(s, areas, area))
          : showWorkspace(s.scratchpad === area.id ? { ...s, scratchpad: null } : s, areas, area.id, target.workspace, false);
      const ws = raise(shown.windows, id);
      return takeOverLayout(ws === shown.windows ? shown : { ...shown, windows: ws }, id, areas, getTiling());
    });
  }, [update, getAreas, getTiling]);

  const focusAndJump = useCallback((id: string) => {
    pointerTarget.current = id;
    focus(id);
  }, [focus]);

  /**
   * Launch an app again in one of its windows: focus it, merging in the new
   * params, which a Din app hears in `launchQueue`. What `open` does for a
   * single-instance app, and the desktop for any app when it knows the
   * window (a notification's).
   */
  const launchIn = useCallback((id: string, params?: WindowParams, replace = false) => {
    if (params) {
      setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, params: replace ? params : { ...withoutOpener(w.params), ...params } } : w)));
    }
    focus(id);
  }, [setWindows, focus]);

  /**
   * `replaceParams`: a single-instance app's window takes these params in
   * place of its last launch's rather than merged into them (a share, whose
   * launch must not inherit another's conversation or files).
   */
  const open = useCallback((requestedId: string, requestedParams?: WindowParams, options?: { newWindow?: boolean; replaceParams?: boolean }) => {
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
      launchNativeApp(app);
      return undefined;
    }

    // Single-instance apps (e.g. Settings) reuse their existing window: focus
    // and un-minimize it, merging in any new launch params, rather than
    // spawning a duplicate. `newWindow` is the app opening another window of
    // its own (a form, its settings), which always opens.
    if (app.singleInstance && !options?.newWindow) {
      // Read through the ref, not `windows`: depending on the array would
      // re-create open() - and with it every action consumers hold - on
      // each focus, move and resize.
      // Its main window, not one it opened for a form (a `window` param).
      const mine = windowsRef.current.filter((w) => w.appId === appId && !w.closing);
      const existing = mine.find((w) => w.params?.window === undefined) ?? mine[0];
      if (existing) {
        launchIn(existing.id, params, options?.replaceParams === true);
        return existing.id;
      }
    }

    // An app with a window per something (App Info, a window per app)
    // brings back the one already showing it.
    const key = app.instanceParam;
    if (key && params?.[key] !== undefined && !options?.newWindow) {
      const existing = windowsRef.current.find((w) => w.appId === appId && !w.closing && w.params?.[key] === params[key]);
      if (existing) {
        launchIn(existing.id, params, options?.replaceParams === true);
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
    // A native app started again by the saved session maps its windows
    // where they were.
    const placed = typeof params?.xid === 'number' ? takeNativePlacement(appId) : null;
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
      const covered = fullscreenMonitorIds();
      const area =
        picked && covered.includes(picked.id)
          ? (areas.find((a) => a.primary && !covered.includes(a.id)) ??
            areas.find((a) => !covered.includes(a.id)) ??
            picked)
          : picked;
      const workspace = !area ? 1 : s.scratchpad === area.id ? SCRATCHPAD : activeWorkspace(s.active, area.id);
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
          split: null,
          monitor: null,
          restore: null,
          frameless,
          title: null,
          icon: null,
          accent: null,
          workspace,
          floating,
          pseudo: false,
          zoomed: false,
          pinned: false,
          lifted: null,
          tiled: null,
          slot: null,
          away: false,
          ...(placed && {
            x: placed.x,
            y: placed.y,
            ...(placed.frameless === frameless ? clampSize(placed.width, placed.height, frameless) : {}),
            minimized: placed.minimized,
            maximized: placed.maximized,
            snapped: placed.snapped,
            split: placed.split ?? null,
            monitor: placed.monitor,
            restore: placed.restore,
            workspace: Math.min(placed.workspace, WORKSPACE_COUNT),
            floating: placed.floating,
            pinned: placed.pinned ?? false,
            pseudo: placed.pseudo ?? false,
            zoomed: placed.zoomed ?? false,
          }),
        },
      ];
      // Opened over a tile that fills its layout, a new tile takes that over.
      return placed ? fitWindows({ ...s, windows }, areas) : takeOverLayout({ ...s, windows }, id, areas, getTiling());
    });
    return id;
  }, [getApp, getAreas, getLaunchMonitor, getTiling, update, launchIn]);

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
    // Its windows, and those that belong to it (its file pickers).
    const ofApp = (w: WindowState) => w.appId === appId || w.params?.dockAs === appId;
    const kept = new Set<string>();
    for (const w of windowsRef.current) {
      if (!ofApp(w)) continue;
      const xid = liveNativeWindow(w);
      if (xid !== null) closeNativeWindow(xid);
      else if (!w.closing && closeIntercepted(w.id)) kept.add(w.id);
    }
    const closes = (w: WindowState) =>
      ofApp(w) && !kept.has(w.id) && liveNativeWindow(w) === null;
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
   * Snap a window to a half or quarter of a monitor (no-op if already
   * snapped there). `restore` overrides the geometry remembered for
   * un-tiling - the drag-to-edge snap passes the window's pre-drag spot so
   * a later restore returns it there. Like `maximize`, the tile is derived
   * from the monitor, so the window's x/y/width/height are left untouched.
   * `monitor` defaults to the one the window is on. The window takes the
   * borders of the windows already snapped there, or even ones.
   */
  const tile = useCallback(
    (
      id: string,
      zone: SnapZone,
      restore?: { x: number; y: number; width: number; height: number },
      monitor?: string,
    ) => {
      update((s) => {
        const w = s.windows.find((x) => x.id === id);
        if (!w) return s;
        const areas = getAreas();
        const target = monitor ?? w.monitor ?? areaOf(areas, w)?.id ?? null;
        if (w.snapped === zone && w.monitor === target && !w.maximized) return s;
        const workspace =
          target !== null && target !== homeArea(areas, w)?.id ? activeWorkspace(s.active, target) : w.workspace;
        const split = target !== null ? (snapGroup(s.windows, target, workspace).find((x) => x.id !== id)?.split ?? null) : null;
        const top = maxZ(s.windows);
        return {
          ...s,
          windows: s.windows.map((x) =>
            x.id === id
              ? {
                  ...x,
                  snapped: zone,
                  split,
                  maximized: false,
                  monitor: target,
                  restore: restore ?? x.restore ?? { x: x.x, y: x.y, width: x.width, height: x.height },
                  z: top + 1,
                }
              : x,
          ),
        };
      });
    },
    [getAreas, update],
  );

  /**
   * Move the borders between the windows snapped beside `id` (dragging the
   * edge one shares with another): every window snapped on its monitor's
   * workspace takes the new split.
   */
  const setSnapSplit = useCallback((id: string, split: SnapSplit) => {
    setWindows((ws) => {
      const w = ws.find((x) => x.id === id);
      if (!w?.snapped || w.monitor === null) return ws;
      const group = new Set(snapGroup(ws, w.monitor, w.workspace).map((x) => x.id));
      return ws.map((x) => (group.has(x.id) ? { ...x, split } : x));
    });
  }, [setWindows]);

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

  /** Bring windows home after the monitors change (fitWindows); tiled ones then re-tile. */
  const fitToAreas = useCallback((areas: WorkArea[]) => {
    update((s) => fitWindows(s, areas));
  }, [update]);

  /**
   * Put back windows from the saved session (src/lib/windowSession.ts):
   * each where it was, with its tiling trees and the workspace each monitor
   * showed, above any window already open. Windows of monitors no longer
   * there come home as fitToAreas brings them. Returns each saved window's
   * new id, by its old one.
   */
  const adoptSession = useCallback(
    (saved: SavedWindow[], trees: Record<string, TileNode>, active: Record<string, number>): Map<string, string> => {
      const ids = new Map(saved.map((s) => [s.id, nextWindowId()]));
      update((s) => {
        const areas = getAreas();
        const known = new Set(areas.map((a) => a.id));
        const top = maxZ(s.windows);
        const adopted = saved.map((w): WindowState => ({
          id: ids.get(w.id)!,
          appId: w.appId,
          params: w.params,
          ...clampSize(w.width, w.height, w.frameless),
          x: w.x,
          y: w.y,
          z: top + w.z,
          minimized: w.minimized,
          closing: false,
          maximized: w.maximized,
          snapped: w.snapped,
          split: w.split ?? null,
          monitor: w.monitor,
          restore: w.restore,
          frameless: w.frameless,
          title: null,
          icon: null,
          accent: null,
          workspace: Math.min(w.workspace, WORKSPACE_COUNT),
          floating: w.floating,
          pseudo: w.pseudo ?? false,
          zoomed: w.zoomed ?? false,
          pinned: w.pinned ?? false,
          lifted: null,
          tiled: null,
          slot: null,
          away: false,
        }));
        // Leaves of windows not coming back get names no window has, for
        // settle() to prune.
        const nextTrees = { ...s.trees };
        for (const [key, tree] of Object.entries(trees)) {
          if (nextTrees[key]) continue;
          const names = new Map(treeLeaves(tree).map((leaf) => [leaf, ids.get(leaf) ?? `gone:${leaf}`]));
          nextTrees[key] = renameLeaves(tree, names)!;
        }
        const nextActive = { ...s.active };
        for (const [areaId, n] of Object.entries(active)) {
          if (known.has(areaId) && nextActive[areaId] === undefined) nextActive[areaId] = Math.min(n, WORKSPACE_COUNT);
        }
        return fitWindows({ ...s, windows: [...s.windows, ...adopted], trees: nextTrees, active: nextActive }, areas);
      });
      return ids;
    },
    [getAreas, update],
  );

  /** The whole state, for the saved session. */
  const getSession = useCallback((): WindowSession => stateRef.current, []);

  /** The monitor keyboard commands act on. */
  const commandArea = useCallback((): WorkArea | null => {
    const areas = getAreas();
    if (areas.length === 0) return null;
    const current = areas.find((a) => a.id === currentMonitor.current);
    if (current) return current;
    const focused = focusedWindow(windowsRef.current);
    return (focused && homeArea(areas, focused)) || primaryArea(areas);
  }, [getAreas]);

  /** What moves when monitor `areaId` goes from workspace `from` to `to`. */
  const workspaceTransitionSpec = useCallback(
    (areaId: string, from: number, to: number | null, dir: 1 | -1): WorkspaceTransitionSpec | null => {
      const areas = getAreas();
      const area = areas.find((a) => a.id === areaId);
      if (!area) return null;
      return {
        areaId,
        from,
        to,
        dir,
        bounds: area.bounds,
        clip: areas.length > 1,
        windows: windowsRef.current
          .filter((w) => !w.minimized && !w.pinned &&
            (w.workspace === from || w.workspace === to) && homeArea(areas, w)?.id === areaId)
          .map((w) => ({ id: w.id, workspace: w.workspace, rect: windowRect(w, areas) })),
      };
    },
    [getAreas],
  );

  /**
   * Show workspace `n` on a monitor (by default, the one keyboard commands
   * act on), its top window taking focus. It's shown at once, so the next
   * command (closing a window, listing them) acts on it; Settings → Windows'
   * animation then plays over it (src/lib/workspaceTransition.ts), the two
   * workspaces' windows showing until it's done.
   */
  const showWorkspaceOn = useCallback((n: number, areaId?: string, options?: ShowWorkspaceOptions) => {
    const id = areaId ?? commandArea()?.id;
    if (!id) return;
    currentMonitor.current = id;
    let spec: WorkspaceTransitionSpec | null = null;
    if (!options?.instant && workspaceAnimates()) {
      // One still playing ends where it was going, and this starts from there.
      finishWorkspaceTransition();
      const current = shownWorkspace(id);
      if (current !== n) spec = workspaceTransitionSpec(id, current, n, options?.dir ?? (n > current ? 1 : -1));
    }
    shownSince.current[id] = n;
    update((s) => showWorkspace(s.scratchpad === id ? { ...s, scratchpad: null } : s, getAreas(), id, n, true));
    if (spec) beginWorkspaceTransition(spec).land(1);
  }, [commandArea, getAreas, update, workspaceTransitionSpec, shownWorkspace]);

  /** The workspaces the current monitor steps through. */
  const workspaceSteps = useCallback((): WorkspaceSteps | null => {
    const area = commandArea();
    if (!area) return null;
    const areas = getAreas();
    const current = shownWorkspace(area.id);
    const used = new Set([current]);
    for (const w of windowsRef.current) {
      if (!w.closing && w.workspace !== SCRATCHPAD && homeArea(areas, w)?.id === area.id) used.add(w.workspace);
    }
    return { areaId: area.id, current, list: [...used].sort((a, b) => a - b) };
  }, [commandArea, getAreas, shownWorkspace]);

  const toggleScratchpad = useCallback((areaId?: string) => {
    const areas = getAreas();
    const area = areaId ? areas.find((a) => a.id === areaId) : commandArea();
    if (!area) return;
    currentMonitor.current = area.id;
    update((s) => s.scratchpad === area.id ? { ...s, scratchpad: null } : revealScratchpad(s, areas, area));
  }, [commandArea, getAreas, update]);

  const moveToScratchpad = useCallback((id: string) => {
    update((s) => {
      const target = s.windows.find((w) => w.id === id);
      if (!target || target.closing || target.workspace === SCRATCHPAD) return s;
      const areas = getAreas();
      const from = homeArea(areas, target);
      const member = s.windows.find((w) => w.workspace === SCRATCHPAD && !w.closing);
      const to = areas.find((a) => a.id === s.scratchpad) ?? (member ? homeArea(areas, member) : from);
      const moved = from && to && from.id !== to.id ? carryTo(target, from, to) : target;
      const split = moved.snapped && moved.monitor !== null
        ? (snapGroup(s.windows, moved.monitor, SCRATCHPAD)[0]?.split ?? null)
        : moved.split;
      return { ...s, windows: s.windows.map((w) => w === target ? { ...moved, workspace: SCRATCHPAD, split } : w) };
    });
  }, [getAreas, update]);

  /**
   * Step through the workspaces with windows on the current monitor (and
   * the one it's showing), as Hyprland's `m+1` / `m-1`, wrapping around.
   */
  const stepWorkspace = useCallback((step: 1 | -1) => {
    // Counted from where an animation still playing is going.
    finishWorkspaceTransition();
    const steps = workspaceSteps();
    if (!steps) return;
    const { list, current, areaId } = steps;
    const next = list[(list.indexOf(current) + step + list.length) % list.length];
    showWorkspaceOn(next, areaId, { dir: step });
  }, [workspaceSteps, showWorkspaceOn]);

  /**
   * Start the animation from the workspace a monitor shows to workspace
   * `to` (null: there's none that way), for a swipe to move by hand; the
   * swipe shows the workspace itself once it's there (showWorkspace with
   * `instant`). Null without a desktop to animate.
   */
  const beginWorkspaceSwipe = useCallback(
    (areaId: string, to: number | null, dir: 1 | -1): WorkspaceTransition | null => {
      finishWorkspaceTransition();
      const spec = workspaceTransitionSpec(areaId, shownWorkspace(areaId), to, dir);
      return spec && beginWorkspaceTransition(spec);
    },
    [workspaceTransitionSpec, shownWorkspace],
  );

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
      // A snapped window takes the borders of those snapped over there.
      const split =
        target.snapped && target.monitor !== null
          ? (snapGroup(s.windows, target.monitor, n)[0]?.split ?? null)
          : target.split;
      const moved = { ...s, windows: s.windows.map((w) => (w.id === id ? { ...w, workspace: n, split } : w)) };
      const area = homeArea(getAreas(), target);
      if (!follow || !area) return moved;
      const shown = showWorkspace(moved.scratchpad === area.id ? { ...moved, scratchpad: null } : moved, getAreas(), area.id, n, false);
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

  /** The tile on screen beside a tiled window in direction `dir`, if any. */
  const tileBeside = useCallback((from: WindowState, dir: Direction): WindowState | null => {
    if (!from.slot || fillsLayout(from)) return null;
    const areas = getAreas();
    const { gap, outerGap } = getTiling();
    const box = (w: WindowState) => tileBox(w.slot!, homeArea(areas, w)!, gap, outerGap);
    const candidates = windowsRef.current
      .filter((w) => isShown(w) && w.id !== from.id && w.slot && !fillsLayout(w) &&
        (homeArea(areas, w)?.id !== homeArea(areas, from)?.id || w.workspace === from.workspace))
      .map((w) => ({ item: w, rect: box(w) }));
    return tileInDirection(box(from), dir, candidates);
  }, [getAreas, getTiling]);

  /** Make a monitor the one keyboard commands act on, its top window taking focus. */
  const focusArea = useCallback((area: WorkArea, select = focus) => {
    currentMonitor.current = area.id;
    const areas = getAreas();
    const top = windowsRef.current.reduce<WindowState | null>(
      (t, w) => (isShown(w) && homeArea(areas, w)?.id === area.id && (!t || w.z > t.z) ? w : t),
      null,
    );
    if (top) select(top.id);
  }, [focus, getAreas]);

  /**
   * Focus the window on screen in direction `dir` from the focused one, as
   * Hyprland's `movefocus`: from a tile, the tile beside it, else whatever
   * window lies that way; with none, the monitor that way; with no monitor
   * either, round to the window at the monitor's far edge. A tile that
   * fills its layout (maximized, zoomed) has only other monitors to go to.
   * With tiling off, the monitor that way only becomes the current one,
   * and nothing goes round.
   */
  const focusDirection = useCallback((dir: Direction) => {
    const areas = getAreas();
    const ws = windowsRef.current;
    const focused = focusedWindow(ws);
    const area = commandArea();
    if (!area) return;
    const others = ws.filter((w) => isShown(w) && w.id !== focused?.id &&
      (stateRef.current.scratchpad !== homeArea(areas, w)?.id || w.workspace === SCRATCHPAD));
    const isTile = !!focused?.slot;
    const blocked = focused?.presentation === 'screen' || (!!focused && isTile && fillsLayout(focused));
    const next = blocked
      ? null
      : ((focused ? tileBeside(focused, dir) : null) ??
        inDirection(
          focused ? windowRect(focused, areas) : area,
          dir,
          others
            .filter((w) => !(isTile && w.slot && !fillsLayout(w)))
            .map((w) => ({ item: w, rect: windowRect(w, areas) })),
        ));
    if (next) {
      focusAndJump(next.id);
      return;
    }
    const home = focused ? (homeArea(areas, focused) ?? area) : area;
    const neighbor = neighborArea(home, dir);
    const tiling = getTiling();
    // Floating, as it always has, the monitor that way only becomes the
    // current one (Super+1 and new windows go there).
    if (neighbor && !tiling.enabled) currentMonitor.current = neighbor.id;
    if (neighbor && tiling.enabled) {
      focusArea(neighbor, focusAndJump);
      return;
    }
    if (!focused || blocked || !tiling.enabled) return;
    // Nothing that way: round to the other side of the monitor, unless the
    // window already spans it.
    const horizontal = dir === 'left' || dir === 'right';
    const { gap, outerGap } = tiling;
    const b = home.bounds;
    const mine = focused.slot ? tileBox(focused.slot, home, gap, outerGap) : windowRect(focused, areas);
    if (horizontal ? mine.x <= b.x + 1 && mine.width >= b.width - 1 : mine.y <= b.y + 1 && mine.height >= b.height - 1) return;
    const edge: Rect =
      dir === 'left'
        ? { x: b.x + b.width, y: b.y, width: 1, height: b.height }
        : dir === 'right'
          ? { x: b.x - 1, y: b.y, width: 1, height: b.height }
          : dir === 'up'
            ? { x: b.x, y: b.y + b.height, width: b.width, height: 1 }
            : { x: b.x, y: b.y - 1, width: b.width, height: 1 };
    const here = others.filter((w) => homeArea(areas, w)?.id === home.id);
    const round = focused.slot
      ? tileInDirection(
          edge,
          dir,
          here
            .filter((w) => w.slot && !fillsLayout(w))
            .map((w) => ({ item: w, rect: tileBox(w.slot!, home, gap, outerGap) })),
        )
      : inDirection(
          edge,
          dir,
          here.filter((w) => !w.slot).map((w) => ({ item: w, rect: windowRect(w, areas) })),
        );
    if (round) focusAndJump(round.id);
  }, [commandArea, focusAndJump, focusArea, getAreas, getTiling, neighborArea, tileBeside]);

  /** Focus the next monitor (or, with -1, the one before), as Hyprland's `focusmonitor +1`. */
  const focusMonitor = useCallback((step: 1 | -1) => {
    const areas = getAreas();
    const current = commandArea();
    if (!current || areas.length < 2) return;
    const i = areas.findIndex((a) => a.id === current.id);
    focusArea(areas[(i + step + areas.length) % areas.length], focusAndJump);
  }, [commandArea, focusAndJump, focusArea, getAreas]);

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
      if ((wa.workspace === SCRATCHPAD) !== (wb.workspace === SCRATCHPAD)) return s;
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
   * Super+Shift+arrow: a tiled window swaps with the tile beside it that
   * way, and with none stays put, as Hyprland's `swapwindow` (Super+Shift+
   * Ctrl+arrow moves it to another monitor). A floating window snaps
   * instead, as Windows' Win+arrows do: left and right tile it to that half
   * (a quarter crosses to the one beside it; a half on the other side comes
   * back), up and down take a half to its top or bottom quarter and a
   * quarter back to its half, and otherwise up maximizes and down restores,
   * or minimizes a window that's already restored.
   */
  const swapDirection = useCallback((dir: Direction) => {
    const areas = getAreas();
    const focused = focusedWindow(windowsRef.current);
    if (!focused) return;
    if (focused.tiled && !focused.maximized) {
      const other = tileBeside(focused, dir);
      if (other) swapTiles(focused.id, other.id);
      return;
    }
    const restore = () =>
      unmaximize(focused.id, focused.restore ?? { x: focused.x, y: focused.y, width: focused.width, height: focused.height });
    const snapTo = (zone: SnapZone) => tile(focused.id, zone, undefined, homeArea(areas, focused)?.id);
    const zone = focused.maximized ? null : focused.snapped;
    const row = zone && zoneRow(zone);
    if (dir === 'left' || dir === 'right') {
      if (zone === (dir === 'left' ? 'right' : 'left')) restore();
      else if (zone && row && zoneSide(zone) !== dir) snapTo(`${row}-${dir}`);
      else snapTo(dir);
    } else if (zone === 'left' || zone === 'right') {
      snapTo(`${dir === 'up' ? 'top' : 'bottom'}-${zone}`);
    } else if (zone && row !== (dir === 'up' ? 'top' : 'bottom')) {
      snapTo(zoneSide(zone));
    } else if (dir === 'up') {
      maximize(focused.id);
    } else if (focused.maximized || focused.snapped) {
      restore();
    } else {
      minimize(focused.id);
    }
  }, [getAreas, maximize, minimize, swapTiles, tile, tileBeside, unmaximize]);

  /**
   * Take a tiled window out of its tile to be dragged, as Hyprland does: it
   * floats at `rect` (under the pointer) while the other tiles close up,
   * until dropTile puts it down.
   */
  const liftTile = useCallback((id: string, rect: Rect) => {
    setWindows((ws) => {
      const top = maxZ(ws);
      return ws.map((w) => {
        if (w.id !== id || !w.tiled || w.lifted) return w;
        // Maximized, it comes out of that first.
        const base = w.maximized ? restored(w) : w;
        return {
          ...base,
          lifted: { x: base.x, y: base.y, width: base.width, height: base.height },
          ...rect,
          zoomed: false,
          z: top + 1,
        };
      });
    });
  }, [setWindows]);

  /**
   * Where a tile being dragged, dropped at a point (workspace coordinates),
   * would land: on that monitor's workspace, beside the tile nearest the
   * point, in the half of it the point is in (see placeLeaf).
   */
  const planTileDrop = useCallback((s: WmState, id: string, x: number, y: number) => {
    const areas = getAreas();
    const tiling = getTiling();
    const w = s.windows.find((c) => c.id === id);
    const from = w ? homeArea(areas, w) : null;
    const to = areaAt(areas, x, y) ?? from;
    if (!w || !from || !to || !tiling.enabled) return null;
    const workspace = to.id === from.id ? w.workspace : activeWorkspace(s.active, to.id);
    const key = treeKey(to.id, workspace);
    const rect = workspaceTileRect(to, tiling.outerGap, workspace);
    const tree = placeLeaf(s.trees[key] ?? null, id, { x, y }, rect, tiling.gap);
    const slot = layoutTree(tree, rect, tiling.gap).get(id);
    return { key, tree, from, to, workspace, rect: slot ? paintedTile({ ...w, ...(w.lifted ?? {}) }, slot) : null };
  }, [getAreas, getTiling]);

  /** The rect a tile being dragged would take, dropped at a point, for the drag's outline. */
  const tileDropRect = useCallback(
    (id: string, x: number, y: number): Rect | null => planTileDrop(stateRef.current, id, x, y)?.rect ?? null,
    [planTileDrop],
  );

  /**
   * End a drag of a tile (see liftTile), dropped at a point: it splits the
   * tile nearest the pointer, taking the half the pointer is in; on another
   * monitor, it tiles there the same way.
   */
  const dropTile = useCallback((id: string, x: number, y: number) => {
    update((s) => {
      const w = s.windows.find((c) => c.id === id);
      if (!w?.lifted) return s;
      const plan = planTileDrop(s, id, x, y);
      const back: WindowState = { ...w, ...w.lifted, lifted: null };
      const put = (to: WindowState) => s.windows.map((c) => (c.id === id ? to : c));
      if (!plan) return { ...s, windows: put(back) };
      const { key, tree, from, to } = plan;
      currentMonitor.current = to.id;
      return {
        ...s,
        trees: { ...s.trees, [key]: tree },
        windows: put(from.id === to.id ? back : { ...carryTo(back, from, to), workspace: plan.workspace }),
      };
    });
  }, [planTileDrop, update]);

  /**
   * Float a tiled window, or tile a floating one (Super+T). Floated, it
   * sits over the middle of the tile it left; tiled, it splits the tile
   * nearest the pointer, as on Hyprland.
   */
  const toggleFloating = useCallback((id: string) => {
    update((s) => {
      const w = s.windows.find((c) => c.id === id);
      if (!w) return s;
      const areas = getAreas();
      const tiling = getTiling();
      const area = homeArea(areas, w);
      const top = maxZ(s.windows);
      const put = (to: WindowState) => s.windows.map((c) => (c.id === id ? to : c));
      if (w.tiled) {
        const slot = w.slot ?? w.tiled;
        if (!area || w.maximized) return { ...s, windows: put({ ...w, floating: true, zoomed: false, snapped: null, z: top + 1 }) };
        const width = Math.min(w.width, area.width);
        const height = Math.min(w.height, area.height);
        const within = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(v, max)));
        return {
          ...s,
          windows: put({
            ...w,
            floating: true,
            zoomed: false,
            snapped: null,
            x: within(slot.x + (slot.width - width) / 2, area.x, area.x + area.width - width),
            y: within(slot.y + (slot.height - height) / 2, area.y, area.y + area.height - height),
            width,
            height,
            z: top + 1,
          }),
        };
      }
      const next: WindowState = { ...w, floating: false, pinned: false, snapped: null, z: top + 1 };
      const point = getPointer();
      let trees = s.trees;
      if (area && point && tileable(next, tiling)) {
        const key = treeKey(area.id, w.workspace);
        const tree = trees[key] ?? null;
        if (!treeLeaves(tree).includes(id)) {
          const rect = workspaceTileRect(area, tiling.outerGap, w.workspace);
          trees = { ...trees, [key]: insertLeaf(tree, id, rect, tiling.gap, { point }) };
        }
      }
      return { ...s, trees, windows: put(next) };
    });
  }, [getAreas, getPointer, getTiling, update]);

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

  /** A tiled window's tree, with what's needed to lay it out. */
  const treeOf = useCallback((s: WmState, id: string) => {
    const w = s.windows.find((c) => c.id === id);
    if (!w?.slot || fillsLayout(w)) return null;
    const area = homeArea(getAreas(), w);
    const key = area ? treeKey(area.id, w.workspace) : null;
    const tree = key ? s.trees[key] : undefined;
    if (!area || !key || !tree) return null;
    const { gap, outerGap } = getTiling();
    const rect = workspaceTileRect(area, outerGap, w.workspace);
    const resized = (dx: number, dy: number, edges?: ResizeEdges) => resizeLeaf(tree, id, dx, dy, rect, gap, edges) ?? tree;
    return { key, tree, gap, rect, resized };
  }, [getAreas, getTiling]);

  /**
   * Grow (or, negative, shrink) a window by `dx` / `dy` pixels: a floating
   * one around its center; a tiled one has the splits it sits in moved that
   * far right and down, as Hyprland's `resizeactive` (see resizeLeaf).
   */
  const resizeBy = useCallback((id: string, dx: number, dy: number) => {
    const w = windowsRef.current.find((x) => x.id === id);
    if (!w || w.maximized || w.snapped || hasCustomShape(w)) return;
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
      const t = treeOf(s, id);
      if (!t) return s;
      const next = t.resized(dx, dy);
      return next === t.tree ? s : { ...s, trees: { ...s.trees, [t.key]: next! } };
    });
  }, [resize, treeOf, update]);

  /**
   * Where every tile of a window's layout would be with that window's
   * `edges` dragged by `dx` / `dy`, for a mouse resize to paint as it goes
   * (it commits once, with resizeTile, when it ends). Null for a window
   * that isn't a tile to resize.
   */
  const tileResizeRects = useCallback(
    (id: string, dx: number, dy: number, edges: ResizeEdges): Map<string, Rect> | null => {
      const s = stateRef.current;
      const t = treeOf(s, id);
      if (!t) return null;
      const byId = new Map(s.windows.map((w) => [w.id, w]));
      const out = new Map<string, Rect>();
      const tree = t.resized(dx, dy, edges);
      for (const [leaf, slot] of layoutTree(tree, t.rect, t.gap)) {
        const w = byId.get(leaf);
        if (w && !fillsLayout(w)) out.set(leaf, paintedTile(w, slot));
      }
      return out;
    },
    [treeOf],
  );

  /** Resize a tile by its `edges`, dragged by `dx` / `dy` (the end of a mouse resize). */
  const resizeTile = useCallback((id: string, dx: number, dy: number, edges: ResizeEdges) => {
    update((s) => {
      const t = treeOf(s, id);
      if (!t) return s;
      const next = t.resized(dx, dy, edges);
      return next === t.tree ? s : { ...s, trees: { ...s.trees, [t.key]: next! } };
    });
  }, [treeOf, update]);

  /** Keep a tiled window at its floating size inside its tile, or let it fill it again (Super+P). */
  const togglePseudo = useCallback((id: string) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, pseudo: !w.pseudo } : w)));
  }, [setWindows]);

  /**
   * Give a tile its whole layout, gaps kept, over the other tiles, or put
   * it back (Super+Alt+F, Hyprland's maximized fullscreen).
   */
  const toggleZoom = useCallback((id: string) => {
    update((s) => {
      const w = s.windows.find((c) => c.id === id);
      if (!w || (!w.zoomed && !w.tiled)) return s;
      const areas = getAreas();
      const area = homeArea(areas, w);
      const top = maxZ(s.windows);
      return {
        ...s,
        windows: s.windows.map((c) => {
          if (c.id === id) return { ...(c.maximized ? restored(c) : c), zoomed: !w.zoomed, z: top + 1 };
          // One at a time: it takes the layout over from another.
          const beside = !w.zoomed && c.workspace === w.workspace && homeArea(areas, c)?.id === area?.id;
          if (!beside || !c.slot || !fillsLayout(c)) return c;
          return { ...(c.maximized ? restored(c) : c), zoomed: false };
        }),
      };
    });
  }, [getAreas, update]);

  /**
   * Pop a window out (Super+O, as Omarchy's): it floats in the middle of
   * its monitor, pinned, so it stays on screen on every workspace there.
   * Again, and it's unpinned and goes back into the layout.
   */
  const togglePop = useCallback((id: string) => {
    update((s) => {
      const w = s.windows.find((c) => c.id === id);
      const area = w ? homeArea(getAreas(), w) : null;
      if (!w || !area || w.frameless) return s;
      const top = maxZ(s.windows);
      const put = (to: WindowState) => s.windows.map((c) => (c.id === id ? to : c));
      if (w.pinned) return { ...s, windows: put({ ...w, pinned: false, floating: false, z: top + 1 }) };
      const { width, height } = clampSize(Math.min(POP_WIDTH, area.width), Math.min(POP_HEIGHT, area.height), false);
      return {
        ...s,
        windows: put({
          ...(w.maximized || w.snapped ? restored(w) : w),
          floating: true,
          pinned: true,
          zoomed: false,
          x: Math.round(area.x + Math.max(0, (area.width - width) / 2)),
          y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
          width,
          height,
          z: top + 1,
        }),
      };
    });
  }, [getAreas, update]);

  /** Pin a window, so it shows on every workspace of its monitor above the others, or unpin it. */
  const togglePin = useCallback((id: string) => {
    setWindows((ws) => {
      const top = maxZ(ws);
      return ws.map((w) => (w.id === id ? { ...w, pinned: !w.pinned, floating: w.pinned ? w.floating : true, z: top + 1 } : w));
    });
  }, [setWindows]);

  /**
   * Move the workspace the current monitor shows, windows and layout, to
   * the monitor in direction `dir` (Super+Shift+Alt+arrow): under the same
   * number there when that one is empty, else the first empty one.
   */
  const moveWorkspaceToMonitor = useCallback((dir: Direction) => {
    const from = commandArea();
    const to = from ? neighborArea(from, dir) : null;
    if (!from || !to) return;
    update((s) => {
      const areas = getAreas();
      const n = activeWorkspace(s.active, from.id);
      const on = (area: WorkArea, workspace: number) => (w: WindowState) =>
        !w.closing && !w.pinned && w.workspace === workspace && homeArea(areas, w)?.id === area.id;
      const movers = new Set(s.windows.filter(on(from, n)).map((w) => w.id));
      if (movers.size === 0) return s;
      const free = (workspace: number) => !s.windows.some(on(to, workspace));
      const numbers = Array.from({ length: WORKSPACE_COUNT }, (_, i) => i + 1);
      const target = free(n) ? n : numbers.find(free);
      if (target === undefined) return s;
      const trees = { ...s.trees };
      const tree = trees[treeKey(from.id, n)];
      delete trees[treeKey(from.id, n)];
      if (tree) trees[treeKey(to.id, target)] = tree;
      else delete trees[treeKey(to.id, target)];
      const shown = showWorkspace({ ...s, trees, scratchpad: s.scratchpad === to.id ? null : s.scratchpad }, areas, to.id, target, false);
      currentMonitor.current = to.id;
      return {
        ...shown,
        windows: shown.windows.map((w) => (movers.has(w.id) ? { ...carryTo(w, from, to), workspace: target } : w)),
      };
    });
  }, [commandArea, getAreas, neighborArea, update]);

  /** Turn a window's full screen (see WindowState.presentation) on, or off again. */
  const present = useCallback((id: string, mode: 'screen' | 'client') => {
    setWindows((ws) => {
      const target = ws.find((w) => w.id === id);
      if (!target) return ws;
      const areas = getAreas();
      return raise(ws.map((w) => {
        if (w.id === id) return { ...w, presentation: w.presentation === mode ? undefined : mode };
        return mode === 'screen' && w.presentation === 'screen' && target.workspace === w.workspace && homeArea(areas, target)?.id === homeArea(areas, w)?.id
          ? { ...w, presentation: undefined } : w;
      }), id);
    });
  }, [setWindows, getAreas]);

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
      launchIn,
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
      setSnapSplit,
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
      workspaceSteps,
      beginWorkspaceSwipe,
      previousWorkspace,
      moveToWorkspace,
      toggleScratchpad,
      moveToScratchpad,
      focusDirection,
      swapDirection,
      moveToMonitor,
      focusMonitor,
      moveWorkspaceToMonitor,
      liftTile,
      dropTile,
      tileDropRect,
      toggleFloating,
      toggleSplit,
      togglePseudo,
      toggleZoom,
      togglePop,
      togglePin,
      resizeBy,
      tileResizeRects,
      resizeTile,
      relayout,
      present,
      adoptSession,
      getSession,
    }),
    [open, launchIn, close, closeApp, destroy, minimize, focus, move, resize, maximize, unmaximize, tile, setSnapSplit, toggleMaximize, cycleFocus, setFrameless, setTitle, setIcon, setAccent, fitToAreas, setCurrentMonitor, showWorkspaceOn, stepWorkspace, workspaceSteps, beginWorkspaceSwipe, previousWorkspace, moveToWorkspace, toggleScratchpad, moveToScratchpad, focusDirection, swapDirection, moveToMonitor, focusMonitor, moveWorkspaceToMonitor, liftTile, dropTile, tileDropRect, toggleFloating, toggleSplit, togglePseudo, toggleZoom, togglePop, togglePin, resizeBy, tileResizeRects, resizeTile, relayout, present, adoptSession, getSession],
  );

  // Back-compat full manager: state + actions in one object. Its identity
  // changes on every window mutation, so only components that genuinely
  // need `windows` should consume it. `active` is the workspace each
  // monitor shows (see activeWorkspace).
  return useMemo(() => ({ windows, active, scratchpad, actions, ...actions }), [windows, active, scratchpad, actions]);
}

export type WindowManager = ReturnType<typeof useWindows>;

/** The stable action set of the window manager (no state). */
export type WindowActions = WindowManager['actions'];
