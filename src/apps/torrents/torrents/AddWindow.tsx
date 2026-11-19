import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Folder, LoaderCircle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cleanTorrentsError, type TorrentSource } from '@/lib/torrents';
import { useDin, useWindowTitle } from '@/sdk/react';
import { FormWindow, PillButton } from '@/shared/appChrome';
import { pickFolder } from '@/shared/fileHandles';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { KEY, useBridge, useTorrentsStatus } from './bridge';
import { FileTreeView } from './FileTree';
import { formatBytes, plural } from '@/shared/torrentFormat';
import { TorrentIcon } from './icons';
import { announce } from './windows';

const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

/**
 * Adding a torrent, in a window of its own as Transmission's Mac app does:
 * what it is, which of its files to download, where to, and whether to start.
 * A magnet link says what's in it only once peers do, so it's just where.
 */
export function AddWindow({ source }: { source: TorrentSource | null }) {
  const bridge = useBridge();
  const din = useDin();
  const { data: status } = useTorrentsStatus();
  const { data: preview, error, isLoading } = useQuery({
    queryKey: [...KEY, 'preview', source],
    queryFn: () => bridge!.inspect(source!),
    enabled: !!bridge && !!source,
    staleTime: Infinity,
    retry: false,
  });
  useWindowTitle(preview ? `Add “${preview.name}”` : 'Add Torrent');

  const [dir, setDir] = useState<string | null>(null);
  const [start, setStart] = useState<boolean | null>(null);
  const [unwanted, setUnwanted] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const downloadDir = dir ?? status?.settings?.downloadDir ?? '';
  const startNow = start ?? status?.settings?.startWhenAdded ?? true;

  const files = useMemo(() => (preview?.files ?? []).map((f, index) => ({ index, path: f.path, bytes: f.bytes, wanted: !unwanted.has(index) })), [preview, unwanted]);
  const wantedBytes = files.filter((f) => f.wanted).reduce((sum, f) => sum + f.bytes, 0);
  const wantedCount = files.filter((f) => f.wanted).length;

  // Escape closes, as a sheet's Cancel would.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  const choose = async () => {
    const folder = await pickFolder({ title: 'Download To', startIn: 'downloads', confirmLabel: 'Choose' });
    if (folder) setDir(din.files.path(folder));
  };

  const add = async () => {
    if (!bridge || !source || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const added = await bridge.add(source, { downloadDir: downloadDir || undefined, paused: !startNow, unwanted: [...unwanted] });
      announce({ type: 'added', id: added.id });
      window.close();
    } catch (err) {
      setFailure(cleanTorrentsError(err));
      setBusy(false);
    }
  };

  const existing = preview?.existing ?? null;
  const nothingChosen = !!preview?.files && wantedCount === 0;

  return (
    <FormWindow
      title="Add Torrent"
      footer={
        <>
          <PillButton onClick={() => window.close()} disabled={busy}>
            Cancel
          </PillButton>
          {existing !== null ? (
            <PillButton
              variant="primary"
              onClick={() => {
                announce({ type: 'added', id: existing });
                window.close();
              }}
            >
              Show It
            </PillButton>
          ) : (
            <PillButton variant="primary" onClick={() => void add()} disabled={!preview || busy || nothingChosen || !downloadDir}>
              {busy && <LoaderCircle className="animate-spin" aria-hidden />}
              Add
            </PillButton>
          )}
        </>
      }
    >
      {!source ? (
        <p className="px-1 text-sm text-muted-foreground">There’s nothing to add: open a torrent file, or a magnet link.</p>
      ) : error ? (
        <div role="alert" className="flex gap-3 rounded-xl bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4.5 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="font-medium">Torrents can’t add this</p>
            <p className="text-muted-foreground">{cleanTorrentsError(error)}</p>
          </div>
        </div>
      ) : isLoading || !preview ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Skeleton className="size-16 rounded-2xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          </div>
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <header className="flex items-center gap-4 px-1">
            <TorrentIcon
              mimeType={null}
              name={preview.files?.length === 1 ? preview.files[0].path : preview.name}
              fileCount={preview.files?.length ?? 0}
              hasMetadata={!!preview.files}
              size="xl"
            />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg leading-snug font-semibold break-words select-text">{preview.name}</h2>
              <p className="text-sm text-muted-foreground">
                {preview.files
                  ? `${formatBytes(preview.sizeBytes ?? 0)} · ${plural(preview.files.length, 'file')}${preview.private ? ' · Private' : ''}`
                  : preview.sizeBytes
                    ? `${formatBytes(preview.sizeBytes)} · Magnet link`
                    : 'Magnet link'}
              </p>
            </div>
          </header>

          {existing !== null && (
            <p role="status" className="rounded-xl bg-selected px-3 py-2 text-sm">
              It’s in Torrents already.
            </p>
          )}

          {existing === null && (
            <>
              <div className={settingsGroup}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <Folder className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">Download to {downloadDir ? `“${baseName(downloadDir)}”` : ''}</p>
                    <p className="truncate text-xs text-muted-foreground" title={downloadDir}>
                      {downloadDir}
                    </p>
                  </div>
                  <PillButton size="sm" onClick={() => void choose()} disabled={busy}>
                    Change…
                  </PillButton>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <Label htmlFor="start-now" className="cursor-pointer text-sm">
                    Start downloading now
                  </Label>
                  <Switch id="start-now" checked={startNow} onCheckedChange={setStart} disabled={busy} />
                </div>
              </div>

              {preview.files ? (
                <section className="space-y-2">
                  <div className="flex items-baseline justify-between px-1">
                    <h3 className="text-sm font-medium">Files</h3>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {wantedCount === files.length ? `All ${plural(files.length, 'file')}` : `${wantedCount.toLocaleString()} of ${files.length.toLocaleString()}`} ·{' '}
                      {formatBytes(wantedBytes)}
                    </span>
                  </div>
                  <div className="max-h-80 overflow-y-auto rounded-xl bg-card p-1 clay">
                    <FileTreeView
                      files={files}
                      onWanted={(indexes, wanted) =>
                        setUnwanted((u) => {
                          const next = new Set(u);
                          for (const i of indexes) {
                            if (wanted) next.delete(i);
                            else next.add(i);
                          }
                          return next;
                        })
                      }
                    />
                  </div>
                  {nothingChosen && <p className="px-1 text-xs text-destructive">Choose at least one file to download.</p>}
                </section>
              ) : (
                <p className="px-1 text-sm text-muted-foreground">
                  A magnet link says what’s in it once peers do. Its files show in the inspector then, where you can choose which to download.
                </p>
              )}
            </>
          )}

          {failure && (
            <p role="alert" className="px-1 text-sm text-destructive">
              {failure}
            </p>
          )}
        </>
      )}
    </FormWindow>
  );
}
