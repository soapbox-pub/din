/**
 * The grid widgets sit on, one per work area, like a phone's home screen:
 * cells of WIDGET_CELL with WIDGET_GAP between them, as many as fit, centered
 * in the area. A widget covers a block of cells and never overlaps another.
 */
import type { WorkArea } from '@/lib/monitors';
import { WIDGET_CELL, WIDGET_GAP, WIDGET_MIN_SPAN, type PlacedWidget } from '@/lib/widgets';

export const WIDGET_PITCH = WIDGET_CELL + WIDGET_GAP;

export interface Cells {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface Grid {
  /** Its top-left cell's corner, in the workspace. */
  x: number;
  y: number;
  cols: number;
  rows: number;
}

/** A work area's grid. */
export function areaGrid(area: WorkArea): Grid {
  const fit = (length: number) => Math.max(WIDGET_MIN_SPAN, Math.floor((length - WIDGET_GAP) / WIDGET_PITCH));
  const cols = fit(area.width);
  const rows = fit(area.height);
  return {
    x: area.x + Math.max(0, Math.floor((area.width - (cols * WIDGET_PITCH - WIDGET_GAP)) / 2)),
    y: area.y + Math.max(0, Math.floor((area.height - (rows * WIDGET_PITCH - WIDGET_GAP)) / 2)),
    cols,
    rows,
  };
}

/** The work area a widget shows on: its own, or the primary one if that monitor is gone. */
export function widgetArea(areas: WorkArea[], widget: PlacedWidget): WorkArea | undefined {
  return areas.find((a) => a.id === widget.monitor) ?? areas.find((a) => a.primary) ?? areas[0];
}

/** Cells moved and cut to fit inside a grid. */
export function clampCells(grid: Grid, cells: Cells): Cells {
  const cols = Math.max(WIDGET_MIN_SPAN, Math.min(cells.cols, grid.cols));
  const rows = Math.max(WIDGET_MIN_SPAN, Math.min(cells.rows, grid.rows));
  return {
    col: Math.max(0, Math.min(cells.col, grid.cols - cols)),
    row: Math.max(0, Math.min(cells.row, grid.rows - rows)),
    cols,
    rows,
  };
}

/** Where a widget is on screen: its cells, fitted to its area's grid as it is now. */
export function placedCells(areas: WorkArea[], widget: PlacedWidget): { area: WorkArea; cells: Cells } | null {
  const area = widgetArea(areas, widget);
  return area ? { area, cells: clampCells(areaGrid(area), widget) } : null;
}

/** Cells in the workspace, in CSS pixels. */
export function cellsRect(grid: Grid, cells: Cells): { left: number; top: number; width: number; height: number } {
  return {
    left: grid.x + cells.col * WIDGET_PITCH,
    top: grid.y + cells.row * WIDGET_PITCH,
    width: cells.cols * WIDGET_PITCH - WIDGET_GAP,
    height: cells.rows * WIDGET_PITCH - WIDGET_GAP,
  };
}

/** The cells nearest a rectangle in the workspace, each edge to its closest grid line. */
export function nearestCells(grid: Grid, rect: { left: number; top: number; width: number; height: number }): Cells {
  const col = Math.round((rect.left - grid.x) / WIDGET_PITCH);
  const row = Math.round((rect.top - grid.y) / WIDGET_PITCH);
  const end = Math.round((rect.left + rect.width + WIDGET_GAP - grid.x) / WIDGET_PITCH);
  const bottom = Math.round((rect.top + rect.height + WIDGET_GAP - grid.y) / WIDGET_PITCH);
  return { col, row, cols: end - col, rows: bottom - row };
}

function overlap(a: Cells, b: Cells): boolean {
  return a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows;
}

/** Whether cells on an area are free of every widget but `except`. */
export function cellsFree(areas: WorkArea[], widgets: PlacedWidget[], areaId: string, cells: Cells, except?: string): boolean {
  return widgets.every((w) => {
    if (w.id === except) return true;
    const placed = placedCells(areas, w);
    return !placed || placed.area.id !== areaId || !overlap(placed.cells, cells);
  });
}

/** Where a block of cells fits on the primary monitor: down the right side, then the next column in. */
export function freeCells(areas: WorkArea[], widgets: PlacedWidget[], span: { cols: number; rows: number }, except?: string): { monitor: string } & Cells {
  const area = areas.find((a) => a.primary) ?? areas[0];
  if (!area) return { monitor: '', col: 0, row: 0, ...span };
  const grid = areaGrid(area);
  const { cols, rows } = clampCells(grid, { col: 0, row: 0, ...span });
  for (let col = grid.cols - cols; col >= 0; col--) {
    for (let row = 0; row + rows <= grid.rows; row++) {
      const cells = { col, row, cols, rows };
      if (cellsFree(areas, widgets, area.id, cells, except)) return { monitor: area.id, ...cells };
    }
  }
  return { monitor: area.id, col: 0, row: 0, cols, rows };
}
