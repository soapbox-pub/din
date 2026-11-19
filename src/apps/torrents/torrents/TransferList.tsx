import { useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { FolderSearch, Pause, Play, RotateCw } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { Torrent } from '@/lib/torrents';
import { ToolButton } from '@/shared/appChrome';
import { focusRing, listRowClass, roomyMenu } from '@/shared/appChromeStyles';
import { TransferActionItems } from './actions';
import type { TransferAction } from './model';
import { activityLine, formatRate, progressLine, stateLabel } from '@/shared/torrentFormat';
import { TorrentIcon } from './icons';

/** The bar's color says what the transfer's doing, as Transmission's does. */
function barTone(t: Torrent): string {
  if (t.error && t.errorKind === 'local') return 'bg-destructive';
  if (t.state === 'stopped') return 'bg-muted-foreground/45';
  if (t.metadataProgress !== null || t.state === 'checking') return 'bg-warning';
  if (t.state === 'seeding' || t.finished) return 'bg-success';
  return 'bg-pigment';
}

function barValue(t: Torrent): number {
  if (t.metadataProgress !== null) return t.metadataProgress;
  if (t.state === 'checking' && t.checkProgress !== null) return t.checkProgress;
  return t.progress;
}

export function ProgressBar({ torrent, className }: { torrent: Torrent; className?: string }) {
  const value = Math.max(0, Math.min(1, barValue(torrent)));
  return (
    <div
      role="progressbar"
      aria-label={stateLabel(torrent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none', barTone(torrent))}
        style={{ width: `${value * 100}%` }}
      />
    </div>
  );
}

function Row({
  torrent: t,
  selected,
  inactive,
  targets,
  onSelect,
  onOpen,
  onAction,
}: {
  torrent: Torrent;
  selected: boolean;
  inactive: boolean;
  /** What a right-click acts on: the selection, if this row is in it, else this row. */
  targets: () => Torrent[];
  onSelect: (e: MouseEvent) => void;
  onOpen: () => void;
  onAction: (action: TransferAction, targets: Torrent[]) => void;
}) {
  const label = stateLabel(t);
  const activity = activityLine(t);
  const paused = t.state === 'stopped';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          role="option"
          aria-selected={selected}
          data-id={t.id}
          onMouseDown={(e) => {
            // A right-click on a row outside the selection chooses it alone.
            if (e.button === 2 && !selected) onSelect(e);
          }}
          onClick={onSelect}
          onDoubleClick={onOpen}
          className={cn('group flex cursor-default items-center gap-3 rounded-xl px-3 py-2.5', listRowClass({ selected, inactive }))}
        >
          <TorrentIcon mimeType={t.mimeType} name={t.name} fileCount={t.fileCount} hasMetadata={t.metadataProgress === null} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={t.name}>
                {t.name}
              </span>
              {t.state !== 'stopped' && !t.waiting && (t.rateDown > 0 || t.rateUp > 0) && (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {t.rateDown > 0 && <span aria-label={`Downloading at ${formatRate(t.rateDown)}`}>↓ {formatRate(t.rateDown)}</span>}
                  {t.rateDown > 0 && t.rateUp > 0 && <span className="mx-1.5">·</span>}
                  {t.rateUp > 0 && <span aria-label={`Uploading at ${formatRate(t.rateUp)}`}>↑ {formatRate(t.rateUp)}</span>}
                </span>
              )}
            </div>
            <ProgressBar torrent={t} />
            <div className="flex min-w-0 items-baseline gap-3 text-xs text-muted-foreground">
              <p className="max-w-full shrink-0 truncate tabular-nums">
                <span
                  className={cn(
                    'font-medium',
                    t.error && t.errorKind === 'local' ? 'text-destructive' : t.state === 'downloading' && !t.waiting ? 'text-ink-accent' : t.state === 'seeding' ? 'text-success' : undefined,
                  )}
                >
                  {label}
                </span>
                <span aria-hidden> · </span>
                {progressLine(t)}
              </p>
              {activity && (
                <p className={cn('hidden min-w-0 flex-1 truncate text-right tabular-nums @xl:block', t.error && 'text-destructive')} title={activity}>
                  {activity}
                </p>
              )}
            </div>
          </div>
          {/* Pause and Show in Files, as Transmission's row has them, while hovered or chosen. */}
          <div className={cn('flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100', selected && 'opacity-100')}>
            <ToolButton
              size="sm"
              label={paused ? (t.error ? 'Try Again' : 'Resume') : 'Pause'}
              onClick={(e) => {
                e.stopPropagation();
                onAction(paused ? 'resume' : 'pause', [t]);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {paused ? t.error ? <RotateCw className="size-4" strokeWidth={1.75} /> : <Play className="size-4" strokeWidth={1.75} /> : <Pause className="size-4" strokeWidth={1.75} />}
            </ToolButton>
            <ToolButton
              size="sm"
              label="Show in Files"
              disabled={t.haveBytes === 0}
              onClick={(e) => {
                e.stopPropagation();
                onAction('reveal', [t]);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <FolderSearch className="size-4" strokeWidth={1.75} />
            </ToolButton>
          </div>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className={cn('w-64', roomyMenu)}>
        <TransferActionItems targets={targets()} kind="context" onAction={(action) => onAction(action, targets())} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ListSkeleton() {
  return (
    <div className="space-y-1 p-2" aria-hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <Skeleton className="size-10 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-1.5 w-full rounded-full" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The transfers: a row each with its bar, chosen with a click (Ctrl adds,
 * Shift extends), moved through with the arrow keys; Space pauses or
 * resumes, Enter opens, Delete removes.
 */
export function TransferList({
  torrents,
  selected,
  inactive,
  onSelectionChange,
  onOpen,
  onAction,
  label,
}: {
  torrents: Torrent[];
  selected: Set<number>;
  inactive: boolean;
  onSelectionChange: (ids: Set<number>) => void;
  onOpen: (t: Torrent) => void;
  onAction: (action: TransferAction, targets: Torrent[]) => void;
  label: string;
}) {
  const anchor = useRef<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const select = (t: Torrent, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (e.shiftKey && anchor.current !== null) {
      const from = torrents.findIndex((x) => x.id === anchor.current);
      const to = torrents.findIndex((x) => x.id === t.id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        onSelectionChange(new Set(torrents.slice(a, b + 1).map((x) => x.id)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (!next.delete(t.id)) next.add(t.id);
      anchor.current = t.id;
      onSelectionChange(next);
      return;
    }
    anchor.current = t.id;
    onSelectionChange(new Set([t.id]));
  };

  const chosen = () => torrents.filter((t) => selected.has(t.id));

  const onKeyDown = (e: KeyboardEvent) => {
    if (torrents.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const ids = torrents.map((t) => t.id);
      const current = anchor.current !== null ? ids.indexOf(anchor.current) : -1;
      const next = Math.max(0, Math.min(ids.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
      const t = torrents[next];
      if (e.shiftKey && anchor.current !== null) {
        onSelectionChange(new Set([...selected, t.id]));
        anchor.current = t.id;
      } else select(t, { ctrlKey: false, metaKey: false, shiftKey: false });
      listRef.current?.querySelector(`[data-id="${t.id}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSelectionChange(new Set(torrents.map((t) => t.id)));
    } else if (e.key === ' ' && selected.size) {
      e.preventDefault();
      const targets = chosen();
      onAction(targets.some((t) => t.state !== 'stopped') ? 'pause' : 'resume', targets);
    } else if (e.key === 'Enter' && selected.size === 1) {
      e.preventDefault();
      const [t] = chosen();
      if (t) onOpen(t);
    } else if (e.key === 'Escape' && selected.size) {
      onSelectionChange(new Set());
    }
  };

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label={label}
      aria-multiselectable
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn('space-y-0.5 rounded-xl p-2', focusRing)}
    >
      {torrents.map((t) => (
        <Row
          key={t.id}
          torrent={t}
          selected={selected.has(t.id)}
          inactive={inactive}
          targets={() => (selected.has(t.id) ? chosen() : [t])}
          onSelect={(e) => select(t, e)}
          onOpen={() => onOpen(t)}
          onAction={onAction}
        />
      ))}
    </ul>
  );
}
