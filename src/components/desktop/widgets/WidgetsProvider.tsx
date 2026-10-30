import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { WidgetsContext, type WidgetsContextValue } from '@/contexts/WidgetsContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { areaGrid, cellsFree, clampCells, freeCells, placedCells, WIDGET_PITCH, type Cells } from '@/lib/widgetGrid';
import { builtinWidget, WIDGET_SIZES, widgetIdentity, type PermissionDomain, type PlacedWidget, type WidgetSize, type WidgetSource } from '@/lib/widgets';
import { storageArea, storageClear } from '@/lib/widgetStorage';

/** A stored widget, or null. Those kept before the grid (`x`, `y` and a `size`) are put on it. */
function parsePlaced(value: unknown): PlacedWidget | null {
  const w = value as (PlacedWidget & { x?: unknown; y?: unknown; size?: unknown }) | null;
  if (!w || typeof w.id !== 'string' || typeof w.monitor !== 'string' || (w.source?.type !== 'builtin' && w.source?.type !== 'napplet')) return null;
  if ([w.col, w.row, w.cols, w.rows].every(Number.isInteger)) return w;
  if (typeof w.x !== 'number' || typeof w.y !== 'number' || typeof w.size !== 'string' || !(w.size in WIDGET_SIZES)) return null;
  const { cols, rows } = WIDGET_SIZES[w.size as WidgetSize];
  const { x: _x, y: _y, size: _size, ...rest } = w;
  return { ...rest, col: Math.round(w.x / WIDGET_PITCH), row: Math.round(w.y / WIDGET_PITCH), cols, rows };
}

function parseList(stored: unknown): PlacedWidget[] {
  return Array.isArray(stored) ? stored.map(parsePlaced).filter((w): w is PlacedWidget => w !== null) : [];
}

/** The desktop's widgets, kept on this computer. */
export function WidgetsProvider({ children }: { children: ReactNode }) {
  const areas = useWorkAreas();
  const [stored, setStored] = useLocalStorage<unknown[]>('din:widgets', []);
  const widgets = useMemo(() => parseList(stored), [stored]);
  const [editing, setEditing] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const update = useCallback(
    (change: (list: PlacedWidget[]) => PlacedWidget[]) => setStored((prev) => change(parseList(prev))),
    [setStored],
  );

  const add = useCallback((source: WidgetSource, options: { size?: WidgetSize; denied?: PermissionDomain[] } = {}) => {
    const size = options.size ?? (source.type === 'builtin' ? (builtinWidget(source.id)?.size ?? 'small') : 'small');
    const denied = options.denied?.length ? { denied: options.denied } : {};
    update((list) => [...list, { id: crypto.randomUUID(), source, ...denied, ...freeCells(areas, list, WIDGET_SIZES[size]) }]);
  }, [areas, update]);

  const remove = useCallback((id: string) => {
    const gone = widgets.find((w) => w.id === id);
    if (gone) storageClear(storageArea(widgetIdentity(gone.source), gone.id));
    update((list) => list.filter((w) => w.id !== id));
  }, [widgets, update]);

  const place = useCallback((id: string, monitor: string, cells: Cells) => {
    update((list) => list.map((w) => (w.id === id ? { ...w, monitor, ...cells } : w)));
  }, [update]);

  // A preset size: where it is if there's room, grown from its top-left corner, or else wherever there is.
  const resize = useCallback((id: string, size: WidgetSize) => {
    update((list) => list.map((w) => {
      if (w.id !== id) return w;
      const placed = placedCells(areas, w);
      if (!placed) return w;
      const { cols, rows } = WIDGET_SIZES[size];
      const cells = clampCells(areaGrid(placed.area), { ...placed.cells, cols, rows });
      return cellsFree(areas, list, placed.area.id, cells, id)
        ? { ...w, monitor: placed.area.id, ...cells }
        : { ...w, ...freeCells(areas, list, { cols, rows }, id) };
    }));
  }, [areas, update]);

  const setDenied = useCallback((id: string, denied: PermissionDomain[]) => {
    update((list) => list.map((w) => (w.id === id ? { ...w, denied } : w)));
  }, [update]);

  const value = useMemo<WidgetsContextValue>(
    () => ({ widgets, add, remove, place, resize, setDenied, editing, setEditing, galleryOpen, setGalleryOpen }),
    [widgets, add, remove, place, resize, setDenied, editing, galleryOpen],
  );
  return <WidgetsContext.Provider value={value}>{children}</WidgetsContext.Provider>;
}
