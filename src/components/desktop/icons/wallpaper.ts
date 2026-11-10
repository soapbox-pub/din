/**
 * What the bare wallpaper does for desktop icons: a click clears the
 * selection, a drag draws a selection box, and files, icons and apps dropped
 * there land where they're dropped. DesktopMenu's layers (one inside the
 * workspace, one under every monitor) are the wallpaper, so they take these
 * handlers.
 */
import { useSyncExternalStore } from 'react';
import { useDesktopIcons, type DesktopIconsContextValue } from '@/contexts/DesktopIconsContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { activeFileDrag, endFileDrag, startFileDrag } from '@/components/desktop/apps/files/dnd';
import { acceptDrag, currentDrag, DRAG_MIME, setDragPoint } from '@/lib/dinDrag';
import { cellAt, rectsOverlap, type Rect } from '@/lib/desktopIcons';
import { useToast } from '@/hooks/useToast';
import { cleanFsError, getFsBridge, joinPath } from '@/lib/fs';
import { areaAt, type WorkArea } from '@/lib/monitors';

/** An app dragged out of the apps menu, by id. */
export const APP_MIME = 'application/x-din-app';
/** Desktop icons being moved about the desktop. */
const ICONS_MIME = 'application/x-din-desktop-icons';

let layer: HTMLElement | null = null;

/** The icon layer, whose corner is the workspace's. */
export function setIconLayer(el: HTMLElement | null): void {
  layer = el;
}

/** A point of the viewport in workspace coordinates. */
export function toWorkspace(clientX: number, clientY: number): { x: number; y: number } {
  const r = layer?.getBoundingClientRect();
  return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
}

let band: Rect | null = null;
const bandListeners = new Set<() => void>();
function setBand(next: Rect | null): void {
  band = next;
  for (const l of bandListeners) l();
}

/** The selection box being drawn, in workspace coordinates. */
export function useSelectionBand(): Rect | null {
  return useSyncExternalStore(
    (l) => {
      bandListeners.add(l);
      return () => bandListeners.delete(l);
    },
    () => band,
  );
}

/** A value React can follow (useSyncExternalStore). */
function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  return {
    get: () => value,
    set(next: T) {
      if (next === value) return;
      value = next;
      for (const l of listeners) l();
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  };
}

/** Icons being dragged by the desktop, and where the pointer holds the one grabbed. */
export interface IconDrag {
  names: string[];
  anchor: string;
  dx: number;
  dy: number;
}

const moving = store<IconDrag | null>(null);

/** The icons being dragged, for the ghost that follows the pointer. */
export const useIconDrag = moving.use;

/** The cells the icons being dragged would land on if dropped now, in workspace coordinates. */
const preview = store<{ key: string; rects: Rect[] } | null>(null);
let previewTimer: ReturnType<typeof setTimeout> | undefined;

export function useDropPreview(): Rect[] | null {
  return preview.use()?.rects ?? null;
}

/**
 * Keep the preview while the wallpaper hears the drag. Over a window or a
 * folder it stops hearing it, and the preview goes a moment later.
 */
function holdPreview(next: { key: string; rects: Rect[] }): void {
  preview.set(next);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => preview.set(null), 200);
}

function clearPreview(): void {
  clearTimeout(previewTimer);
  preview.set(null);
}

// The pointer over the desktop's own surfaces, for the ghost (apps report
// it over their windows, `drag.over`).
const trackPoint = (e: DragEvent) => setDragPoint({ x: e.clientX, y: e.clientY });

