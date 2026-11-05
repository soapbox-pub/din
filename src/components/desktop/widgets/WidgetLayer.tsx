import { useCallback, useEffect, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { Share } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useWidgets } from '@/contexts/WidgetsContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { useAuthor } from '@/hooks/useAuthor';
import { areaAt, getMonitorsBridge } from '@/lib/monitors';
import { cn } from '@/lib/utils';
import { areaGrid, cellsFree, cellsRect, clampCells, nearestCells, placedCells, type Cells } from '@/lib/widgetGrid';
import {
  builtinWidget,
  declaredDomains,
  getWidgetsBridge,
  grantedDomains,
  isPermissionDomain,
  widgetDescription,
  widgetTitle,
  type PlacedWidget,
} from '@/lib/widgets';
import { BuiltinIcon, NappletIcon, PermissionRow } from './permissions';
import { PublishWidget } from './PublishWidget';
import { WidgetFrame, type WidgetRect } from './WidgetFrame';
import { WidgetGallery } from './WidgetGallery';
import { WidgetOffers } from './WidgetOffers';

/** The Done bar's distance from the top of the screen. */
const BAR_TOP = 16;

/**
 * The desktop's widgets, over the wallpaper and under every window, each on
 * the monitor it was put on.
 */
export function WidgetLayer() {
  const { widgets, editing, setEditing, place, remove } = useWidgets();
  const areas = useWorkAreas();
  const [aboutId, setAboutId] = useState<string | null>(null);
  const about = widgets.find((w) => w.id === aboutId) ?? null;
  const [removing, setRemoving] = useState<PlacedWidget | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const publishing = widgets.find((w) => w.id === publishingId)?.source;

  // Right-clicks main forwards from a widget's page open that widget's menu
  // where they happened.
  const triggers = useRef(new Map<number, HTMLElement>());
  const onGuest = useCallback((webContentsId: number, trigger: HTMLElement | null) => {
    if (trigger) triggers.current.set(webContentsId, trigger);
    else triggers.current.delete(webContentsId);
  }, []);
  useEffect(() => getWidgetsBridge()?.onContextMenu(({ webContentsId, x, y }) => {
    const trigger = triggers.current.get(webContentsId);
    if (!trigger?.isConnected) return;
    // A webview's menu point is in the shell window's pixels, which the
    // interface zoom makes larger than the desktop's CSS ones.
    const zoom = getMonitorsBridge()?.zoomFactor() ?? 1;
    const rect = trigger.getBoundingClientRect();
    const inside = (px: number, py: number) => px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
    const [clientX, clientY] = inside(x / zoom, y / zoom)
      ? [x / zoom, y / zoom]
      : [rect.left + rect.width / 2, rect.top + rect.height / 2];
    trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
  }), []);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, setEditing]);

  const primary = areas.find((a) => a.primary) ?? areas[0];

  // Where a widget being arranged would land: on whichever monitor holds its
  // middle when dragged (its own when resized), on the nearest cells there.
  const [target, setTarget] = useState<{ id: string; monitor: string; cells: Cells; free: boolean } | null>(null);
  const targetFor = (w: PlacedWidget, rect: WidgetRect, resizing: boolean) => {
    const placed = placedCells(areas, w);
    if (!placed) return null;
    const area = (resizing ? null : areaAt(areas, rect.left + rect.width / 2, rect.top + rect.height / 2)) ?? placed.area;
    const grid = areaGrid(area);
    const cells = clampCells(grid, nearestCells(grid, rect));
    return { id: w.id, monitor: area.id, cells, free: cellsFree(areas, widgets, area.id, cells, w.id) };
  };
  const onArrange = (w: PlacedWidget, rect: WidgetRect, resizing: boolean) => {
    const next = targetFor(w, rect, resizing);
    setTarget((prev) =>
      next && prev && prev.id === next.id && prev.monitor === next.monitor && prev.free === next.free &&
      prev.cells.col === next.cells.col && prev.cells.row === next.cells.row && prev.cells.cols === next.cells.cols && prev.cells.rows === next.cells.rows
        ? prev
        : next);
  };
  // Let go: there, if those cells are free; otherwise back where it was.
  const onArrangeEnd = (w: PlacedWidget, rect: WidgetRect | null, resizing: boolean) => {
    setTarget(null);
    const next = rect && targetFor(w, rect, resizing);
    if (next?.free) place(w.id, next.monitor, next.cells);
  };
  const targetArea = target && areas.find((a) => a.id === target.monitor);

  // Removing a widget that keeps things (a note's text) asks first.
  const askRemove = (w: PlacedWidget) => {
    if (grantedDomains(w.source, w.denied).includes('storage')) setRemoving(w);
    else remove(w.id);
  };

  return (
    <div role="group" className="pointer-events-none absolute inset-0" aria-label="Widgets">
      {targetArea && target && (
        <div
          aria-hidden
          className={cn(
            'absolute rounded-3xl border-2 motion-safe:transition-[left,top,width,height] motion-safe:duration-100',
            target.free ? 'border-white/70 bg-white/15' : 'border-red-400/80 bg-red-500/15',
          )}
          style={cellsRect(areaGrid(targetArea), target.cells)}
        />
      )}
      {widgets.map((w) => {
        const placed = placedCells(areas, w);
        if (!placed) return null;
        return (
        <WidgetFrame
          key={w.id}
          widget={w}
          rect={cellsRect(areaGrid(placed.area), placed.cells)}
          onArrange={onArrange}
          onArrangeEnd={onArrangeEnd}
          onGuest={onGuest}
          onAbout={(widget) => setAboutId(widget.id)}
          onPublish={(widget) => setPublishingId(widget.id)}
          onRemove={askRemove}
        />
        );
      })}
      {editing && primary && (
        <div className="pointer-events-auto absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 glass-surface rounded-full p-1 pl-4" style={{ top: primary.y + BAR_TOP }}>
          <span className="text-sm text-muted-foreground">Drag widgets to arrange them, or their edges to resize them</span>
          <Button size="sm" className="rounded-full" onClick={() => setEditing(false)}>
            Done
          </Button>
        </div>
      )}
      <WidgetGallery />
      <WidgetOffers />
      <AboutWidget
        widget={about}
        onClose={() => setAboutId(null)}
        onPublish={(widget) => {
          setAboutId(null);
          setPublishingId(widget.id);
        }}
      />
      <PublishWidget source={publishing?.type === 'file' ? publishing : null} onClose={() => setPublishingId(null)} />
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing ? widgetTitle(removing.source) : 'widget'}?</AlertDialogTitle>
            <AlertDialogDescription>What this widget keeps on this computer goes with it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) remove(removing.id);
                setRemoving(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** About This Widget: who made it, and its permissions, which can be turned off and on. */
function AboutWidget({ widget, onClose, onPublish }: { widget: PlacedWidget | null; onClose: () => void; onPublish: (widget: PlacedWidget) => void }) {
  const { setDenied } = useWidgets();
  const source = widget?.source;
  const pubkey = source?.type === 'napplet' ? source.pubkey : undefined;
  const author = useAuthor(pubkey);
  const authorName = pubkey
    ? author.data?.metadata?.display_name || author.data?.metadata?.name || `${nip19.npubEncode(pubkey).slice(0, 16)}…`
    : 'Din';
  const manifest = source?.type === 'builtin' ? builtinWidget(source.id) : undefined;
  const description = source ? widgetDescription(source) : '';
  const asked = source ? declaredDomains(source).filter(isPermissionDomain) : [];
  const denied = widget?.denied ?? [];

  return (
    <Dialog open={widget !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="items-center text-center sm:text-center">
          {source && source.type !== 'builtin' ? (
            <NappletIcon source={source} className="size-16 text-2xl" />
          ) : (
            <span className="grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-primary/25 to-primary/5 text-primary">
              <BuiltinIcon name={manifest?.icon ?? ''} className="size-8" />
            </span>
          )}
          <DialogTitle className="text-xl">{source ? widgetTitle(source) : ''}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {source?.type === 'file' ? <>From <span className="break-all select-text">{source.path}</span></> : <>by {authorName}</>}
          </p>
          <DialogDescription className="whitespace-pre-line">{description}</DialogDescription>
        </DialogHeader>
        <div className="rounded-2xl border px-4">
          {asked.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">This widget uses no special permissions.</p>
          ) : (
            <div className="divide-y">
              <p className="py-3 text-sm font-medium text-muted-foreground">Permissions</p>
              {asked.map((domain) => (
                <PermissionRow
                  key={domain}
                  domain={domain}
                  allowed={!denied.includes(domain)}
                  required={source && source.type !== 'builtin' ? source.requires.includes(domain) : true}
                  onChange={(allowed) => {
                    if (!widget) return;
                    setDenied(widget.id, allowed ? denied.filter((d) => d !== domain) : [...denied, domain]);
                  }}
                />
              ))}
            </div>
          )}
        </div>
        {source?.type === 'napplet' && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {source.source && (
              <>
                <dt className="text-muted-foreground">Source</dt>
                <dd className="min-w-0 break-all select-text">{source.source}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Version</dt>
            <dd className="min-w-0 truncate font-mono text-xs leading-5 select-text">{source.sha256.slice(0, 16)}</dd>
          </dl>
        )}
        {source?.type === 'file' && widget && (
          <Button variant="secondary" onClick={() => onPublish(widget)}>
            <Share aria-hidden /> Publish to Nostr…
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
