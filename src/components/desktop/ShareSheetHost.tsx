import { useMemo, useState, useSyncExternalStore } from 'react';
import { Copy, Download, FileText, Files, Link2, Type } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { toast } from '@/hooks/useToast';
import { setFileClipboard } from '@/lib/fileClipboard';
import { getFsBridge, localFileUrl } from '@/lib/fs';
import {
  deliverShare,
  getShareRequest,
  saveSharedFiles,
  shareTargets,
  shareText,
  subscribeShare,
  type ShareData,
  type ShareRequest,
} from '@/lib/share';
import { cn } from '@/lib/utils';
import { focusRing } from '@/shared/appChromeStyles';
import { trayList, trayRowClass, trayRuleTop, trayTokenClass } from './trayPanel';

/**
 * The share sheet (src/lib/share.ts): a glass popover pointing at what was
 * clicked to share, with what's being shared, the apps that take it, and
 * the sheet's own actions. Choosing one, Escape, or a click away closes it.
 */
export function ShareSheetHost() {
  const request = useSyncExternalStore(subscribeShare, getShareRequest);
  if (!request) return null;
  return <ShareSheet key={request.id} request={request} />;
}

function ShareSheet({ request }: { request: ShareRequest }) {
  const installed = useInstalledApps();
  const actions = useWindowActions();
  const { data, anchor, opener } = request;
  const { apps, getApp } = installed;
  const targets = useMemo(() => shareTargets(data, { apps, getApp }, opener), [data, apps, getApp, opener]);
  const close = (answer: string | null) => request.finish(answer);

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
    void saveSharedFiles(data.files).then(
      (paths) => toast({ title: paths.length === 1 ? 'Saved to Downloads' : `${paths.length} files saved to Downloads` }),
      (error: unknown) => toast({ title: 'Couldn’t save', description: error instanceof Error ? error.message : String(error), variant: 'destructive' }),
    );
    close('save');
  };

  const box = anchor ?? { x: window.innerWidth / 2, y: window.innerHeight / 3, width: 1, height: 1 };
  return (
    <Popover
      open
      onOpenChange={(o) => {
        if (!o) close(null);
      }}
    >
      <PopoverAnchor asChild>
        <div aria-hidden className="pointer-events-none fixed" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Share"
        className="w-88 rounded-xl p-0"
      >
        <Preview data={data} />
        <div className={cn(trayRuleTop, 'p-2')}>
          {targets.length > 0 ? (
            <ul aria-label="Share to" className="grid grid-cols-4 gap-1">
              {targets.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      deliverShare(t, data, opener, actions.open);
                      close(t.id);
                    }}
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
          {data.files.length > 0 && getFsBridge() && (
            <button type="button" onClick={save} className={trayRowClass()}>
              <span className={trayTokenClass(false)}>
                <Download className="size-4.5" strokeWidth={1.75} aria-hidden />
              </span>
              Save to Downloads
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** What's being shared: a picture's thumbnail or a kind of thing's icon, its name, and where it's from. */
function Preview({ data }: { data: ShareData }) {
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
      </div>
    </div>
  );
}
