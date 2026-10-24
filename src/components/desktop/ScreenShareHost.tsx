import { memo, useEffect, useState } from 'react';
import { AppWindow, Monitor, MonitorUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import {
  displayHost,
  getScreenShareBridge,
  type ActiveScreenShare,
  type ScreenShareRequest,
  type ScreenShareSource,
} from '@/lib/screenShare';
import { cn } from '@/lib/utils';

/**
 * Desktop-lifetime host for web pages asking to share the screen
 * (getDisplayMedia, see electron/screen-share.mts): the user picks the entire
 * screen or one window, or cancels. One pick at a time; dismissing refuses.
 *
 * Renders nothing outside the Electron shell.
 */
export function ScreenSharePicker() {
  const [queue, setQueue] = useState<ScreenShareRequest[]>([]);

  useEffect(() => {
    const bridge = getScreenShareBridge();
    if (!bridge) return;
    const offPick = bridge.onPick((request) => setQueue((q) => [...q, request]));
    const offCancel = bridge.onCancel((requestId) =>
      setQueue((q) => q.filter((r) => r.requestId !== requestId)),
    );
    return () => {
      offPick();
      offCancel();
    };
  }, []);

  const current = queue[0] ?? null;

  const answer = (sourceId: string | null, audio: boolean) => {
    if (!current) return;
    getScreenShareBridge()?.choose({ requestId: current.requestId, sourceId, audio });
    setQueue((q) => q.filter((r) => r.requestId !== current.requestId));
  };

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) answer(null, false);
      }}
    >
      {current && <PickerContent key={current.requestId} request={current} onAnswer={answer} />}
    </Dialog>
  );
}

function PickerContent({
  request,
  onAnswer,
}: {
  request: ScreenShareRequest;
  onAnswer: (sourceId: string | null, audio: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState(request.sources[0]?.id ?? null);
  const [audio, setAudio] = useState(true);
  const host = displayHost(request.origin);
  const selected = request.sources.find((s) => s.id === selectedId) ?? null;
  const screens = request.sources.filter((s) => s.kind === 'screen');
  const windows = request.sources.filter((s) => s.kind === 'window');
  const withAudio = request.audioRequested && selected?.kind === 'window' && audio;

  const share = (source: ScreenShareSource | null) => {
    if (!source) return;
    onAnswer(source.id, request.audioRequested && source.kind === 'window' && audio);
  };

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle className="break-all">{host} wants to share your screen</DialogTitle>
        <DialogDescription>
          Choose what it can see. It keeps seeing it until you stop sharing from the menu bar.
        </DialogDescription>
      </DialogHeader>

      <div role="radiogroup" aria-label="What to share" className="-mx-1 max-h-[60vh] space-y-4 overflow-y-auto px-1 py-1">
        {screens.length > 0 && (
          <SourceSection title="Screen" sources={screens} selectedId={selectedId} onSelect={setSelectedId} onShare={share} />
        )}
        {windows.length > 0 ? (
          <SourceSection title="Windows" sources={windows} selectedId={selectedId} onSelect={setSelectedId} onShare={share} />
        ) : (
          <p className="text-sm text-muted-foreground">Web pages you open show up here to share on their own.</p>
        )}
      </div>

      {request.audioRequested && (
        <div className="flex items-center justify-between gap-4 rounded-lg bg-secondary/60 px-3 py-2">
          <Label htmlFor="screen-share-audio" className={cn('text-sm', selected?.kind !== 'window' && 'text-muted-foreground')}>
            {selected?.kind === 'window' ? 'Also share this window’s sound' : 'Sound can only be shared with a window'}
          </Label>
          <Switch
            id="screen-share-audio"
            checked={withAudio}
            disabled={selected?.kind !== 'window'}
            onCheckedChange={setAudio}
          />
        </div>
      )}

      <DialogFooter>
        <Button variant="secondary" onClick={() => onAnswer(null, false)}>
          Cancel
        </Button>
        <Button disabled={!selected} onClick={() => share(selected)}>
          Share
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function SourceSection({
  title,
  sources,
  selectedId,
  onSelect,
  onShare,
}: {
  title: string;
  sources: ScreenShareSource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onShare: (source: ScreenShareSource) => void;
}) {
  return (
    <section aria-label={title}>
      <h3 className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {sources.map((source) => {
          const checked = source.id === selectedId;
          const Icon = source.kind === 'screen' ? Monitor : AppWindow;
          return (
            <button
              key={source.id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onSelect(source.id)}
              onDoubleClick={() => onShare(source)}
              className={cn(
                'flex min-w-0 flex-col gap-2 rounded-lg border p-2 text-left transition-colors',
                'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                checked ? 'border-primary bg-primary/10' : 'border-border',
              )}
            >
              <span className="grid aspect-video w-full place-items-center overflow-hidden rounded-md bg-muted">
                {source.thumbnail ? (
                  <img src={source.thumbnail} alt="" className="size-full object-contain" />
                ) : (
                  <Icon className="size-8 text-muted-foreground" aria-hidden />
                )}
              </span>
              <span className="min-w-0 px-1">
                <span className="block truncate text-sm font-medium">{source.title}</span>
                {source.subtitle && (
                  <span className="block truncate text-xs text-muted-foreground">{source.subtitle}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The shares running, kept current from main. */
function useScreenShares(): ActiveScreenShare[] {
  const [shares, setShares] = useState<ActiveScreenShare[]>([]);
  useEffect(() => {
    const bridge = getScreenShareBridge();
    if (!bridge) return;
    let live = true;
    const off = bridge.onActive((next) => setShares(next));
    bridge.list().then((list) => live && setShares(list), () => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  return shares;
}

function describeShare(share: ActiveScreenShare): string {
  const what = share.kind === 'screen' ? 'your entire screen' : `“${share.title}”`;
  return `${displayHost(share.origin)} is sharing ${what}${share.audio ? ' and its sound' : ''}`;
}

/**
 * The menu bar's sign that a page is sharing the screen, there only while one
 * is. Its panel says who sees what, and stops it.
 */
export const ScreenShareMenuItem = memo(function ScreenShareMenuItem() {
  const shares = useScreenShares();
  const [open, setOpen] = useState(false);

  if (shares.length === 0) return null;
  const label = shares.length === 1 ? describeShare(shares[0]) : `${shares.length} pages are sharing your screen`;

  const stop = (id: string) => {
    getScreenShareBridge()?.stop(id).catch(() => {});
    if (shares.length === 1) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          className="size-7 rounded-md bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive"
        >
          <MonitorUp className="size-4.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-80 p-0">
        <div className="border-b border-border/60 px-4 py-2.5">
          <p className="text-sm font-semibold">Screen sharing</p>
        </div>
        <ul className="divide-y divide-border/60">
          {shares.map((share) => (
            <li key={share.id} className="flex items-center gap-3 px-4 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary">
                {share.kind === 'screen' ? (
                  <Monitor className="size-4 text-muted-foreground" aria-hidden />
                ) : (
                  <AppWindow className="size-4 text-muted-foreground" aria-hidden />
                )}
              </span>
              <p className="min-w-0 flex-1 break-words text-sm">{describeShare(share)}</p>
              <Button size="sm" variant="destructive" onClick={() => stop(share.id)}>
                Stop
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
});
