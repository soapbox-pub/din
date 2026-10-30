import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, RotateCw, X } from 'lucide-react';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { GuestSurface, type GuestSurfaceHandle } from '@/platform/GuestSurface';
import { guestsAvailable } from '@/platform/guest';
import { APP_BLOSSOM_SERVERS } from '@/lib/appBlossom';
import { getWidgetsBridge, parseFileWidget, spanPixels, WIDGET_MIN_SPAN, WIDGETS_PARTITION, widgetTitle, widgetUrl, type PlacedWidget } from '@/lib/widgets';
import { useWidgets } from '@/contexts/WidgetsContext';
import { cn } from '@/lib/utils';
import { useNappletHost } from './useNappletHost';
import { WidgetMenuContent, type WidgetMenuActions } from './WidgetMenu';

export interface WidgetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface WidgetFrameProps {
  widget: PlacedWidget;
  /** Where it is in the workspace, on its cells. */
  rect: WidgetRect;
  /** Being dragged or resized in edit mode: where it is now, unsnapped. */
  onArrange: (widget: PlacedWidget, rect: WidgetRect, resizing: boolean) => void;
  /** Let go: where it was left, unsnapped, or null if it didn't move. */
  onArrangeEnd: (widget: PlacedWidget, rect: WidgetRect | null, resizing: boolean) => void;
  /** Hand the layer this widget's guest and trigger, for right-clicks main forwards. */
  onGuest: (webContentsId: number, trigger: HTMLElement | null) => void;
  onAbout: (widget: PlacedWidget) => void;
  /** Share a folder's widget on Nostr. */
  onPublish: (widget: PlacedWidget) => void;
  onRemove: (widget: PlacedWidget) => void;
}

/** Which edges a gesture moves: -1 the left or top, 1 the right or bottom; both 0 drags the whole widget. */
type Edges = { h: -1 | 0 | 1; v: -1 | 0 | 1 };

const HANDLES: { edges: Edges; label: string; className: string }[] = [
  { edges: { h: 0, v: -1 }, label: 'top', className: 'left-1/2 top-0 cursor-ns-resize' },
  { edges: { h: 1, v: 0 }, label: 'right', className: 'left-full top-1/2 cursor-ew-resize' },
  { edges: { h: 0, v: 1 }, label: 'bottom', className: 'left-1/2 top-full cursor-ns-resize' },
  { edges: { h: -1, v: 0 }, label: 'left', className: 'left-0 top-1/2 cursor-ew-resize' },
];

/** A gesture's rectangle: the edges it moves, by the pointer's travel, no smaller than the smallest widget. */
function gestureRect(base: WidgetRect, edges: Edges, dx: number, dy: number): WidgetRect {
  if (edges.h === 0 && edges.v === 0) return { ...base, left: base.left + dx, top: base.top + dy };
  const min = spanPixels({ cols: WIDGET_MIN_SPAN, rows: WIDGET_MIN_SPAN });
  const width = edges.h === 0 ? base.width : Math.max(min.width, base.width + edges.h * dx);
  const height = edges.v === 0 ? base.height : Math.max(min.height, base.height + edges.v * dy);
  return {
    left: edges.h < 0 ? base.left + base.width - width : base.left,
    top: edges.v < 0 ? base.top + base.height - height : base.top,
    width,
    height,
  };
}

/** What went wrong in main, without Electron's wrapping. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
}

/**
 * One widget on the desktop: its guest and its menu. Din draws nothing
 * behind it: a widget is as transparent as its own page, cut to rounded
 * corners.
 */
