import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, RotateCw, X } from 'lucide-react';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { GuestSurface, type GuestSurfaceHandle } from '@/platform/GuestSurface';
import { guestsAvailable } from '@/platform/guest';
import { APP_BLOSSOM_SERVERS } from '@/lib/appBlossom';
import { getWidgetsBridge, WIDGET_SIZES, WIDGETS_PARTITION, widgetTitle, widgetUrl, type PlacedWidget } from '@/lib/widgets';
import { useWidgets } from '@/contexts/WidgetsContext';
import { cn } from '@/lib/utils';
import { useNappletHost } from './useNappletHost';
import { WidgetMenuContent, type WidgetMenuActions } from './WidgetMenu';

interface WidgetFrameProps {
  widget: PlacedWidget;
  /** Where it is in the workspace. */
  left: number;
  top: number;
  /** Where it was dropped, in the workspace, after a drag in edit mode. */
  onDrop: (widget: PlacedWidget, left: number, top: number) => void;
  /** Hand the layer this widget's guest and trigger, for right-clicks main forwards. */
  onGuest: (webContentsId: number, trigger: HTMLElement | null) => void;
  onAbout: (widget: PlacedWidget) => void;
  onRemove: (widget: PlacedWidget) => void;
}

/**
 * One widget on the desktop: its guest and its menu. Din draws nothing
 * behind it: a widget is as transparent as its own page.
 */
export function WidgetFrame({ widget, left, top, onDrop, onGuest, onAbout, onRemove }: WidgetFrameProps) {
  const { editing, setEditing, resize } = useWidgets();
  const surface = useRef<GuestSurfaceHandle>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const [webContentsId, setWebContentsId] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [generation, setGeneration] = useState(0);
  // A widget from Nostr loads once main has its bytes, verified.
  const [fetched, setFetched] = useState(widget.source.type === 'builtin');
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const title = widgetTitle(widget.source);
  const { width, height } = WIDGET_SIZES[widget.size];

  useNappletHost(webContentsId, widget, setFailed);

  const source = widget.source;
  useEffect(() => {
    if (source.type !== 'napplet' || !guestsAvailable()) return;
    let cancelled = false;
    const bridge = getWidgetsBridge();
    if (!bridge) return;
    bridge.fetch(source.sha256, [...source.servers, ...APP_BLOSSOM_SERVERS.servers]).then(
      () => !cancelled && setFetched(true),
      (error: unknown) => !cancelled && setFailed(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [source, generation]);

  useEffect(() => {
    if (webContentsId !== null) onGuest(webContentsId, trigger.current);
  }, [webContentsId, onGuest]);

  const reload = () => {
    setFailed(null);
    if (gone || !surface.current) {
      setGone(false);
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
    remove: () => onRemove(widget),
  };

  // Edit mode: dragged by anywhere, snapping to the 8px grid on the way down.
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    let last = { dx: 0, dy: 0 };
    const move = (e: PointerEvent) => {
      last = { dx: e.clientX - start.x, dy: e.clientY - start.y };
      setDrag(last);
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      setDrag(null);
      if (last.dx !== 0 || last.dy !== 0) onDrop(widget, left + last.dx, top + last.dy);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  const ready = fetched && !failed && !gone && guestsAvailable();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={trigger}
          role="group"
          aria-label={title}
          className={cn(
            'pointer-events-auto absolute overflow-visible rounded-3xl',
            drag ? 'z-10 cursor-grabbing' : 'motion-safe:transition-[left,top] motion-safe:duration-150',
          )}
          style={{
            left: left + (drag?.dx ?? 0),
            top: top + (drag?.dy ?? 0),
            width,
            height,
          }}
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
                className="relative h-full w-full"
                onAttach={setWebContentsId}
                onGone={() => setGone(true)}
              />
            ) : (
              <WidgetStatus title={title} failed={failed ?? (gone ? 'This widget stopped.' : null)} unavailable={!guestsAvailable()} onRetry={reload} />
            )}
            {editing && (
              <div
                aria-hidden
                className={cn('absolute inset-0', drag ? 'cursor-grabbing' : 'cursor-grab')}
                onPointerDown={startDrag}
              />
            )}
          </div>
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
