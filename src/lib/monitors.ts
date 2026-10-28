/**
 * The physical monitors Din's one window spans, and the geometry the desktop
 * derives from them.
 *
 * On DinOS, cage stretches the shell window over every connected output (its
 * default "extend" mode), and on a bare X11 session the host sizes the
 * window to the union of the outputs itself. Either way the renderer sees one
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
  /** The whole monitor; the work area itself leaves out the menu bar. */
  bounds: Rect;
}

/**
 * Work areas for the given monitors, with the workspace's top-left at
 * `origin` in the viewport. The primary monitor's work area starts at the
 * workspace's top edge, below the menu bar.
 */
export function workAreas(monitors: Monitor[], origin: { x: number; y: number }): WorkArea[] {
  return monitors.map((m) => {
    const bounds = { x: m.x - origin.x, y: m.y - origin.y, width: m.width, height: m.height };
    const top = m.primary ? Math.max(bounds.y, 0) : bounds.y;
    return {
      id: m.id,
      primary: m.primary,
      bounds,
      x: bounds.x,
      y: top,
      width: bounds.width,
      height: Math.max(0, bounds.y + bounds.height - top),
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

/** The rect a maximized or edge-tiled window fills in `area`. */
export function snapRect(area: Rect, mode: 'max' | 'left' | 'right'): Rect {
  if (mode === 'max') return { x: area.x, y: area.y, width: area.width, height: area.height };
  const half = Math.round(area.width / 2);
  return mode === 'left'
    ? { x: area.x, y: area.y, width: half, height: area.height }
    : { x: area.x + half, y: area.y, width: area.width - half, height: area.height };
}