/** Start dragging icons: about the desktop, or out to a window or the Dock. */
export function startIconDrag(e: React.DragEvent<HTMLElement>, icons: DesktopIconsContextValue, anchor: string): void {
  const names = icons.selected.has(anchor) ? [...icons.selected] : [anchor];
  const chosen = icons.icons.filter((i) => names.includes(i.name));
  startFileDrag(
    e,
    { paths: chosen.map((i) => i.path), folders: new Set(chosen.filter((i) => i.kind === 'directory').map((i) => i.path)) },
    chosen.length === 1 ? chosen[0].label : `${chosen.length} items`,
  );
  const rect = e.currentTarget.getBoundingClientRect();
  moving.set({ names, anchor, dx: e.clientX - rect.left, dy: e.clientY - rect.top });
  e.dataTransfer.setData(ICONS_MIME, '1');
  // The desktop draws the icons following the pointer itself (IconDragGhost),
  // so the engine's own image is made empty.
  const blank = document.createElement('div');
  blank.style.cssText = 'position:fixed;top:-10px;left:-10px;width:1px;height:1px;opacity:0';
  document.body.appendChild(blank);
  e.dataTransfer.setDragImage(blank, 0, 0);
  requestAnimationFrame(() => blank.remove());
  setDragPoint({ x: e.clientX, y: e.clientY });
  document.addEventListener('dragover', trackPoint, true);
}

export function endIconDrag(e: React.DragEvent): void {
  document.removeEventListener('dragover', trackPoint, true);
  moving.set(null);
  clearPreview();
  endFileDrag(e);
  setDragPoint(null);
}

/** The cell under a point, on whichever monitor holds it. */
function cellUnder(icons: DesktopIconsContextValue, areas: WorkArea[], x: number, y: number) {
  const area = areaAt(areas, x, y);
  return area ? { monitor: area.id, ...cellAt(icons.grid(area), x, y) } : undefined;
}

/**
 * Where icons dragged about the desktop go, dropped at a point of the
 * workspace: the one grabbed to the cell under its middle, the others kept
 * where they were relative to it, on its monitor.
 */
function iconMoves(icons: DesktopIconsContextValue, areas: WorkArea[], drag: IconDrag, x: number, y: number) {
  const { names, anchor, dx, dy } = drag;
  const from = icons.places.get(anchor);
  if (!from) return null;
  const at = cellUnder(icons, areas, x - dx + from.rect.width / 2, y - dy + from.rect.height / 2);
  if (!at) return null;
  const others = names.filter((n) => n !== anchor);
  return {
    key: `${at.monitor}\0${at.col}\0${at.row}`,
    moves: [anchor, ...others].map((name) => {
      const p = icons.places.get(name);
      return p && p.area.id === from.area.id
        ? { name, monitor: at.monitor, col: at.col + p.col - from.col, row: at.row + p.row - from.row }
        : { name, ...at };
    }),
  };
}

/** Whether a drag is something the desktop takes. */
function takes(e: React.DragEvent): boolean {
  const types = e.dataTransfer.types;
  if (types.includes(ICONS_MIME) || types.includes(APP_MIME)) return true;
  return activeFileDrag(e) !== null;
}

/**
 * The paths a drop of files brings, and whether they move: the desktop's
 * own drags as they are, an app's once taken from the broker.
 */
function droppedFiles(e: React.DragEvent): { paths: string[]; move: boolean } | null {
  const copy = e.ctrlKey;
  const token = e.dataTransfer.types.includes(DRAG_MIME) ? e.dataTransfer.getData(DRAG_MIME) : '';
  const app = token ? currentDrag() : null;
  if (app && app.source !== 'din') {
    const entry = acceptDrag(token, copy ? 'copy' : 'move');
    if (entry?.kind !== 'files') return null;
    return { paths: entry.paths, move: entry.accepted?.operation === 'move' };
  }
  const own = activeFileDrag(e);
  return own ? { paths: own.paths, move: !copy } : null;
}

