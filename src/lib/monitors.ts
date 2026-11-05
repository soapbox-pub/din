/**
 * The physical monitors Din's one window spans, and the geometry the desktop
 * derives from them.
 *
 * On DinOS, din-shell stretches the shell window over every connected
 * output, and on a bare X11 session the host sizes the window to the union
 * of the outputs itself. Either way the renderer sees one
 * big viewport; this module says where each monitor sits inside it, so the
 * desktop can keep the menu bar and Dock on the primary monitor, maximize
 * windows to the monitor they're on, and keep them out of the dead areas
 * between monitors of different sizes.
 *
 * The host reports displays through `window.dinos.monitors` (electron/preload.cjs,
 * backed by the monitors:* handlers in electron/main.mts). Where it's absent
 * (a plain browser, or the windowed dev shell) the viewport is one monitor.
 */

/** A rectangle in CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One monitor, in viewport CSS pixels. */
export interface Monitor extends Rect {
  /** Stable for as long as the output stays connected. */
  id: string;
  /** Human-readable label, e.g. the connector or model name. */
  name: string;
  primary: boolean;
}

/** One display as the host reports it: device-independent pixels. */
export interface HostMonitor {
  id: string;
  name: string;
  /** Position relative to the shell window's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface MonitorsBridge {
  /** The displays the shell window covers, or null when it covers just one. */
  get(): Promise<HostMonitor[] | null>;
  /** Called with the new displays whenever they change. Returns an unsubscribe. */
  onChange(callback: (monitors: HostMonitor[] | null) => void): () => void;
  /** Chromium's page zoom: CSS pixels per device-independent pixel. */
  zoomFactor(): number;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    monitors?: MonitorsBridge;
  }
}

/** The monitors bridge, or undefined when running outside the Electron shell. */
export function getMonitorsBridge(): MonitorsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.monitors;
}

/** The whole viewport as a single primary monitor. */
export function viewportMonitor(): Monitor {
  return {
    id: 'viewport',
    name: 'Display',
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    primary: true,
  };
}

/**
 * Convert host displays to viewport monitors: scale out the page zoom, and
 * clip each to the viewport, dropping any that fall outside it entirely (the
 * compositor may not have resized the window yet). Exactly one comes back
 * primary; with nothing usable, the viewport is the monitor.
 */
export function toMonitors(host: HostMonitor[] | null, zoom: number): Monitor[] {
  const factor = zoom > 0 ? zoom : 1;
  const monitors: Monitor[] = [];
  for (const m of host ?? []) {
    const x = Math.max(0, Math.round(m.x / factor));
    const y = Math.max(0, Math.round(m.y / factor));
    const right = Math.min(window.innerWidth, Math.round((m.x + m.width) / factor));
    const bottom = Math.min(window.innerHeight, Math.round((m.y + m.height) / factor));
    if (right - x < 1 || bottom - y < 1) continue;
    monitors.push({ id: m.id, name: m.name, x, y, width: right - x, height: bottom - y, primary: m.primary });
  }
  if (monitors.length === 0) return [viewportMonitor()];
  const primary = monitors.find((m) => m.primary) ?? monitors[0];
  return monitors.map((m) => ({ ...m, primary: m === primary }));
}

/**
 * A dev-only stand-in for a multi-monitor host, so the layout can be worked
 * on in a plain browser: `?monitors=1280x800,1024x768` lays monitors out left
 * to right, top-aligned, the first one primary. An `@x:y` suffix places one
 * explicitly (`1280x800,1024x768@1280:200`); a trailing `*` makes it primary.
 */
export function simulatedMonitors(): HostMonitor[] | null {
  if (!import.meta.env.DEV) return null;
  const spec = new URLSearchParams(window.location.search).get('monitors');
  if (!spec) return null;
  const monitors: HostMonitor[] = [];
  let nextX = 0;
  for (const [i, part] of spec.split(',').entries()) {
    const match = part.match(/^(\d+)x(\d+)(?:@(\d+):(\d+))?(\*)?$/);
    if (!match) continue;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const x = match[3] !== undefined ? Number(match[3]) : nextX;
    const y = match[4] !== undefined ? Number(match[4]) : 0;
    monitors.push({ id: `sim-${i}`, name: `Display ${i + 1}`, x, y, width, height, primary: Boolean(match[5]) });
    nextX = x + width;
  }
  if (monitors.length === 0) return null;
  if (!monitors.some((m) => m.primary)) monitors[0].primary = true;
  return monitors;
}

