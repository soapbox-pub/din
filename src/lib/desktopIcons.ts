/**
 * Desktop icons (docs/desktop-icons.md): what's in ~/Desktop, on a grid of
 * its own over each work area, filled from the top-left corner down the
 * columns (widgets fill from the right). Each icon keeps its cell by name;
 * one with no cell, or whose cell is taken, goes to the first free one.
 */
import type { WorkArea } from '@/lib/monitors';
import { compareEntriesBy, type FsEntry } from '@/lib/fs';

export type DesktopIconSize = 'small' | 'medium' | 'large';

export const DESKTOP_ICON_SIZES: Record<DesktopIconSize, { icon: number; width: number; height: number }> = {
  small: { icon: 32, width: 80, height: 72 },
  medium: { icon: 48, width: 96, height: 96 },
  large: { icon: 64, width: 112, height: 120 },
};

/** Room left around the grid, inside the work area. */
const MARGIN = 8;

/** Where an icon is kept: a cell of a work area's grid. */
export interface IconPlace {
  monitor: string;
  col: number;
  row: number;
}

export interface IconGrid {
  x: number;
  y: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A work area's icon grid, `bottom` px kept clear at its foot (the Dock). */
export function iconGrid(area: WorkArea, size: DesktopIconSize, bottom = 0): IconGrid {
  const { width, height } = DESKTOP_ICON_SIZES[size];
  return {
    x: area.x + MARGIN,
    y: area.y + MARGIN,
    cols: Math.max(1, Math.floor((area.width - 2 * MARGIN) / width)),
    rows: Math.max(1, Math.floor((area.height - 2 * MARGIN - bottom) / height)),
    width,
    height,
  };
}

export function cellRect(grid: IconGrid, col: number, row: number): Rect {
  return { left: grid.x + col * grid.width, top: grid.y + row * grid.height, width: grid.width, height: grid.height };
}

/** The cell under a point of the workspace, kept on the grid. */
export function cellAt(grid: IconGrid, x: number, y: number): { col: number; row: number } {
  return {
    col: Math.max(0, Math.min(grid.cols - 1, Math.floor((x - grid.x) / grid.width))),
    row: Math.max(0, Math.min(grid.rows - 1, Math.floor((y - grid.y) / grid.height))),
  };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** An icon as laid out: its work area, cell and rect. */
export interface PlacedIcon {
  area: WorkArea;
  col: number;
  row: number;
  rect: Rect;
}

export interface Layout {
  places: Map<string, PlacedIcon>;
  /** Whether a cell is taken by an icon or a widget. */
  taken(area: WorkArea, col: number, row: number): boolean;
  grid(area: WorkArea): IconGrid;
}

const key = (area: string, col: number, row: number) => `${area}\0${col}\0${row}`;

/**
 * Lay icons out: those with a place first, where they were if that cell is
 * free (on the primary monitor if theirs is gone), then the rest in order in
 * the first free cells. `blocked` says which cells widgets cover.
 */
export function layoutIcons(
  names: readonly string[],
  stored: Readonly<Record<string, IconPlace>>,
  areas: readonly WorkArea[],
  gridFor: (area: WorkArea) => IconGrid,
  blocked: (area: WorkArea, rect: Rect) => boolean,
): Layout {
  const primary = areas.find((a) => a.primary) ?? areas[0];
  const grids = new Map<string, IconGrid>();
  const grid = (area: WorkArea) => {
    let g = grids.get(area.id);
    if (!g) grids.set(area.id, (g = gridFor(area)));
    return g;
  };
  const occupied = new Set<string>();
  const taken = (area: WorkArea, col: number, row: number) =>
    occupied.has(key(area.id, col, row)) || blocked(area, cellRect(grid(area), col, row));
  const places = new Map<string, PlacedIcon>();
  const put = (name: string, area: WorkArea, col: number, row: number) => {
    occupied.add(key(area.id, col, row));
    places.set(name, { area, col, row, rect: cellRect(grid(area), col, row) });
  };
  if (!primary) return { places, taken: () => true, grid };

  const pending: string[] = [];
  for (const name of names) {
    const place = stored[name];
    if (!place) continue;
    const area = areas.find((a) => a.id === place.monitor) ?? primary;
    const g = grid(area);
    const col = Math.min(Math.max(0, place.col), g.cols - 1);
    const row = Math.min(Math.max(0, place.row), g.rows - 1);
    if (taken(area, col, row)) pending.push(name);
    else put(name, area, col, row);
  }
  for (const name of names) if (!stored[name]) pending.push(name);
  const ordered = [primary, ...areas.filter((a) => a !== primary)];
  for (const name of pending) {
    const free = firstFree(ordered, grid, taken);
    if (free) put(name, free.area, free.col, free.row);
    else put(name, primary, 0, 0);
  }
  return { places, taken, grid };
}

function firstFree(
  areas: readonly WorkArea[],
  grid: (area: WorkArea) => IconGrid,
  taken: (area: WorkArea, col: number, row: number) => boolean,
): { area: WorkArea; col: number; row: number } | null {
  for (const area of areas) {
    const g = grid(area);
    for (let col = 0; col < g.cols; col++) {
      for (let row = 0; row < g.rows; row++) {
        if (!taken(area, col, row)) return { area, col, row };
      }
    }
  }
  return null;
}

/** The free cell nearest one, on its grid, or null when the grid is full. */
export function nearestFree(
  g: IconGrid,
  col: number,
  row: number,
  taken: (col: number, row: number) => boolean,
): { col: number; row: number } | null {
  let best: { col: number; row: number; d: number } | null = null;
  for (let c = 0; c < g.cols; c++) {
    for (let r = 0; r < g.rows; r++) {
      if (taken(c, r)) continue;
      const d = (c - col) ** 2 + (r - row) ** 2;
      if (!best || d < best.d) best = { col: c, row: r, d };
    }
  }
  return best && { col: best.col, row: best.row };
}

export type DesktopIconSort = 'name' | 'kind' | 'modified' | 'size';

export const DESKTOP_ICON_SORTS: { value: DesktopIconSort; name: string }[] = [
  { value: 'name', name: 'Name' },
  { value: 'kind', name: 'Kind' },
  { value: 'modified', name: 'Date Modified' },
  { value: 'size', name: 'Size' },
];

/** Entries in the order arranging puts them in: folders first, then by the key. */
export function sortIcons<T extends FsEntry>(entries: readonly T[], by: DesktopIconSort): T[] {
  const compare = compareEntriesBy(by === 'kind' ? 'type' : by, by === 'modified' || by === 'size');
  return [...entries].sort(compare);
}

/** A freedesktop desktop entry (a launcher), as much of it as icons need. */
export interface DesktopEntry {
  name?: string;
  icon?: string;
  type?: string;
  url?: string;
  /** The Din app it opens, by registry id (Din's own X-Din-App key). */
  app?: string;
  hidden: boolean;
}

export function isDesktopEntryName(name: string): boolean {
  return name.toLowerCase().endsWith('.desktop');
}

/** The [Desktop Entry] group of a .desktop file. */
export function parseDesktopEntry(text: string): DesktopEntry {
  const values = new Map<string, string>();
  let inGroup = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inGroup = line === '[Desktop Entry]';
      continue;
    }
    if (!inGroup) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    if (!values.has(k)) values.set(k, line.slice(eq + 1).trim());
  }
  return {
    name: values.get('Name') || undefined,
    icon: values.get('Icon') || undefined,
    type: values.get('Type') || undefined,
    url: values.get('URL') || undefined,
    app: values.get('X-Din-App') || undefined,
    hidden: values.get('Hidden') === 'true' || values.get('NoDisplay') === 'true',
  };
}