/** Handlers for the wallpaper, and for an icon that isn't a folder (dropping there drops on the wallpaper). */
export function useWallpaper() {
  const icons = useDesktopIcons();
  const areas = useWorkAreas();
  const { toast } = useToast();
  const fail = (title: string, error: unknown) => toast({ title, description: cleanFsError(error), variant: 'destructive' });

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // A drag from the wallpaper never selects text (the layer is select-none),
    // and a click there clears any selection made elsewhere, as a click on
    // the empty desktop does on any other.
    if (e.button === 0) window.getSelection()?.removeAllRanges();
    if (!icons.shown) return;
    if (e.button === 2) icons.setSelected(new Set());
    if (e.button !== 0) return;
    const additive = e.ctrlKey || e.shiftKey || e.metaKey;
    const before = additive ? new Set(icons.selected) : new Set<string>();
    if (!additive) icons.setSelected(new Set());
    icons.setRenaming(null);
    const start = toWorkspace(e.clientX, e.clientY);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const at = toWorkspace(ev.clientX, ev.clientY);
      const rect = {
        left: Math.min(start.x, at.x),
        top: Math.min(start.y, at.y),
        width: Math.abs(at.x - start.x),
        height: Math.abs(at.y - start.y),
      };
      if (rect.width < 4 && rect.height < 4) return;
      setBand(rect);
      const inside = new Set(before);
      for (const [name, p] of icons.places) if (rectsOverlap(rect, p.rect)) inside.add(name);
      icons.setSelected(inside);
    };
    const up = () => {
      setBand(null);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!icons.shown || !takes(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(ICONS_MIME) || !e.ctrlKey ? 'move' : 'copy';
    const drag = moving.get();
    if (!drag || !e.dataTransfer.types.includes(ICONS_MIME)) return;
    const { x, y } = toWorkspace(e.clientX, e.clientY);
    const next = iconMoves(icons, areas, drag, x, y);
    if (!next) return;
    const shown = preview.get();
    if (shown?.key === next.key) return holdPreview(shown);
    // Only the cells an icon would move to; where they are already shows them.
    const rects = icons.resolve(next.moves)
      .filter((p) => {
        const now = icons.places.get(p.name);
        return !now || now.area.id !== p.area.id || now.col !== p.col || now.row !== p.row;
      })
      .map((p) => p.rect);
    holdPreview({ key: next.key, rects });
  };

  const onDrop = (e: React.DragEvent) => {
    if (!icons.shown || !takes(e)) return;
    e.preventDefault();
    const { x, y } = toWorkspace(e.clientX, e.clientY);
    const types = e.dataTransfer.types;

    const drag = moving.get();
    if (types.includes(ICONS_MIME) && drag) {
      clearPreview();
      const next = iconMoves(icons, areas, drag, x, y);
      if (next) icons.place(next.moves);
      return;
    }

    const at = cellUnder(icons, areas, x, y);
    if (types.includes(APP_MIME)) {
      const appId = e.dataTransfer.getData(APP_MIME);
      if (appId) void icons.addApp(appId, at).catch((error: unknown) => fail('Couldn’t add the app to the desktop', error));
      return;
    }
    const files = droppedFiles(e);
    if (files) {
      void icons.addPaths(files.paths, { move: files.move, at })
        .catch((error: unknown) => fail(`Couldn’t ${files.move ? 'move' : 'copy'} to the desktop`, error));
    }
  };

  return { onPointerDown, onDragOver, onDrop };
}

/** A folder icon takes files and icons dropped on it, moving them in (Ctrl copies). */
export function useFolderDrop(folder: string) {
  const icons = useDesktopIcons();
  const { toast } = useToast();
  const dir = icons.dir;
  const path = dir ? joinPath(dir, folder) : null;

  const accepts = (e: React.DragEvent) => {
    if (!path || !takes(e) || e.dataTransfer.types.includes(APP_MIME)) return false;
    // A folder can't take itself.
    if (e.dataTransfer.types.includes(ICONS_MIME)) {
      const drag = moving.get();
      return !!drag && !drag.names.includes(folder);
    }
    return !(activeFileDrag(e)?.paths.includes(path) ?? false);
  };
  return {
    accepts,
    onDrop: async (e: React.DragEvent) => {
      if (!path || !accepts(e)) return false;
      e.preventDefault();
      e.stopPropagation();
      const files = droppedFiles(e);
      const fs = getFsBridge();
      if (!files || !fs) return true;
      try {
        for (const p of files.paths) await (files.move ? fs.moveInto(p, path) : fs.copyInto(p, path));
      } catch (error) {
        toast({ title: `Couldn’t ${files.move ? 'move' : 'copy'} into ${folder}`, description: cleanFsError(error), variant: 'destructive' });
      }
      void icons.reload();
      return true;
    },
  };
}
