import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { WidgetsContext, type WidgetsContextValue } from '@/contexts/WidgetsContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import type { WorkArea } from '@/lib/monitors';
import { builtinWidget, WIDGET_SIZES, widgetIdentity, type PermissionDomain, type PlacedWidget, type WidgetSize, type WidgetSource } from '@/lib/widgets';
import { storageArea, storageClear } from '@/lib/widgetStorage';

/** The space kept between widgets and around the edges. */
const GAP = 16;

/** Where a new widget of this size fits: down the right side of the primary monitor, then the next column in. */
function freeSpot(areas: WorkArea[], widgets: PlacedWidget[], size: WidgetSize): { monitor: string; x: number; y: number } {
  const area = areas.find((a) => a.primary) ?? areas[0];
  if (!area) return { monitor: '', x: GAP, y: GAP };
  const { width, height } = WIDGET_SIZES[size];
  // Those on a monitor that's gone show on the primary one.
  const taken = widgets
    .filter((w) => w.monitor === area.id || !areas.some((a) => a.id === w.monitor))
    .map((w) => ({ x: w.x, y: w.y, ...WIDGET_SIZES[w.size] }));
  const free = (x: number, y: number) =>
    taken.every((t) => x + width + GAP <= t.x || t.x + t.width + GAP <= x || y + height + GAP <= t.y || t.y + t.height + GAP <= y);
  for (let x = area.width - width - GAP * 2; x >= GAP; x -= GAP) {
    for (let y = GAP * 2; y + height <= area.height - GAP; y += GAP) {
      if (free(x, y)) return { monitor: area.id, x, y };
    }
  }
  return { monitor: area.id, x: GAP * 2, y: GAP * 2 };
}

function isPlaced(value: unknown): value is PlacedWidget {
  const w = value as PlacedWidget | null;
  return !!w && typeof w.id === 'string' && typeof w.monitor === 'string' && typeof w.x === 'number' &&
    typeof w.y === 'number' && w.size in WIDGET_SIZES && (w.source?.type === 'builtin' || w.source?.type === 'napplet');
}

/** The desktop's widgets, kept on this computer. */
export function WidgetsProvider({ children }: { children: ReactNode }) {
  const areas = useWorkAreas();
  const [stored, setStored] = useLocalStorage<unknown[]>('din:widgets', []);
  const widgets = useMemo(() => (Array.isArray(stored) ? stored.filter(isPlaced) : []), [stored]);
  const [editing, setEditing] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const update = useCallback(
    (change: (list: PlacedWidget[]) => PlacedWidget[]) =>
      setStored((prev) => change(Array.isArray(prev) ? prev.filter(isPlaced) : [])),
    [setStored],
  );

  const add = useCallback((source: WidgetSource, options: { size?: WidgetSize; denied?: PermissionDomain[] } = {}) => {
    const size = options.size ?? (source.type === 'builtin' ? (builtinWidget(source.id)?.size ?? 'small') : 'small');
    const denied = options.denied?.length ? { denied: options.denied } : {};
    update((list) => [...list, { id: crypto.randomUUID(), source, size, ...denied, ...freeSpot(areas, list, size) }]);
  }, [areas, update]);

  const remove = useCallback((id: string) => {
    const gone = widgets.find((w) => w.id === id);
    if (gone) storageClear(storageArea(widgetIdentity(gone.source), gone.id));
    update((list) => list.filter((w) => w.id !== id));
  }, [widgets, update]);

  const move = useCallback((id: string, monitor: string, x: number, y: number) => {
    update((list) => list.map((w) => (w.id === id ? { ...w, monitor, x, y } : w)));
  }, [update]);

  const resize = useCallback((id: string, size: WidgetSize) => {
    update((list) => list.map((w) => (w.id === id ? { ...w, size } : w)));
  }, [update]);

  const setDenied = useCallback((id: string, denied: PermissionDomain[]) => {
    update((list) => list.map((w) => (w.id === id ? { ...w, denied } : w)));
  }, [update]);

  const value = useMemo<WidgetsContextValue>(
    () => ({ widgets, add, remove, move, resize, setDenied, editing, setEditing, galleryOpen, setGalleryOpen }),
    [widgets, add, remove, move, resize, setDenied, editing, galleryOpen],
  );
  return <WidgetsContext.Provider value={value}>{children}</WidgetsContext.Provider>;
}