/** A launcher for one of the desktop's apps, as a .desktop file's text. */
export function shortcutEntry(app: { id: string; name: string }): string {
  const exec = /^[\w.:-]+$/.test(app.id) ? `din apps open ${app.id}` : 'din apps list';
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${app.name.replace(/[\r\n]/g, ' ')}`,
    `Exec=${exec}`,
    `X-Din-App=${app.id.replace(/[\r\n]/g, '')}`,
    '',
  ].join('\n');
}

/** A file name for a shortcut to an app, safe on disk. */
export function shortcutFileName(appName: string): string {
  const base = appName.replace(/[/\0]/g, '-').replace(/^\.+/, '').trim() || 'Shortcut';
  return `${base}.desktop`;
}

/** "New Folder", or "New Folder 2" and on when that's taken. */
export function uniqueName(taken: ReadonlySet<string>, base: string, ext = ''): string {
  if (!taken.has(`${base}${ext}`)) return `${base}${ext}`;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}${ext}`;
    if (!taken.has(name)) return name;
  }
}

/** The desktop folder in ~/.config/user-dirs.dirs, if it names one. */
export function xdgDesktopDir(userDirs: string, home: string): string | null {
  const match = /^\s*XDG_DESKTOP_DIR\s*=\s*"([^"]*)"/m.exec(userDirs);
  if (!match) return null;
  const dir = match[1].replace(/^\$HOME(?=\/|$)/, home);
  return dir.startsWith('/') && dir !== home ? dir : null;
}
