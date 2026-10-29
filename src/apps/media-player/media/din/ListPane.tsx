import { useMemo, useRef, useState } from 'react';
import { ListX, Save, Shuffle, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { formatTime, player, usePlayer } from '../engine';
import { isUrl } from '../metadata';
import { Cover, IconButton } from './common';
import { useSavePlaylist } from './useSavePlaylist';
import { showFileInFiles } from '../host';

const NOW_PLAYING_MIME = 'application/x-din-now-playing';

/** The Now Playing list beside the visualization, as WMP's List pane. */
export function ListPane() {
  const queue = usePlayer((s) => s.queue);
  const current = usePlayer((s) => s.current);
  const playing = usePlayer((s) => s.status === 'playing');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const savePlaylist = useSavePlaylist();
  const listRef = useRef<HTMLDivElement>(null);
  const track = queue[current] ?? null;
  const total = useMemo(() => queue.reduce((n, t) => n + (t.duration ?? 0), 0), [queue]);

  const select = (key: string, e: React.MouseEvent | React.KeyboardEvent) => {
    if (e.shiftKey && anchor) {
      const a = queue.findIndex((t) => t.key === anchor);
      const b = queue.findIndex((t) => t.key === key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(queue.slice(lo, hi + 1).map((t) => t.key)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelected(next);
    } else setSelected(new Set([key]));
    setAnchor(key);
  };

  const targets = (key: string) => (selected.has(key) ? [...selected] : [key]);

  return (
    <aside aria-label="Now Playing list" className="mp-pane flex w-72 shrink-0 flex-col border-y-0 border-r-0">
      <div className="flex items-center gap-3 border-b border-[var(--mp-line)] p-3">
        <Cover location={track?.location} className="size-16 shadow-lg ring-1 ring-foreground/10" />
        <div className="min-w-0 flex-1 leading-snug">
          <p className="truncate font-semibold">{track?.album || track?.title || 'Now Playing'}</p>
          <p className="truncate text-xs text-[var(--mp-ink-dim)]">{track?.artist || (queue.length ? '' : 'Nothing queued')}</p>
          <p className="truncate text-xs text-[var(--mp-ink-faint)]">
            {queue.length} item{queue.length === 1 ? '' : 's'}{total > 0 && `, ${formatTime(total)}`}
          </p>
        </div>
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable
        aria-label="Songs"
        tabIndex={0}
        className="mp-scroll min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--mp-accent)]"
        onKeyDown={(e) => {
          if (e.key === 'Delete' && selected.size > 0) {
            e.preventDefault();
            player.remove(selected);
            setSelected(new Set());
          } else if (e.key === 'Enter' && selected.size > 0) {
            const i = queue.findIndex((t) => selected.has(t.key));
            if (i >= 0) player.playIndex(i);
          } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && queue.length > 0) {
            e.preventDefault();
            const last = anchor ? queue.findIndex((t) => t.key === anchor) : -1;
            const next = Math.max(0, Math.min(queue.length - 1, last + (e.key === 'ArrowDown' ? 1 : -1)));
            select(queue[next].key, e);
            listRef.current?.querySelectorAll('[role=option]')[next]?.scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            setSelected(new Set(queue.map((t) => t.key)));
          }
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(NOW_PLAYING_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData(NOW_PLAYING_MIME);
          setDropAt(null);
          if (!raw) return;
          e.preventDefault();
          e.stopPropagation();
          player.move(JSON.parse(raw) as string[], dropAt ?? queue.length);
        }}
      >
        {queue.length === 0 && (
          <p className="px-4 py-8 text-center text-[var(--mp-ink-faint)]">
            Drag songs here from Files, or pick some in the Library.
          </p>
        )}
        {queue.map((t, i) => (
          <ContextMenu key={t.key}>
            <ContextMenuTrigger asChild>
              <div
                role="option"
                aria-selected={selected.has(t.key)}
                data-current={i === current}
                draggable
                onDragStart={(e) => {
                  const keys = targets(t.key);
                  if (!selected.has(t.key)) setSelected(new Set([t.key]));
                  e.dataTransfer.setData(NOW_PLAYING_MIME, JSON.stringify(keys));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(NOW_PLAYING_MIME)) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDropAt(e.clientY < rect.top + rect.height / 2 ? i : i + 1);
                }}
                onClick={(e) => select(t.key, e)}
                onDoubleClick={() => player.playIndex(i)}
                onContextMenu={() => !selected.has(t.key) && setSelected(new Set([t.key]))}
                className={cn(
                  'mp-row relative flex cursor-default items-center gap-2 px-3 py-1',
                  t.failed && 'opacity-50 line-through',
                  dropAt === i && 'shadow-[inset_0_2px_0_var(--mp-accent)]',
                  dropAt === i + 1 && i === queue.length - 1 && 'shadow-[inset_0_-2px_0_var(--mp-accent)]',
                )}
              >
                <span className="w-4 shrink-0 text-center text-[10px]" aria-hidden>
                  {i === current ? (playing ? '▶' : '❚❚') : ''}
                </span>
                <span className="min-w-0 flex-1 truncate" title={t.artist ? `${t.title} — ${t.artist}` : t.title}>
                  {t.title}
                  {t.artist && <span className="text-[var(--mp-ink-faint)]"> · {t.artist}</span>}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-[var(--mp-ink-faint)]">{formatTime(t.duration)}</span>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => player.playIndex(i)}>Play</ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  const keys = targets(t.key);
                  player.move(keys, current + 1);
                }}
              >
                Play Next
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => player.move(targets(t.key), Math.max(0, i - 1))}>Move Up</ContextMenuItem>
              <ContextMenuItem onSelect={() => player.move(targets(t.key), i + 2)}>Move Down</ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger>Sort List By</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem onSelect={() => player.sort('title')}>Title</ContextMenuItem>
                  <ContextMenuItem onSelect={() => player.sort('artist')}>Artist</ContextMenuItem>
                  <ContextMenuItem onSelect={() => player.sort('album')}>Album</ContextMenuItem>
                  <ContextMenuItem onSelect={() => player.sort('location')}>File Name</ContextMenuItem>
                  <ContextMenuItem onSelect={() => player.sort('duration')}>Length</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => player.sort('reverse')}>Reverse</ContextMenuItem>
                  <ContextMenuItem onSelect={() => player.sort('random')}>Randomize</ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSeparator />
              {!isUrl(t.location) && (
                <ContextMenuItem onSelect={() => void showFileInFiles(t.location)}>
                  Show in Files
                </ContextMenuItem>
              )}
              <ContextMenuItem
                onSelect={() => {
                  player.remove(targets(t.key));
                  setSelected(new Set());
                }}
              >
                Remove from List
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
      <div className="flex items-center gap-1 border-t border-[var(--mp-line)] px-2 py-1">
        <IconButton label="Save list as a playlist…" disabled={queue.length === 0} onClick={() => void savePlaylist(queue)} className="size-7">
          <Save className="size-4" />
        </IconButton>
        <IconButton label="Shuffle the list" disabled={queue.length < 2} onClick={() => player.sort('random')} className="size-7">
          <Shuffle className="size-4" />
        </IconButton>
        <IconButton label="Remove songs that won't play" disabled={!queue.some((t) => t.failed)} onClick={() => player.removeFailed()} className="size-7">
          <ListX className="size-4" />
        </IconButton>
        <span className="flex-1" />
        <IconButton label="Clear list" disabled={queue.length === 0} onClick={() => player.clear()} className="size-7">
          <Trash2 className="size-4" />
        </IconButton>
      </div>
    </aside>
  );
}