export function WidgetFrame({ widget, rect, onArrange, onArrangeEnd, onGuest, onAbout, onPublish, onRemove }: WidgetFrameProps) {
  const { editing, setEditing, resize, refresh } = useWidgets();
  const surface = useRef<GuestSurfaceHandle>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const [webContentsId, setWebContentsId] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [generation, setGeneration] = useState(0);
  // A widget from Nostr loads once main has its bytes, verified; one from a
  // folder once main serves the folder.
  const [fetched, setFetched] = useState(widget.source.type === 'builtin');
  const [gesture, setGesture] = useState<{ rect: WidgetRect; resizing: boolean } | null>(null);
  const title = widgetTitle(widget.source);

  useNappletHost(webContentsId, widget, setFailed);

  const source = widget.source;
  useEffect(() => {
    if (source.type !== 'napplet' || !guestsAvailable()) return;
    let cancelled = false;
    const bridge = getWidgetsBridge();
    if (!bridge) return;
    bridge.fetch(source.sha256, [...source.servers, ...APP_BLOSSOM_SERVERS.servers]).then(
      () => !cancelled && setFetched(true),
      (error: unknown) => !cancelled && setFailed(errorText(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [source, generation]);

  // A folder's widget: its page read afresh (and its metadata with it) on
  // every load, and loaded again whenever a file in the folder changes.
  const folder = source.type === 'file' ? source.path : null;
  const folderHost = source.type === 'file' ? source.host : null;
  useEffect(() => {
    const bridge = getWidgetsBridge();
    if (folder === null || !bridge || !guestsAvailable()) return;
    let cancelled = false;
    bridge.folder(folder).then(
      (opened) => {
        if (cancelled) return;
        refresh(widget.id, parseFileWidget(opened));
        setFetched(true);
      },
      (error: unknown) => !cancelled && setFailed(errorText(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [folder, widget.id, refresh, generation]);

  useEffect(() => {
    if (folderHost === null) return;
    return getWidgetsBridge()?.onFolderChanged(({ host }) => {
      if (host !== folderHost) return;
      setFailed(null);
      setGone(false);
      setFetched(false);
      setWebContentsId(null);
      setGeneration((g) => g + 1);
    });
  }, [folderHost]);

  useEffect(() => {
    if (webContentsId !== null) onGuest(webContentsId, trigger.current);
  }, [webContentsId, onGuest]);

  const reload = () => {
    setFailed(null);
    // A folder's widget reads its folder again, metadata and all.
    if (gone || !surface.current || source.type === 'file') {
      setGone(false);
      if (source.type === 'file') setFetched(false);
      setWebContentsId(null);
      setGeneration((g) => g + 1);
    } else {
      surface.current.reload();
    }
  };

  const actions: WidgetMenuActions = {
    editing,
    setEditing,
    resize: (size) => resize(widget.id, size),
    reload,
    about: () => onAbout(widget),
    publish: widget.source.type === 'file' ? () => onPublish(widget) : undefined,
    remove: () => onRemove(widget),
  };

  // Edit mode: dragged by anywhere, or resized by a handle on an edge; the
  // layer snaps it to the grid when it's let go.
  const startGesture = (event: ReactPointerEvent<HTMLElement>, edges: Edges) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    const base = rect;
    const resizing = edges.h !== 0 || edges.v !== 0;
    let last: WidgetRect | null = null;
    const move = (e: PointerEvent) => {
      last = gestureRect(base, edges, e.clientX - start.x, e.clientY - start.y);
      setGesture({ rect: last, resizing });
      onArrange(widget, last, resizing);
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      setGesture(null);
      onArrangeEnd(widget, last, resizing);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  const ready = fetched && !failed && !gone && guestsAvailable();
  const shown = gesture?.rect ?? rect;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={trigger}
          role="group"
          aria-label={title}
          className={cn(
            'pointer-events-auto absolute overflow-visible rounded-3xl',
            gesture
              ? cn('z-10', !gesture.resizing && 'cursor-grabbing')
              : 'motion-safe:transition-[left,top,width,height] motion-safe:duration-150',
          )}
          style={shown}
        >
          <div
            className={cn(
              'relative h-full w-full rounded-3xl',
              editing && 'bg-white/5 outline-2 outline-offset-2 outline-white/50 outline-dashed',
            )}
          >
            {ready ? (
              <GuestSurface
                key={`${generation}:${(widget.denied ?? []).join()}`}
                ref={surface}
                src={widgetUrl(widget.source)}
                partition={WIDGETS_PARTITION}
                className="relative h-full w-full overflow-hidden rounded-3xl"
                onAttach={setWebContentsId}
                onGone={() => setGone(true)}
              />
            ) : (
              <WidgetStatus title={title} failed={failed ?? (gone ? 'This widget stopped.' : null)} unavailable={!guestsAvailable()} onRetry={reload} />
            )}
            {editing && (
              <div
                aria-hidden
                className={cn('absolute inset-0', gesture && !gesture.resizing ? 'cursor-grabbing' : 'cursor-grab')}
                onPointerDown={(e) => startGesture(e, { h: 0, v: 0 })}
              />
            )}
          </div>
          {editing && HANDLES.map(({ edges, label, className }) => (
            <div
              key={label}
              aria-hidden
              title={`Resize from the ${label}`}
              className={cn('absolute grid size-6 -translate-1/2 touch-none place-items-center', className)}
              onPointerDown={(e) => startGesture(e, edges)}
            >
              <span className="size-3 rounded-full border-2 border-white bg-primary shadow-md" />
            </div>
          ))}
          {editing && (
            <button
              type="button"
              aria-label={`Remove ${title}`}
              className="absolute -top-2 -left-2 grid size-6 place-items-center rounded-full border border-foreground/15 bg-background text-foreground shadow-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => onRemove(widget)}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <WidgetMenuContent widget={widget} actions={actions} />
    </ContextMenu>
  );
}

/** What shows instead of a widget's page: on a card of Din's own, since there's no page to draw one. */
function WidgetStatus({ title, failed, unavailable, onRetry }: { title: string; failed: string | null; unavailable: boolean; onRetry: () => void }) {
  return (
    <div className="h-full w-full overflow-hidden rounded-3xl border border-foreground/10 bg-background/70 text-foreground backdrop-blur-xl">
      <WidgetStatusBody title={title} failed={failed} unavailable={unavailable} onRetry={onRetry} />
    </div>
  );
}

function WidgetStatusBody({ title, failed, unavailable, onRetry }: { title: string; failed: string | null; unavailable: boolean; onRetry: () => void }) {
  if (unavailable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">Widgets run in Din's desktop app.</p>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <AlertTriangle className="size-5 text-muted-foreground" aria-hidden />
        <p className="line-clamp-3 text-xs text-muted-foreground">{failed}</p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <RotateCw className="size-3" aria-hidden /> Try Again
        </button>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col justify-center gap-2 p-4" aria-label={`Loading ${title}`}>
      <div className="h-4 w-2/3 animate-pulse rounded bg-foreground/10" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-foreground/10" />
    </div>
  );
}