/** A stable string for a monitor list, to tell real changes from re-reports. */
export function monitorsSignature(monitors: Monitor[]): string {
  return monitors
    .map((m) => `${m.id}:${m.x},${m.y},${m.width}x${m.height}${m.primary ? '*' : ''}`)
    .join('|');
}

/**
 * A monitor as the window manager sees it: in workspace coordinates (Din
 * windows' x/y are relative to the workspace, which starts below the menu bar
 * on the primary monitor, so other monitors may sit at negative offsets).
 */
export interface WorkArea extends Rect {
  id: string;
  primary: boolean;
  /** The whole monitor; the work area itself leaves out the menu bar or taskbar. */
  bounds: Rect;
}

/**
 * Work areas for the given monitors, with the workspace's top-left at
 * `origin` in the viewport. The primary monitor's work area starts at the
 * workspace's top-left corner, below the menu bar or a taskbar along the top
 * and right of one down the left, and stops `inset.bottom` px above the
 * monitor's bottom edge, above a taskbar along the bottom, and `inset.right`
 * px short of its right edge, beside one down the right.
 */
export function workAreas(
  monitors: Monitor[],
  origin: { x: number; y: number },
  inset: { bottom?: number; right?: number } = {},
): WorkArea[] {
  return monitors.map((m) => {
    const bounds = { x: m.x - origin.x, y: m.y - origin.y, width: m.width, height: m.height };
    const left = m.primary ? Math.max(bounds.x, 0) : bounds.x;
    const top = m.primary ? Math.max(bounds.y, 0) : bounds.y;
    const bottom = m.primary ? Math.max(inset.bottom ?? 0, 0) : 0;
    const right = m.primary ? Math.max(inset.right ?? 0, 0) : 0;
    return {
      id: m.id,
      primary: m.primary,
      bounds,
      x: left,
      y: top,
      width: Math.max(0, bounds.x + bounds.width - left - right),
      height: Math.max(0, bounds.y + bounds.height - top - bottom),
    };
  });
}

/** Whether a point lies inside a rectangle. */
export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** The area of overlap between two rectangles (0 when disjoint). */
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The primary work area (there always is one). */
export function primaryArea(areas: WorkArea[]): WorkArea {
  return areas.find((a) => a.primary) ?? areas[0];
}

/** The work area whose monitor holds a point, or null over a dead area. */
export function areaAt(areas: WorkArea[], x: number, y: number): WorkArea | null {
  return areas.find((a) => contains(a.bounds, x, y)) ?? null;
}

/**
 * The work area whose monitor holds a point, else the one nearest it. A
 * pointer the compositor keeps on a monitor can still land a hair outside the
 * monitor's measured bounds (rounding, page zoom, the very top row).
 */
export function areaNear(areas: WorkArea[], x: number, y: number): WorkArea {
  const hit = areaAt(areas, x, y);
  if (hit) return hit;
  let best = primaryArea(areas);
  let bestDistance = Infinity;
  for (const a of areas) {
    const { bounds: b } = a;
    const dx = Math.max(b.x - x, 0, x - (b.x + b.width - 1));
    const dy = Math.max(b.y - y, 0, y - (b.y + b.height - 1));
    const d = Math.hypot(dx, dy);
    if (d < bestDistance) {
      best = a;
      bestDistance = d;
    }
  }
  return best;
}

/** Height of a window's title bar, the part of it that must stay reachable. */
const TITLE_BAR_PX = 36;

/**
 * The work area a window belongs to: the one under the middle of its title
 * bar, else the one it overlaps most, else the primary.
 */
export function areaFor(areas: WorkArea[], rect: Rect): WorkArea {
  const titled = areaAt(areas, rect.x + rect.width / 2, rect.y + TITLE_BAR_PX / 2);
  if (titled) return titled;
  let best: WorkArea | null = null;
  let bestOverlap = 0;
  for (const a of areas) {
    const o = overlap(a.bounds, rect);
    if (o > bestOverlap) {
      best = a;
      bestOverlap = o;
    }
  }
  return best ?? primaryArea(areas);
}

