import { useContext, useMemo, useState, useSyncExternalStore } from 'react';
import { MonitorsContext } from '@/contexts/MonitorsContext';
import { Copy, Download, FileText, Files, Link2, Type } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { toast } from '@/hooks/useToast';
import { setFileClipboard } from '@/lib/fileClipboard';
import { getFsBridge, localFileUrl } from '@/lib/fs';
import {
  alternativeSample,
  deliverAlternative,
  deliverShare,
  getShareRequest,
  rememberedSendAs,
  rememberSendAs,
  saveSharedFiles,
  shareTargets,
  shareText,
  subscribeShare,
  type ShareData,
  type ShareRequest,
  type ShareTargetApp,
} from '@/lib/share';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { SegmentedControl } from '@/shared/appChrome';
import { focusRing } from '@/shared/appChromeStyles';
import { trayList, trayRowClass, trayRuleTop, trayTokenClass } from './trayPanel';

/**
 * The share sheet (src/lib/share.ts): a glass popover pointing at what was
 * clicked to share, with what's being shared, the apps that take it, and
 * the sheet's own actions. Choosing one, Escape, or a click away closes it.
 * A share that can go another way (a page's video as the file) has a "Send
 * as" control; one of those is made after an app's picked, the sheet
 * showing how far along it is.
 */
export function ShareSheetHost() {
  const request = useSyncExternalStore(subscribeShare, getShareRequest);
  if (!request) return null;
  return <ShareSheet key={request.id} request={request} />;
}

/** A share being made another way before it goes: to which app, how far along. */
interface Preparing {
  target: ShareTargetApp;
  progress: number | null;
  controller: AbortController;
}

