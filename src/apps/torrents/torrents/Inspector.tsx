import { useMemo, type ReactNode } from 'react';
import { Activity, ArrowDown, ArrowUp, Copy, FileStack, FolderSearch, Info, Lock, Radio, Users, X } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { Torrent, TorrentDetail } from '@/lib/torrents';
import { EmptyState, PillButton, SegmentedControl, StatusPill, ToolButton } from '@/shared/appChrome';
import { toast } from '@/shared/toast';
import { useTorrentDetail } from './bridge';
import { FileTree } from './FileTree';
import { formatAgo, formatBytes, formatDate, formatDuration, formatPercent, formatRate, formatRatio, plural, progressLine, stateLabel } from '@/shared/torrentFormat';
import { TorrentIcon } from './icons';
import { ProgressBar } from './TransferList';

export type InspectorTab = 'info' | 'activity' | 'files' | 'peers' | 'trackers';

const TABS: { value: InspectorTab; label: ReactNode; title: string }[] = [
  { value: 'info', label: <Info />, title: 'Info' },
  { value: 'activity', label: <Activity />, title: 'Activity' },
  { value: 'files', label: <FileStack />, title: 'Files' },
  { value: 'peers', label: <Users />, title: 'Peers' },
  { value: 'trackers', label: <Radio />, title: 'Trackers' },
];