/** Whether any monitor continues past `area`'s edge at the given point. */
export function hasNeighbor(
  areas: WorkArea[],
  area: WorkArea,
  edge: 'top' | 'left' | 'right',
  at: number,
): boolean {
  const { bounds } = area;
  const point =
    edge === 'top'
      ? { x: at, y: bounds.y - 1 }
      : edge === 'left'
        ? { x: bounds.x - 1, y: at }
        : { x: bounds.x + bounds.width, y: at };
  return areas.some((a) => a !== area && contains(a.bounds, point.x, point.y));
}

/** Absolute-position CSS for a rect (a monitor, inside a full-window layer). */
export function rectStyle(rect: Rect): { position: 'absolute'; left: number; top: number; width: number; height: number } {
  return { position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

export const SNAP_ZONES = ['left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

/** Where on a monitor a window snaps: a half, or a quarter in a corner. */
export type SnapZone = (typeof SNAP_ZONES)[number];

/**
 * Which of a window's right and bottom edges are the screen's: maximized or
 * full screen, both; snapped, those of its half or quarter that lie along
 * the screen's edge rather than against another window. What's inset in the
 * window (appChrome's ContentPane) meets the screen there and keeps its
 * rounded inset elsewhere.
 */
export function screenEdges(w: { maximized: boolean; fullscreen?: boolean; snapped: SnapZone | null }): { right: boolean; bottom: boolean } {
  if (w.maximized || w.fullscreen) return { right: true, bottom: true };
  switch (w.snapped) {
    case 'left':
      return { right: false, bottom: true };
    case 'right':
      return { right: true, bottom: true };
    case 'top-right':
      return { right: true, bottom: false };
    case 'bottom-left':
      return { right: false, bottom: true };
    case 'bottom-right':
      return { right: true, bottom: true };
    default:
      return { right: false, bottom: false };
  }
}

/**
 * Whether a window reaches the top of its monitor's work area, up against
 * the menu bar: maximized, or snapped to a half or a top quarter. Such a
 * window carries its title bar's color up behind the bar.
 */
export function underMenuBar(w: { maximized: boolean; snapped: SnapZone | null }): boolean {
  return w.maximized || w.snapped === 'left' || w.snapped === 'right' || w.snapped === 'top-left' || w.snapped === 'top-right';
}

/**
 * Where the borders between snapped windows sit, as fractions of the work
 * area: `x` between the left and right columns, `left` and `right` between
 * the top and bottom quarters of each column. Snapped windows on a monitor's
 * workspace share one, so dragging the border between two moves both.
 */
export interface SnapSplit {
  x: number;
  left: number;
  right: number;
}

export const EVEN_SPLIT: SnapSplit = { x: 0.5, left: 0.5, right: 0.5 };

/** The column a zone is in. */
export function zoneSide(zone: SnapZone): 'left' | 'right' {
  return zone === 'left' || zone.endsWith('-left') ? 'left' : 'right';
}

/** The row a zone is in: a half has both. */
export function zoneRow(zone: SnapZone): 'top' | 'bottom' | null {
  return zone.startsWith('top') ? 'top' : zone.startsWith('bottom') ? 'bottom' : null;
}

/** The rect a maximized or snapped window fills in `area`. */
export function snapRect(area: Rect, mode: 'max' | SnapZone, split: SnapSplit = EVEN_SPLIT): Rect {
  if (mode === 'max') return { x: area.x, y: area.y, width: area.width, height: area.height };
  const leftWidth = Math.round(area.width * split.x);
  const side = zoneSide(mode);
  const x = side === 'left' ? area.x : area.x + leftWidth;
  const width = side === 'left' ? leftWidth : area.width - leftWidth;
  const row = zoneRow(mode);
  if (!row) return { x, y: area.y, width, height: area.height };
  const topHeight = Math.round(area.height * split[side]);
  return row === 'top'
    ? { x, y: area.y, width, height: topHeight }
    : { x, y: area.y + topHeight, width, height: area.height - topHeight };
}
