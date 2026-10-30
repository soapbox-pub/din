import { useCallback, useEffect, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
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
import { contains } from '@/lib/monitors';
import { builtinWidget, getWidgetsBridge, grantedDomains, WIDGET_SIZES, widgetTitle, type PlacedWidget } from '@/lib/widgets';
import { DOMAIN_LABELS } from './domainLabels';
import { WidgetFrame } from './WidgetFrame';
import { WidgetGallery } from './WidgetGallery';

/** The grid widgets snap to. */
const GRID = 8;

/**
 * The desktop's widgets, over the wallpaper and under every window, each on
 * the monitor it was put on.
 */
export function WidgetLayer() {
  const { widgets, editing, setEditing, move, remove } = useWidgets();
  const areas = useWorkAreas();
  const [about, setAbout] = useState<PlacedWidget | null>(null);
  const [removing, setRemoving] = useState<PlacedWidget | null>(null);

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
    // A webview's menu point is the embedder's (the shell's), not the
    // guest's; taken as either, whichever lands on the widget.
    const rect = trigger.getBoundingClientRect();
    const inside = (px: number, py: number) => px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
    const [clientX, clientY] = inside(x, y)
      ? [x, y]
      : inside(rect.left + x, rect.top + y)
        ? [rect.left + x, rect.top + y]
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
  const place = (w: PlacedWidget) => {
    const area = areas.find((a) => a.id === w.monitor) ?? primary;
    if (!area) return { left: w.x, top: w.y };
    const { width, height } = WIDGET_SIZES[w.size];
    return {
      left: area.x + Math.max(0, Math.min(w.x, area.width - width)),
      top: area.y + Math.max(0, Math.min(w.y, area.height - height)),
    };
  };

  // Dropped: onto whichever monitor holds its middle, on the grid, inside it.
  const onDrop = (w: PlacedWidget, left: number, top: number) => {
    const { width, height } = WIDGET_SIZES[w.size];
    const area = areas.find((a) => contains(a, left + width / 2, top + height / 2)) ?? areas.find((a) => a.id === w.monitor) ?? primary;
    if (!area) return;
    const snap = (v: number, max: number) => Math.max(0, Math.min(Math.round(v / GRID) * GRID, max));
    move(w.id, area.id, snap(left - area.x, area.width - width), snap(top - area.y, area.height - height));
  };

  // Removing a widget that keeps things (a note's text) asks first.
  const askRemove = (w: PlacedWidget) => {
    if (grantedDomains(w.source).includes('storage')) setRemoving(w);
    else remove(w.id);
  };

  return (
    <div className="pointer-events-none absolute inset-0" aria-label="Widgets">
      {widgets.map((w) => (
        <WidgetFrame
          key={w.id}
          widget={w}
          {...place(w)}
          onDrop={onDrop}
          onGuest={onGuest}
          onAbout={setAbout}
          onRemove={askRemove}
        />
      ))}
      {editing && primary && (
        <div className="pointer-events-auto absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-foreground/10 bg-background/80 p-1 pl-4 shadow-lg backdrop-blur-xl" style={{ top: primary.y + GRID * 2 }}>
          <span className="text-sm text-muted-foreground">Drag widgets to arrange them</span>
          <Button size="sm" className="rounded-full" onClick={() => setEditing(false)}>
            Done
          </Button>
        </div>
      )}
      <WidgetGallery />
      <AboutWidget widget={about} onClose={() => setAbout(null)} />
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

function AboutWidget({ widget, onClose }: { widget: PlacedWidget | null; onClose: () => void }) {
  const source = widget?.source;
  const pubkey = source?.type === 'napplet' ? source.pubkey : undefined;
  const author = useAuthor(pubkey);
  const authorName = pubkey
    ? author.data?.metadata?.display_name || author.data?.metadata?.name || `${nip19.npubEncode(pubkey).slice(0, 16)}…`
    : 'Din';
  const description = source?.type === 'builtin' ? builtinWidget(source.id)?.description : source?.description;
  const domains = source ? grantedDomains(source).filter((d) => d !== 'shell') : [];

  return (
    <Dialog open={widget !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{source ? widgetTitle(source) : ''}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{description}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Made by</dt>
          <dd className="min-w-0 truncate">{authorName}</dd>
          <dt className="text-muted-foreground">It can</dt>
          <dd>
            {domains.length === 0 ? (
              'Only show itself'
            ) : (
              <ul className="space-y-1">
                {domains.map((d) => <li key={d}>{DOMAIN_LABELS[d]}</li>)}
              </ul>
            )}
          </dd>
          {source?.type === 'napplet' && source.source && (
            <>
              <dt className="text-muted-foreground">Source</dt>
              <dd className="min-w-0 break-all select-text">{source.source}</dd>
            </>
          )}
          {source?.type === 'napplet' && (
            <>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="min-w-0 truncate font-mono text-xs leading-5 select-text">{source.sha256.slice(0, 16)}</dd>
            </>
          )}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