function ShareSheet({ request }: { request: ShareRequest }) {
  const installed = useInstalledApps();
  const actions = useWindowActions();
  const monitors = useContext(MonitorsContext);
  const { data, anchor, opener, alternatives, rememberAs } = request;
  const { apps, getApp } = installed;
  // Link, or one of the other ways to send it (a page's video as the file).
  const [sendAs, setSendAs] = useState(() => {
    const remembered = request.sendAs ?? rememberedSendAs(rememberAs);
    return alternatives.some((a) => a.id === remembered) ? remembered : 'link';
  });
  const alt = alternatives.find((a) => a.id === sendAs) ?? null;
  const [qualities, setQualities] = useState<Record<string, string>>({});
  const quality = alt ? (qualities[alt.id] ?? alt.qualities?.[0]?.value ?? null) : null;
  const [preparing, setPreparing] = useState<Preparing | null>(null);
  const shown = useMemo(() => (alt ? alternativeSample(data, alt) : data), [data, alt]);
  const targets = useMemo(() => shareTargets(shown, { apps, getApp }, opener), [shown, apps, getApp, opener]);
  const close = (answer: string | null) => request.finish(answer);
  const chooseSendAs = (value: string) => {
    setSendAs(value);
    rememberSendAs(rememberAs, value);
  };

  const share = (t: ShareTargetApp) => {
    if (!alt) {
      deliverShare(t, data, opener, actions.open);
      close(t.id);
      return;
    }
    // Made first, which can take a while: the sheet shows how far along it
    // is, and it carries on if the sheet's closed meanwhile.
    const controller = new AbortController();
    setPreparing({ target: t, progress: null, controller });
    void deliverAlternative(alt, quality, t, data, opener, actions.open, (progress) => setPreparing((p) => (p?.controller === controller ? { ...p, progress } : p)), controller.signal).then(
      () => close(t.id),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        toast({ title: `Couldn’t share to ${t.name}`, description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
        close(null);
      },
    );
  };
  const cancelPreparing = () => {
    preparing?.controller.abort();
    setPreparing(null);
  };

  const copy = () => {
    if (data.files.length > 0) {
      setFileClipboard({ op: 'copy', paths: data.files.map((f) => f.path), readOnly: true });
      toast({ title: data.files.length === 1 ? 'File copied' : `${data.files.length} files copied` });
    } else {
      void navigator.clipboard.writeText(shareText(data)).then(
        () => toast({ title: data.url && !data.text ? 'Link copied' : 'Copied' }),
        () => toast({ title: 'Couldn’t copy', variant: 'destructive' }),
      );
    }
    close('copy');
  };
  const save = () => {
    if (alt?.save) {
      alt.save(quality);
      close('save');
      return;
    }
    void saveSharedFiles(data.files).then(
      (paths) => toast({ title: paths.length === 1 ? 'Saved to Downloads' : `${paths.length} files saved to Downloads` }),
      (error: unknown) => toast({ title: 'Couldn’t save', description: error instanceof Error ? error.message : String(error), variant: 'destructive' }),
    );
    close('save');
  };

  // The anchor is in viewport coordinates (getBoundingClientRect), but with
  // more than one monitor <body> is the primary monitor's rectangle and the
  // containing block for position: fixed (MonitorsProvider), so a fixed
  // element's left/top are measured from the primary monitor's corner, not
  // the viewport's. Take that offset back out, or with a monitor above or
  // left of the primary the sheet points that far below or right of the
  // button (and floating-ui pins it to the screen's edge).
  const origin = monitors?.primary ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  const box = anchor ?? { x: origin.x + origin.width / 2, y: origin.y + origin.height / 3, width: 1, height: 1 };
  return (
    <Popover
      open
      onOpenChange={(o) => {
        if (o) return;
        if (preparing) {
          // It still goes once it's made; the Web Browser's downloads show how far along.
          toast({ title: `Sharing to ${preparing.target.name} once it’s ready` });
          close(preparing.target.id);
        } else close(null);
      }}
    >
      <PopoverAnchor asChild>
        <div aria-hidden className="pointer-events-none fixed" style={{ left: box.x - origin.x, top: box.y - origin.y, width: box.width, height: box.height }} />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Share"
        className="w-88 rounded-xl p-0"
      >
        <Preview data={data} from={opener ? (getApp(opener)?.name ?? opener) : null} />
        {alternatives.length > 0 && !preparing && (
          <div className="flex flex-col items-center gap-2 px-4 pb-3">
            <SegmentedControl
              label="Send as"
              value={sendAs}
              options={[{ value: 'link', label: 'Link' }, ...alternatives.map((a) => ({ value: a.id, label: a.label }))]}
              onValueChange={chooseSendAs}
            />
            {alt?.qualities && alt.qualities.length > 1 && (
              <SegmentedControl
                label={`${alt.label} quality`}
                value={quality ?? alt.qualities[0].value}
                options={alt.qualities}
                onValueChange={(q) => setQualities((qs) => ({ ...qs, [alt.id]: q }))}
              />
            )}
          </div>
        )}
        {preparing ? (
          <div className={cn(trayRuleTop, 'flex flex-col gap-3 px-4 py-4')} role="status" aria-live="polite">
            <div className="flex items-center gap-3">
              <AppIcon icon={preparing.target.icon} className="size-10 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">
                  {alt?.preparing ?? 'Preparing'} for {preparing.target.name}…
                </p>
                <p className="text-xs text-muted-foreground">
                  {preparing.progress === null ? 'Starting' : `${Math.round(preparing.progress * 100)}%`}
                </p>
              </div>
              <Button variant="ghost" size="sm" className="rounded-full" onClick={cancelPreparing}>
                Cancel
              </Button>
            </div>
            <Progress value={(preparing.progress ?? 0) * 100} aria-label={alt?.preparing ?? 'Preparing'} />
          </div>
        ) : (
          <>
            <div className={cn(trayRuleTop, 'p-2')}>
              {targets.length > 0 ? (
                <ul aria-label="Share to" className="grid grid-cols-4 gap-1">
                  {targets.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => share(t)}
                        className={cn('flex w-full flex-col items-center gap-1.5 rounded-lg px-1 pt-2 pb-1.5 hover:bg-foreground/[0.07]', focusRing)}
                      >
                        <AppIcon icon={t.icon} className="size-12" />
                        <span className="w-full truncate text-center text-xs text-foreground">{t.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-3 text-center text-sm text-muted-foreground">No apps here take this.</p>
              )}
            </div>
            <div className={cn(trayRuleTop, trayList)}>
              <button type="button" onClick={copy} className={trayRowClass()}>
                <span className={trayTokenClass(false)}>
                  <Copy className="size-4.5" strokeWidth={1.75} aria-hidden />
                </span>
                {data.files.length > 0 ? (data.files.length === 1 ? 'Copy File' : 'Copy Files') : data.url && !data.text ? 'Copy Link' : 'Copy'}
              </button>
              {(alt ? !!alt.save : data.files.length > 0 && getFsBridge()) && (
                <button type="button" onClick={save} className={trayRowClass()}>
                  <span className={trayTokenClass(false)}>
                    <Download className="size-4.5" strokeWidth={1.75} aria-hidden />
                  </span>
                  Save to Downloads
                </button>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * What's being shared: a picture's thumbnail or a kind of thing's icon, its
 * name, where it's from, and the app sharing it (`from`), which is shown so
 * an app can't pass its share off as another's.
 */
function Preview({ data, from }: { data: ShareData; from: string | null }) {
  const [broken, setBroken] = useState(false);
  const first = data.files[0];
  const picture = data.files.length === 1 && first.type.startsWith('image/') && getFsBridge() && !broken ? localFileUrl(first.path) : null;
  const Icon = data.files.length > 1 ? Files : data.files.length === 1 ? FileText : data.url ? Link2 : Type;
  let host: string | null = null;
  if (data.url) {
    try {
      host = new URL(data.url).host || data.url;
    } catch {
      host = data.url;
    }
  }
  const title =
    data.files.length > 1
      ? `${data.files.length} files`
      : (first?.name ?? data.title ?? data.text?.split('\n')[0] ?? host ?? 'Share');
  const subtitle = data.files.length > 1 ? data.files.map((f) => f.name).join(', ') : first ? (data.title ?? null) : data.title ? (host ?? data.text ?? null) : host && data.text ? host : null;
  return (
    <div className="flex items-center gap-3 px-4 pt-4 pb-3">
      {picture ? (
        <img src={picture} alt="" onError={() => setBroken(true)} className="size-12 shrink-0 rounded-lg object-cover clay" />
      ) : (
        <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground/10 text-foreground/75 clay">
          <Icon className="size-6" strokeWidth={1.75} aria-hidden />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-[family-name:var(--font-title)] text-[15px] font-semibold text-foreground">{title}</p>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        {from && <p className="truncate text-xs text-muted-foreground">From {from}</p>}
      </div>
    </div>
  );
}
