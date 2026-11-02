import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, File, FolderOpen, Laptop, Link2, Smartphone, Tablet, TriangleAlert, X } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Progress } from '@/components/ui/progress';
import { formatBytes } from '@/lib/fs';
import type { QuickShareDeviceType, QuickShareState, QuickShareTransfer } from '@/lib/quickShare';
import { cn } from '@/lib/utils';
import type { Din } from '@/sdk/din';
import { useCloseGuard, useDin, WindowControls, WindowDragRegion } from '@/sdk/react';

/**
 * Quick Share: Android phones and tablets on the same network share files
 * and links here from their share sheet. This computer is visible to them
 * only while this window is open (electron/quickshare.mts ends it when the
 * window goes), the way AirDrop's window and Android's Receive screen work.
 * Each share asks here, with the code the sender's screen shows too, since
 * anyone on the network could be sending; then its progress, then what
 * arrived, all in the window. Closing it while a share is going asks first,
 * and stops the share.
 */
export function QuickShare() {
  const din = useDin();
  const bridge = din.system.quickShare;
  const [state, setState] = useState<QuickShareState | null>(null);
  const [transfers, setTransfers] = useState<QuickShareTransfer[]>([]);
  const [confirmClose, setConfirmClose] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    const offChanged = bridge.onChanged(setState);
    const offTransfer = bridge.onTransfer((t) => {
      setTransfers((list) => {
        const at = list.findIndex((x) => x.id === t.id);
        if (at < 0) return [t, ...list];
        const next = [...list];
        next[at] = t;
        return next;
      });
      if (t.status === 'asking') din.window.focus();
    });
    bridge.receive().then(setState, (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      offChanged();
      offTransfer();
      void bridge.stop().catch(() => {});
    };
  }, [bridge, din]);

  const going = transfers.filter((t) => t.status === 'asking' || t.status === 'receiving');
  useCloseGuard(
    going.length
      ? () => {
          setConfirmClose(true);
          return true;
        }
      : null,
  );

  const dismiss = useCallback((id: string) => setTransfers((list) => list.filter((t) => t.id !== id)), []);
  const act = (promise: Promise<void> | undefined) => void promise?.catch(() => {});

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
        <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-base font-semibold">Quick Share</h1>
        <WindowControls />
      </WindowDragRegion>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
        <Beacon state={state} failure={bridge ? failure : 'Quick Share needs the Din desktop shell.'} compact={transfers.length > 0} />
        {transfers.length > 0 && (
          <ul className="flex flex-col gap-3" aria-label="Shares">
            {transfers.map((t) => (
              <li key={t.id}>
                <ShareCard
                  transfer={t}
                  onRespond={(accept) => act(bridge?.respond(t.id, accept))}
                  onCancel={() => act(bridge?.cancel(t.id))}
                  onDismiss={() => dismiss(t.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop receiving?</AlertDialogTitle>
            <AlertDialogDescription>
              {going.some((t) => t.status === 'receiving')
                ? 'What’s still arriving is stopped, and files that haven’t arrived whole are deleted.'
                : 'What’s waiting for an answer is turned down.'}{' '}
              This computer stops showing up in Quick Share.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep open</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"
              onClick={() => {
                for (const t of going) act(bridge?.cancel(t.id));
                din.window.close();
              }}
            >
              Stop and close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Whether this computer can be seen, with a pulse while it can. */
function Beacon({ state, failure, compact }: { state: QuickShareState | null; failure: string | null; compact: boolean }) {
  const error = failure ?? state?.error ?? null;
  const visible = !error && state?.visible === true;
  return (
    <section
      aria-live="polite"
      className={cn('flex flex-col items-center text-center', compact ? 'gap-2 py-4' : 'flex-1 justify-center gap-6 py-8')}
    >
      <div className={cn('relative flex items-center justify-center', compact ? 'size-16' : 'size-40')}>
        {visible &&
          [0, 1, 2].map((i) => (
            <span
              key={i}
              aria-hidden
              className="absolute inset-0 rounded-full border-2 border-primary/50 motion-safe:animate-[quick-share-pulse_3s_ease-out_infinite] motion-reduce:hidden"
              style={{ animationDelay: `${i}s` }}
            />
          ))}
        <span
          className={cn(
            'relative flex items-center justify-center rounded-full shadow-sm',
            compact ? 'size-12' : 'size-24',
            error ? 'bg-destructive/10 text-destructive' : visible ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {error ? <TriangleAlert className={compact ? 'size-5' : 'size-10'} aria-hidden /> : <Laptop className={compact ? 'size-5' : 'size-10'} aria-hidden />}
        </span>
      </div>
      <div className="flex max-w-xs flex-col gap-1">
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : visible ? (
          <>
            <p className={cn('font-medium', compact ? 'text-sm' : 'text-lg')}>Visible as “{state?.name}”</p>
            {!compact && (
              <p className="text-sm text-muted-foreground">
                On an Android phone or tablet on this Wi-Fi, share something and pick this computer under Quick Share. It stays visible while this window is open.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Getting ready…</p>
        )}
      </div>
      <style>{'@keyframes quick-share-pulse { from { transform: scale(1); opacity: 0.9 } to { transform: scale(1.9); opacity: 0 } }'}</style>
    </section>
  );
}

function DeviceIcon({ type, className }: { type: QuickShareDeviceType; className?: string }) {
  const Icon = type === 'tablet' ? Tablet : type === 'computer' ? Laptop : Smartphone;
  return <Icon className={className} aria-hidden />;
}

/** What a share offered, in a few words. */
function offerSummary(t: QuickShareTransfer): string {
  if (t.offer.text) return t.offer.text.kind === 'url' ? 'a link' : 'some text';
  const files = t.offer.files;
  return files.length === 1 ? files[0].name : `${files.length} files`;
}

function ShareCard({
  transfer: t,
  onRespond,
  onCancel,
  onDismiss,
}: {
  transfer: QuickShareTransfer;
  onRespond: (accept: boolean) => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const over = t.status !== 'asking' && t.status !== 'receiving';
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 shadow-sm">
      <header className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <DeviceIcon type={t.deviceType} className="size-4.5 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{t.device}</h2>
          <p className="text-xs text-muted-foreground">{headline(t)}</p>
        </div>
        {over && (
          <Button variant="ghost" size="icon" className="-mt-1 -mr-2 size-8" aria-label="Remove from the list" title="Remove from the list" onClick={onDismiss}>
            <X className="size-4" />
          </Button>
        )}
      </header>

      {t.status === 'asking' && (
        <>
          <Offer transfer={t} />
          <div className="flex flex-col items-center gap-1 rounded-lg bg-muted/60 py-3">
            <span className="text-xs text-muted-foreground">Check {t.device} shows the same code</span>
            <span className="font-mono text-3xl font-semibold tracking-[0.3em] tabular-nums" aria-label={`Code ${t.pin.split('').join(' ')}`}>
              {t.pin}
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onRespond(false)}>
              Decline
            </Button>
            <Button className="flex-1" onClick={() => onRespond(true)} autoFocus>
              Accept
            </Button>
          </div>
        </>
      )}

      {t.status === 'receiving' && (
        <>
          <Progress value={t.total ? (t.transferred / t.total) * 100 : 0} aria-label={`Receiving ${offerSummary(t)}`} />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {formatBytes(t.transferred)} of {formatBytes(t.total)}
            </span>
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {t.status === 'done' && <Arrived transfer={t} />}
      {(t.status === 'failed' || (t.status === 'done' && t.failed.length > 0)) && (
        <p className="text-xs text-destructive" role="alert">
          {t.status === 'done' ? `${t.failed.length === 1 ? t.failed[0] : `${t.failed.length} files`} didn’t arrive. ` : ''}
          {t.error ?? 'It stopped sending.'}
        </p>
      )}
    </article>
  );
}

function headline(t: QuickShareTransfer): string {
  switch (t.status) {
    case 'asking':
      return `Wants to share ${offerSummary(t)}`;
    case 'receiving':
      return `Receiving ${offerSummary(t)}`;
    case 'done':
      return t.url ? 'Shared a link' : t.files.length === 1 ? 'Shared 1 file, in Downloads' : `Shared ${t.files.length} files, in Downloads`;
    case 'declined':
      return `You declined ${offerSummary(t)}`;
    case 'cancelled':
      return `${offerSummary(t)[0].toUpperCase()}${offerSummary(t).slice(1)} was cancelled`;
    case 'failed':
      return `Couldn’t receive ${offerSummary(t)}`;
  }
}

const SHOWN_FILES = 5;

function Offer({ transfer: t }: { transfer: QuickShareTransfer }) {
  if (t.offer.text) {
    return (
      <p className="line-clamp-4 rounded-lg border border-border/60 px-3 py-2 text-sm break-words text-foreground select-text">
        {t.offer.text.title || (t.offer.text.kind === 'url' ? 'A link' : 'Some text')}
      </p>
    );
  }
  const files = t.offer.files;
  return (
    <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60 text-sm">
      {files.slice(0, SHOWN_FILES).map((f, i) => (
        <li key={i} className="flex items-center gap-2 px-3 py-1.5">
          <File className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(f.size)}</span>
        </li>
      ))}
      {files.length > SHOWN_FILES && (
        <li className="px-3 py-1.5 text-xs text-muted-foreground">
          and {files.length - SHOWN_FILES} more, {formatBytes(t.total)} in all
        </li>
      )}
    </ul>
  );
}

function openFile(din: Din, path: string): void {
  void din.files.fromPath(path).then((h) => din.app.openFiles([h]), () => {});
}

function showInFiles(din: Din, path: string): void {
  const slash = path.lastIndexOf('/');
  void din.files
    .fromPath(path.slice(0, slash) || '/')
    .then((dir) => din.app.open('file-browser', { select: path.slice(slash + 1) }, [dir]), () => {});
}

function isWebLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function Arrived({ transfer: t }: { transfer: QuickShareTransfer }) {
  const din = useDin();
  const [copied, setCopied] = useState(false);
  if (t.url) {
    const url = t.url;
    const openable = isWebLink(url);
    const copy = () =>
      void navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      });
    const open = () => void din.app.openUrl(url);
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
            <Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-sm select-text" title={url}>
              {url}
            </span>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Copy link" title="Copy link" onClick={copy}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
            {openable && (
              <Button size="sm" onClick={open}>
                <ExternalLink className="size-4" aria-hidden />
                Open
              </Button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {openable && (
            <ContextMenuItem onSelect={open}>
              <ExternalLink aria-hidden />
              Open
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={copy}>
            <Copy aria-hidden />
            Copy link
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60 text-sm">
      {t.files.map((f) => (
        <li key={f.path}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="group flex items-center gap-1 py-1 pr-1 pl-3">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => openFile(din, f.path)}
                  title={`Open ${f.name}`}
                >
                  <File className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                </button>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`Show ${f.name} in Files`} title="Show in Files" onClick={() => showInFiles(din, f.path)}>
                  <FolderOpen className="size-4" />
                </Button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => openFile(din, f.path)}>
                <File aria-hidden />
                Open
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => showInFiles(din, f.path)}>
                <FolderOpen aria-hidden />
                Show in Files
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </li>
      ))}
    </ul>
  );
}