/** A label and its value, in the inspector's two columns. */
function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-x-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words select-text', mono && 'font-mono text-xs leading-5')}>{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      {title && <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>}
      <dl className="rounded-xl bg-card px-3 py-2 clay">{children}</dl>
    </section>
  );
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied the ${what}`);
  } catch {
    toast(`Couldn’t copy the ${what}`, { destructive: true });
  }
}

function InfoTab({ detail, onReveal, onMove }: { detail: TorrentDetail; onReveal: () => void; onMove: () => void }) {
  const t = detail.torrent;
  return (
    <div className="space-y-4">
      <Section>
        <Field label="Size">
          {formatBytes(t.totalBytes)}
          {t.sizeBytes !== t.totalBytes && t.sizeBytes > 0 && <span className="text-muted-foreground"> ({formatBytes(t.sizeBytes)} wanted)</span>}
        </Field>
        <Field label="Files">{t.metadataProgress === null ? t.fileCount.toLocaleString() : '—'}</Field>
        {detail.pieceCount > 0 && (
          <Field label="Pieces">
            {detail.pieceCount.toLocaleString()} × {formatBytes(detail.pieceBytes)}
          </Field>
        )}
        <Field label="Added">{formatDate(t.addedAt)}</Field>
        {t.doneAt && <Field label="Finished">{formatDate(t.doneAt)}</Field>}
      </Section>

      <Section title="Where">
        <p className="py-1 text-sm break-all select-text">{t.downloadDir}</p>
        <div className="flex flex-wrap gap-2 py-1.5">
          <PillButton size="sm" onClick={onReveal} disabled={t.haveBytes === 0}>
            <FolderSearch aria-hidden />
            Show in Files
          </PillButton>
          <PillButton size="sm" onClick={onMove}>
            Move To…
          </PillButton>
        </div>
      </Section>

      <Section title="About">
        <Field label="Hash" mono>
          {t.hash}
        </Field>
        <Field label="Privacy">
          {t.private ? (
            <span className="inline-flex items-center gap-1">
              <Lock className="size-3.5" aria-hidden /> Private: its trackers alone find peers
            </span>
          ) : (
            'Public'
          )}
        </Field>
        {detail.creator && <Field label="Made with">{detail.creator}</Field>}
        {detail.createdAt && <Field label="Made">{formatDate(detail.createdAt)}</Field>}
        {detail.comment && <Field label="Comment">{detail.comment}</Field>}
      </Section>

      {detail.magnet && (
        <PillButton size="sm" onClick={() => void copy(detail.magnet, 'magnet link')}>
          <Copy aria-hidden />
          Copy Magnet Link
        </PillButton>
      )}
    </div>
  );
}

/** Which pieces are here, as a grid of cells; each cell several pieces once there are many. */
function PieceMap({ detail }: { detail: TorrentDetail }) {
  const cells = useMemo(() => {
    const count = detail.pieceCount;
    if (!count || !detail.pieces) return [];
    let bits: Uint8Array;
    try {
      bits = Uint8Array.from(atob(detail.pieces), (c) => c.charCodeAt(0));
    } catch {
      return [];
    }
    const has = (i: number) => (bits[i >> 3] >> (7 - (i & 7))) & 1;
    const n = Math.min(count, 18 * 14);
    return Array.from({ length: n }, (_, cell) => {
      const from = Math.floor((cell * count) / n);
      const to = Math.max(from + 1, Math.floor(((cell + 1) * count) / n));
      let got = 0;
      for (let i = from; i < to; i++) got += has(i);
      return got / (to - from);
    });
  }, [detail.pieceCount, detail.pieces]);
  if (cells.length === 0) return null;
  const done = detail.torrent.finished;
  return (
    <div className="grid grid-cols-[repeat(18,minmax(0,1fr))] gap-0.5 rounded-xl bg-card p-2 clay" role="img" aria-label={`${formatPercent(detail.torrent.progress)} of its pieces are here`}>
      {cells.map((fraction, i) => (
        <span key={i} className="relative aspect-square overflow-hidden rounded-[3px] bg-foreground/[0.07]">
          {fraction > 0 && <span className={cn('absolute inset-0', done ? 'bg-success' : 'bg-pigment')} style={{ opacity: 0.25 + 0.75 * fraction }} />}
        </span>
      ))}
    </div>
  );
}

function ActivityTab({ detail }: { detail: TorrentDetail }) {
  const t = detail.torrent;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <ProgressBar torrent={t} className="h-2" />
        <p className="text-xs text-muted-foreground tabular-nums">{progressLine(t)}</p>
      </div>
      <PieceMap detail={detail} />
      <Section>
        <Field label="State">{stateLabel(t)}</Field>
        <Field label="Downloaded">{formatBytes(t.downloadedBytes)}</Field>
        <Field label="Uploaded">{formatBytes(t.uploadedBytes)}</Field>
        <Field label="Ratio">{formatRatio(t.ratio)}</Field>
        {detail.corruptBytes > 0 && <Field label="Thrown away">{formatBytes(detail.corruptBytes)} that didn’t check out</Field>}
        <Field label="Speed">
          <span className="inline-flex flex-wrap items-center gap-x-3 whitespace-nowrap tabular-nums">
            <span className="inline-flex items-center gap-1">
              <ArrowDown className="size-3.5" aria-label="Down" /> {formatRate(t.rateDown)}
            </span>
            <span className="inline-flex items-center gap-1">
              <ArrowUp className="size-3.5" aria-label="Up" /> {formatRate(t.rateUp)}
            </span>
          </span>
        </Field>
        <Field label="Peers">
          {t.peersConnected ? `${plural(t.peersConnected, 'peer')}: ${t.peersSending} sending, ${t.peersReceiving} receiving` : 'None connected'}
        </Field>
        {detail.secondsDownloading > 0 && <Field label="Downloading">{formatDuration(detail.secondsDownloading)}</Field>}
        {detail.secondsSeeding > 0 && <Field label="Seeding">{formatDuration(detail.secondsSeeding)}</Field>}
      </Section>
      {t.error && (
        <div role="alert" className={cn('rounded-xl px-3 py-2 text-sm', t.errorKind === 'local' ? 'bg-destructive/10 text-destructive' : 'bg-warning/15')}>
          {t.error}
        </div>
      )}
    </div>
  );
}

function PeersTab({ detail }: { detail: TorrentDetail }) {
  const peers = [...detail.peers].sort((a, b) => b.rateDown + b.rateUp - (a.rateDown + a.rateUp));
  if (peers.length === 0) {
    return <EmptyState icon={Users} title="No peers">{detail.torrent.state === 'stopped' ? 'It’s paused.' : 'Looking for others sharing it.'}</EmptyState>;
  }
  return (
    <ul className="space-y-0.5">
      {peers.map((p) => (
        <li key={`${p.address}:${p.port}`} className="rounded-lg px-2 py-1.5 hover:bg-foreground/5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{p.client || 'Unknown client'}</span>
            {p.encrypted && <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Encrypted" />}
            {p.utp && <StatusPill title="Over uTP">uTP</StatusPill>}
            <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatPercent(p.progress)}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <span className="min-w-0 flex-1 truncate font-mono select-text">{p.address}</span>
            {p.rateDown > 0 && <span>↓ {formatRate(p.rateDown)}</span>}
            {p.rateUp > 0 && <span>↑ {formatRate(p.rateUp)}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function TrackersTab({ detail }: { detail: TorrentDetail }) {
  if (detail.trackers.length === 0) {
    return (
      <EmptyState icon={Radio} title="No trackers">
        {detail.torrent.private ? 'A private torrent finds peers through its trackers alone.' : 'It finds peers through the DHT and the peers it meets.'}
      </EmptyState>
    );
  }
  return (
    <ul className="space-y-2">
      {detail.trackers.map((tr) => {
        const last = tr.lastAnnounce;
        return (
          <li key={tr.id} className="rounded-xl bg-card px-3 py-2 clay">
            <div className="flex items-center gap-2">
              <span className={cn('size-2 shrink-0 rounded-full', !last ? 'bg-muted-foreground/40' : last.ok ? 'bg-success' : 'bg-destructive')} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={tr.announce}>
                {tr.host}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">Tier {tr.tier + 1}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tr.announcing
                ? 'Asking now…'
                : last
                  ? last.ok
                    ? `Asked ${formatAgo(last.at)}: ${plural(last.peers, 'peer')}`
                    : `Asked ${formatAgo(last.at)}: ${last.result || 'it didn’t answer'}`
                  : 'Not asked yet'}
            </p>
            {(tr.seeders !== null || tr.leechers !== null) && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {tr.seeders ?? '?'} seeding · {tr.leechers ?? '?'} downloading{tr.downloads !== null ? ` · ${tr.downloads.toLocaleString()} done` : ''}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Everything about the chosen transfer, beside the list: its info, how
 * it's going, its files, peers and trackers, a segment each, as Transmission's
 * inspector and the Finder's Get Info have them.
 */
export function Inspector({
  torrent,
  count,
  tab,
  onTab,
  onClose,
  onReveal,
  onMove,
}: {
  torrent: Torrent | null;
  /** How many are chosen: the inspector shows one. */
  count: number;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
  onReveal: (t: Torrent, file?: number) => void;
  onMove: (t: Torrent) => void;
}) {
  const { data: detail, isLoading } = useTorrentDetail(torrent?.id ?? null);
  const live = detail && torrent && detail.torrent.id === torrent.id ? { ...detail, torrent } : null;

  return (
    <aside aria-label="Inspector" className="flex h-full w-full min-w-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <SegmentedControl label="Inspector" value={tab} options={TABS} onValueChange={onTab} size="md" className="flex-1 [&>button]:flex-1" />
        <ToolButton size="sm" label="Close the inspector" onClick={onClose}>
          <X className="size-4" strokeWidth={1.75} />
        </ToolButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {!torrent ? (
          <EmptyState icon={Info} title={count > 1 ? `${count} transfers chosen` : 'Nothing chosen'}>
            {count > 1 ? 'Choose one to see all about it.' : 'Choose a transfer to see all about it.'}
          </EmptyState>
        ) : !live ? (
          isLoading ? (
            <div className="space-y-3 pt-2">
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-32 w-full rounded-xl" />
            </div>
          ) : null
        ) : (
          <div className="space-y-4">
            <header className="flex items-center gap-3 pt-1">
              <TorrentIcon mimeType={torrent.mimeType} name={torrent.name} fileCount={torrent.fileCount} hasMetadata={torrent.metadataProgress === null} size="lg" />
              <div className="min-w-0">
                <h2 className="line-clamp-2 text-sm font-semibold break-words select-text">{torrent.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {stateLabel(torrent)}
                  {torrent.metadataProgress === null && ` · ${formatBytes(torrent.totalBytes)}`}
                </p>
              </div>
            </header>
            {tab === 'info' && <InfoTab detail={live} onReveal={() => onReveal(torrent)} onMove={() => onMove(torrent)} />}
            {tab === 'activity' && <ActivityTab detail={live} />}
            {tab === 'files' && <FileTree detail={live} onReveal={(file) => onReveal(torrent, file)} />}
            {tab === 'peers' && <PeersTab detail={live} />}
            {tab === 'trackers' && <TrackersTab detail={live} />}
          </div>
        )}
      </div>
    </aside>
  );
}
