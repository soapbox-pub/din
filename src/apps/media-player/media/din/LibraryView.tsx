import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import {
  Clock, Disc3, FolderPlus, ListMusic, Mic2, Music2, Play, RefreshCw, Search, Star, Tag, CalendarDays, Film, X, ListPlus,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { getFsBridge } from '@/lib/fs';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { makeTrack, formatTime, player, usePlayer, type Track } from '../engine';
import { library, useLibrary, type LibraryItem } from '../library';
import { readPlaylistFile } from '../actions';
import { setPrefs } from '../prefs';
import { pickPaths, showFileInFiles, showInFiles } from '../host';
import { Cover, Stars } from './common';

type View =
  | { kind: 'recent' | 'artists' | 'albums' | 'songs' | 'genres' | 'years' | 'rated' | 'videos' | 'folders' }
  | { kind: 'artist'; name: string }
  | { kind: 'album'; name: string; artist: string }
  | { kind: 'genre'; name: string }
  | { kind: 'year'; name: string }
  | { kind: 'playlist'; path: string };

const toTrack = (i: LibraryItem) => makeTrack(i.location, { title: i.title, artist: i.artist, album: i.album, duration: i.duration });
const artistOf = (i: LibraryItem) => i.albumArtist || i.artist || 'Unknown Artist';
const albumOf = (i: LibraryItem) => i.album || 'Unknown Album';
const genreOf = (i: LibraryItem) => i.genre || 'Unknown Genre';
const yearOf = (i: LibraryItem) => i.year || 'Unknown Year';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byAlbumOrder = (a: LibraryItem, b: LibraryItem) =>
  collator.compare(albumOf(a), albumOf(b)) || (a.disc ?? 0) - (b.disc ?? 0) || (a.track ?? 0) - (b.track ?? 0) || collator.compare(a.title, b.title);

function play(items: LibraryItem[], start = 0) {
  if (items.length === 0) return;
  player.setQueue(items.map(toTrack), start, true);
  setPrefs({ tab: 'now-playing' });
}

async function playPlaylist(path: string, how: 'play' | 'next' | 'enqueue') {
  const tracks = await readPlaylistFile(path, { reach: true });
  if (tracks.length === 0) return;
  if (how !== 'play') return player.enqueue(tracks, { next: how === 'next' });
  player.setQueue(tracks, 0, true);
  setPrefs({ tab: 'now-playing' });
}

function NavItem({ icon, label, active, onClick, count, ...props }: Omit<ComponentProps<'button'>, 'children' | 'onClick'> & { icon: ReactNode; label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button
      {...props}
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mp-accent)]',
        active ? 'bg-[var(--mp-row-selected)] text-[var(--mp-ink)] font-medium' : 'text-[var(--mp-ink-dim)] hover:bg-[var(--mp-row-hover)] hover:text-[var(--mp-ink)]',
      )}
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-xs tabular-nums text-[var(--mp-ink-faint)]">{count}</span>}
    </button>
  );
}

type SortKey = 'title' | 'artist' | 'album' | 'duration' | 'rating' | 'plays' | 'added';

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: 'title', label: 'Title', className: 'min-w-0 flex-[3]' },
  { key: 'artist', label: 'Artist', className: 'min-w-0 flex-[2]' },
  { key: 'album', label: 'Album', className: 'min-w-0 flex-[2] max-md:hidden' },
  { key: 'duration', label: 'Length', className: 'w-14 shrink-0 text-right' },
  { key: 'rating', label: 'Rating', className: 'w-20 shrink-0 max-sm:hidden' },
  { key: 'plays', label: 'Plays', className: 'w-12 shrink-0 text-right max-lg:hidden' },
];

const ROW = 28;

function SongTable({ items, ordered }: { items: LibraryItem[]; ordered?: boolean }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const currentLocation = usePlayer((s) => s.queue[s.current]?.location);
  const rows = useMemo(() => {
    if (!sort) return items;
    const sign = sort.desc ? -1 : 1;
    return items.slice().sort((a, b) => {
      const k = sort.key;
      const d = k === 'title' || k === 'artist' || k === 'album' ? collator.compare(a[k], b[k]) : ((a[k] ?? 0) as number) - ((b[k] ?? 0) as number);
      return d * sign || collator.compare(a.title, b.title);
    });
  }, [items, sort]);
  const { containerRef, onScroll, start, end, totalHeight } = useVirtualRows({ count: rows.length, rowHeight: ROW, overscan: 10 });
  const targets = (loc: string) => rows.filter((r) => (selected.has(loc) ? selected.has(r.location) : r.location === loc));

  if (items.length === 0) {
    return <p className="grid flex-1 place-items-center p-8 text-[var(--mp-ink-faint)]">Nothing here yet.</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="row" className="flex shrink-0 items-center gap-3 border-b border-[var(--mp-line)] px-4 py-1 text-xs font-semibold text-[var(--mp-ink-dim)]">
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            type="button"
            role="columnheader"
            aria-sort={sort?.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
            onClick={() => setSort((s) => (s?.key === c.key ? (s.desc ? null : { key: c.key, desc: true }) : { key: c.key, desc: false }))}
            className={cn('truncate text-left hover:text-[var(--mp-ink)]', c.className)}
          >
            {c.label}
            {sort?.key === c.key && (sort.desc ? ' ▾' : ' ▴')}
          </button>
        ))}
      </div>
      <div ref={containerRef} onScroll={onScroll} role="grid" aria-rowcount={rows.length} className="mp-scroll min-h-0 flex-1 overflow-y-auto">
        <div style={{ height: totalHeight }} className="relative">
          {rows.slice(start, end).map((item, n) => {
            const i = start + n;
            return (
              <ContextMenu key={item.location}>
                <ContextMenuTrigger asChild>
                  <div
                    role="row"
                    aria-selected={selected.has(item.location)}
                    data-current={item.location === currentLocation}
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) {
                        const next = new Set(selected);
                        if (next.has(item.location)) next.delete(item.location);
                        else next.add(item.location);
                        setSelected(next);
                      } else setSelected(new Set([item.location]));
                    }}
                    onContextMenu={() => !selected.has(item.location) && setSelected(new Set([item.location]))}
                    onDoubleClick={() => play(rows, i)}
                    style={{ top: i * ROW, height: ROW }}
                    className={cn('mp-row absolute inset-x-0 flex cursor-default items-center gap-3 px-4', i % 2 === 1 && 'bg-foreground/[0.025]')}
                  >
                    <span className={cn(COLUMNS[0].className, 'truncate')}>
                      {ordered && item.track ? <span className="mr-2 tabular-nums text-[var(--mp-ink-faint)]">{item.track}</span> : null}
                      {item.title}
                    </span>
                    <span className={cn(COLUMNS[1].className, 'truncate text-[var(--mp-ink-dim)]')}>{item.artist}</span>
                    <span className={cn(COLUMNS[2].className, 'truncate text-[var(--mp-ink-dim)]')}>{item.album}</span>
                    <span className={cn(COLUMNS[3].className, 'tabular-nums text-[var(--mp-ink-dim)]')}>{formatTime(item.duration)}</span>
                    <span className={COLUMNS[4].className}>
                      <Stars value={item.rating} onChange={(r) => library.setRating(item.location, r)} />
                    </span>
                    <span className={cn(COLUMNS[5].className, 'tabular-nums text-[var(--mp-ink-faint)]')}>{item.plays || ''}</span>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => play(targets(item.location))}>Play</ContextMenuItem>
                  <ContextMenuItem onSelect={() => player.enqueue(targets(item.location).map(toTrack), { next: true })}>Play Next</ContextMenuItem>
                  <ContextMenuItem onSelect={() => player.enqueue(targets(item.location).map(toTrack))}>Add to Now Playing</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>Rate</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {[5, 4, 3, 2, 1, 0].map((r) => (
                        <ContextMenuItem key={r} onSelect={() => targets(item.location).forEach((t) => library.setRating(t.location, r))}>
                          {r === 0 ? 'Unrated' : `${'★'.repeat(r)}${'☆'.repeat(5 - r)}`}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuItem onSelect={() => void showFileInFiles(item.location)}>Show in Files</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => library.forget(targets(item.location).map((t) => t.location))}>Remove from Library</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AlbumGrid({ items, onOpen }: { items: LibraryItem[]; onOpen: (album: string, artist: string) => void }) {
  const albums = useMemo(() => {
    const map = new Map<string, { album: string; artist: string; items: LibraryItem[]; year: string }>();
    for (const i of items) {
      const key = `${albumOf(i)}\u0000${artistOf(i)}`;
      const entry = map.get(key) ?? { album: albumOf(i), artist: artistOf(i), items: [], year: i.year };
      entry.items.push(i);
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => collator.compare(a.album, b.album));
  }, [items]);
  if (albums.length === 0) return <p className="grid flex-1 place-items-center p-8 text-[var(--mp-ink-faint)]">Nothing here yet.</p>;
  return (
    <div className="mp-scroll min-h-0 flex-1 overflow-y-auto p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-4">
        {albums.map((a) => {
          const tracks = () => a.items.slice().sort(byAlbumOrder);
          return (
            <ContextMenu key={`${a.album}/${a.artist}`}>
              <ContextMenuTrigger asChild>
                <div className="group min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpen(a.album, a.artist)}
                    onDoubleClick={() => play(tracks())}
                    className="relative block w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mp-accent)]"
                    aria-label={`${a.album} by ${a.artist}`}
                  >
                    <Cover location={a.items[0].location} className="aspect-square w-full shadow-lg ring-1 ring-foreground/10 transition-transform motion-safe:group-hover:-translate-y-0.5" />
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`Play ${a.album}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        play(tracks());
                      }}
                      className="mp-orb absolute bottom-2 right-2 size-9 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <Play className="size-4 translate-x-px fill-current" />
                    </span>
                  </button>
                  <p className="mt-2 truncate font-medium" title={a.album}>{a.album}</p>
                  <p className="truncate text-xs text-[var(--mp-ink-dim)]">{a.artist}{a.year && ` · ${a.year}`}</p>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => play(tracks())}>Play</ContextMenuItem>
                <ContextMenuItem onSelect={() => player.enqueue(tracks().map(toTrack), { next: true })}>Play Next</ContextMenuItem>
                <ContextMenuItem onSelect={() => player.enqueue(tracks().map(toTrack))}>Add to Now Playing</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onOpen(a.album, a.artist)}>Open Album</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
    </div>
  );
}

function NameList({ names, items, keyOf, onOpen, icon }: { names: [string, number][]; items: LibraryItem[]; keyOf: (i: LibraryItem) => string; onOpen: (name: string) => void; icon: ReactNode }) {
  if (names.length === 0) return <p className="grid flex-1 place-items-center p-8 text-[var(--mp-ink-faint)]">Nothing here yet.</p>;
  const tracks = (name: string) => items.filter((i) => keyOf(i) === name).sort(byAlbumOrder);
  return (
    <div className="mp-scroll min-h-0 flex-1 overflow-y-auto p-2">
      {names.map(([name, count]) => (
        <ContextMenu key={name}>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={() => onOpen(name)}
              className="mp-row flex w-full items-center gap-3 rounded-md px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mp-accent)]"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--mp-pane-2)] text-[var(--mp-ink-dim)]">{icon}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
              <span className="text-xs tabular-nums text-[var(--mp-ink-faint)]">{count} song{count === 1 ? '' : 's'}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => play(tracks(name))}>Play</ContextMenuItem>
            <ContextMenuItem onSelect={() => player.enqueue(tracks(name).map(toTrack), { next: true })}>Play Next</ContextMenuItem>
            <ContextMenuItem onSelect={() => player.enqueue(tracks(name).map(toTrack))}>Add to Now Playing</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onOpen(name)}>Open</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}

function PlaylistView({ path }: { path: string }) {
  const query = useQuery({ queryKey: ['music', 'playlist', path], queryFn: () => readPlaylistFile(path, { reach: true }) });
  const items = useMemo(
    () =>
      (query.data ?? []).map((t: Track): LibraryItem => ({
        location: t.location, mtimeMs: 0, size: 0, title: t.title, artist: t.artist, album: t.album, albumArtist: '', genre: '', year: '',
        track: null, disc: null, duration: t.duration, bitrate: null, video: t.video, added: 0, rating: 0, plays: 0, lastPlayed: null,
      })),
    [query.data],
  );
  if (query.isLoading) {
    return (
      <div className="space-y-2 p-4" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-5 w-full bg-foreground/10" />)}
      </div>
    );
  }
  if (query.isError) return <p className="p-8 text-[var(--mp-ink-faint)]">Couldn’t read this playlist.</p>;
  return <SongTable items={items} />;
}

function FoldersView() {
  const folders = useLibrary((s) => s.folders);
  return (
    <div className="mp-scroll min-h-0 flex-1 overflow-y-auto p-4">
      <p className="mb-3 max-w-prose text-[var(--mp-ink-dim)]">
        The library watches these folders for music and videos, the way Windows Media Player watched My Music.
      </p>
      <ul className="mb-4 space-y-1">
        {folders.map((f) => (
          <ContextMenu key={f}>
            <ContextMenuTrigger asChild>
              <li className="mp-pane flex items-center gap-2 rounded-md px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f}</span>
                <button type="button" className="mp-icon-btn size-6" aria-label={`Stop watching ${f}`} title="Remove" onClick={() => library.removeFolder(f)}>
                  <X className="size-4" />
                </button>
              </li>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => void showInFiles(f)}>Show in Files</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => library.removeFolder(f)}>Stop Watching</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </ul>
      <button
        type="button"
        className="mp-btn"
        onClick={async () => {
          const [path] = await pickPaths({ title: 'Add Folder to Library', directory: true, confirmLabel: 'Add' });
          if (path) library.addFolder(path);
        }}
      >
        <FolderPlus className="size-4" /> Add Folder…
      </button>
    </div>
  );
}

const VIEW_TITLES: Record<string, string> = {
  recent: 'Recently Added', artists: 'Artists', albums: 'Albums', songs: 'All Music', genres: 'Genres', years: 'Years',
  rated: 'Top Rated', videos: 'Videos', folders: 'Watched Folders',
};

export function LibraryView() {
  const items = useLibrary((s) => s.items);
  const playlists = useLibrary((s) => s.playlists);
  const scanning = useLibrary((s) => s.scanning);
  const scanned = useLibrary((s) => s.scanned);
  const loaded = useLibrary((s) => s.loaded);
  const [view, setView] = useState<View>({ kind: 'albums' });
  const [search, setSearch] = useState('');

  useEffect(() => {
    void library.load();
  }, []);

  const music = useMemo(() => items.filter((i) => !i.video), [items]);
  const q = search.trim().toLowerCase();

  const content = (() => {
    if (q) {
      const hits = items.filter((i) => `${i.title} ${i.artist} ${i.album} ${i.genre}`.toLowerCase().includes(q));
      return { title: `Search: “${search.trim()}”`, items: hits, node: <SongTable items={hits} /> };
    }
    const count = (key: (i: LibraryItem) => string): [string, number][] => {
      const m = new Map<string, number>();
      for (const i of music) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => collator.compare(a[0], b[0]));
    };
    switch (view.kind) {
      case 'recent': {
        const list = music.slice().sort((a, b) => b.added - a.added).slice(0, 300);
        return { title: VIEW_TITLES.recent, items: list, node: <SongTable items={list} /> };
      }
      case 'songs':
        return { title: VIEW_TITLES.songs, items: music, node: <SongTable items={music} /> };
      case 'rated': {
        const list = music.filter((i) => i.rating >= 4).sort((a, b) => b.rating - a.rating || b.plays - a.plays);
        return { title: VIEW_TITLES.rated, items: list, node: <SongTable items={list} /> };
      }
      case 'videos': {
        const list = items.filter((i) => i.video);
        return { title: VIEW_TITLES.videos, items: list, node: <SongTable items={list} /> };
      }
      case 'albums':
        return { title: VIEW_TITLES.albums, items: music, node: <AlbumGrid items={music} onOpen={(name, artist) => setView({ kind: 'album', name, artist })} /> };
      case 'artists':
        return { title: VIEW_TITLES.artists, items: music, node: <NameList icon={<Mic2 className="size-4" />} names={count(artistOf)} items={music} keyOf={artistOf} onOpen={(name) => setView({ kind: 'artist', name })} /> };
      case 'genres':
        return { title: VIEW_TITLES.genres, items: music, node: <NameList icon={<Tag className="size-4" />} names={count(genreOf)} items={music} keyOf={genreOf} onOpen={(name) => setView({ kind: 'genre', name })} /> };
      case 'years':
        return { title: VIEW_TITLES.years, items: music, node: <NameList icon={<CalendarDays className="size-4" />} names={count(yearOf)} items={music} keyOf={yearOf} onOpen={(name) => setView({ kind: 'year', name })} /> };
      case 'artist': {
        const list = music.filter((i) => artistOf(i) === view.name).sort(byAlbumOrder);
        return { title: view.name, items: list, node: <AlbumGrid items={list} onOpen={(name, artist) => setView({ kind: 'album', name, artist })} /> };
      }
      case 'album': {
        const list = music.filter((i) => albumOf(i) === view.name && artistOf(i) === view.artist).sort(byAlbumOrder);
        return {
          title: view.name,
          items: list,
          node: (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-end gap-4 border-b border-[var(--mp-line)] p-4">
                <Cover location={list[0]?.location} className="size-28 shadow-xl ring-1 ring-foreground/10" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--mp-ink-faint)]">Album</p>
                  <h3 className="truncate text-2xl font-bold">{view.name}</h3>
                  <p className="truncate text-[var(--mp-ink-dim)]">
                    {view.artist}
                    {list[0]?.year && ` · ${list[0].year}`} · {list.length} song{list.length === 1 ? '' : 's'}, {formatTime(list.reduce((n, i) => n + (i.duration ?? 0), 0))}
                  </p>
                </div>
              </div>
              <SongTable items={list} ordered />
            </div>
          ),
        };
      }
      case 'genre': {
        const list = music.filter((i) => genreOf(i) === view.name).sort(byAlbumOrder);
        return { title: view.name, items: list, node: <SongTable items={list} /> };
      }
      case 'year': {
        const list = music.filter((i) => yearOf(i) === view.name).sort(byAlbumOrder);
        return { title: view.name, items: list, node: <SongTable items={list} /> };
      }
      case 'playlist':
        return { title: view.path.slice(view.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''), items: null, node: <PlaylistView path={view.path} /> };
      case 'folders':
        return { title: VIEW_TITLES.folders, items: null, node: <FoldersView /> };
    }
  })();

  const nav = (v: View, icon: ReactNode, label: string, count?: number) => (
    <NavItem
      key={label}
      icon={icon}
      label={label}
      count={count}
      active={!q && view.kind === v.kind && (v.kind !== 'playlist' || (view.kind === 'playlist' && view.path === v.path))}
      onClick={() => {
        setSearch('');
        setView(v);
      }}
    />
  );
  const ic = 'size-4';
  const playable = content.items;

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Library" className="mp-pane mp-scroll flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-y-0 border-l-0 p-2 max-sm:hidden">
        <p className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-[var(--mp-ink-faint)]">Library</p>
        {nav({ kind: 'recent' }, <Clock className={ic} />, 'Recently Added')}
        {nav({ kind: 'artists' }, <Mic2 className={ic} />, 'Artists')}
        {nav({ kind: 'albums' }, <Disc3 className={ic} />, 'Albums')}
        {nav({ kind: 'songs' }, <Music2 className={ic} />, 'All Music', music.length)}
        {nav({ kind: 'genres' }, <Tag className={ic} />, 'Genres')}
        {nav({ kind: 'years' }, <CalendarDays className={ic} />, 'Years')}
        {nav({ kind: 'rated' }, <Star className={ic} />, 'Top Rated')}
        {nav({ kind: 'videos' }, <Film className={ic} />, 'Videos', items.length - music.length)}
        <p className="px-2 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-[var(--mp-ink-faint)]">Playlists</p>
        {playlists.length === 0 && <p className="px-2 text-xs text-[var(--mp-ink-faint)]">Save the Now Playing list to make one.</p>}
        {playlists.map((p) => (
          <ContextMenu key={p}>
            <ContextMenuTrigger asChild>{nav({ kind: 'playlist', path: p }, <ListMusic className={ic} />, p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''))}</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => void playPlaylist(p, 'play')}>Play</ContextMenuItem>
              <ContextMenuItem onSelect={() => void playPlaylist(p, 'next')}>Play Next</ContextMenuItem>
              <ContextMenuItem onSelect={() => void playPlaylist(p, 'enqueue')}>Add to Now Playing</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void showFileInFiles(p)}>Show in Files</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
        <p className="px-2 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-[var(--mp-ink-faint)]">Folders</p>
        {nav({ kind: 'folders' }, <FolderPlus className={ic} />, 'Watched Folders')}
      </nav>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--mp-line)] px-4 py-2">
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{content.title}</h2>
          {scanning && (
            <span className="flex items-center gap-1 text-xs text-[var(--mp-ink-dim)]" role="status">
              <RefreshCw className="size-3 motion-safe:animate-spin" /> Looking for music… {scanned > 0 && scanned}
            </span>
          )}
          {!scanning && getFsBridge() && (
            <button type="button" className="mp-icon-btn size-7" aria-label="Look for new music" title="Look for new music" onClick={() => void library.scan()}>
              <RefreshCw className="size-4" />
            </button>
          )}
          {playable && playable.length > 0 && (
            <>
              <button type="button" className="mp-btn" data-primary onClick={() => play(playable)}>
                <Play className="size-4 fill-current" /> Play
              </button>
              <button type="button" className="mp-btn" onClick={() => player.enqueue(playable.map(toTrack))} title="Add to Now Playing">
                <ListPlus className="size-4" /> <span className="max-md:hidden">Add to Now Playing</span>
              </button>
            </>
          )}
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-[var(--mp-ink-faint)]" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search library"
              aria-label="Search library"
              className="mp-input w-48 pl-8"
            />
          </label>
        </div>
        {!loaded ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-4 p-4" aria-hidden>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="aspect-square w-full bg-foreground/10" />
                <Skeleton className="h-4 w-3/4 bg-foreground/10" />
              </div>
            ))}
          </div>
        ) : items.length === 0 && !q && view.kind !== 'folders' && view.kind !== 'playlist' ? (
          <div className="grid flex-1 place-items-center p-8">
            <div className="max-w-sm rounded-xl border border-dashed border-[var(--mp-line)] px-8 py-12 text-center text-[var(--mp-ink-dim)]">
              {scanning ? 'Looking through your Music and Videos folders…' : 'No music yet. Put songs in your Music folder, or add another folder to watch.'}
              {!scanning && (
                <div className="mt-4">
                  <button type="button" className="mp-btn" onClick={() => setView({ kind: 'folders' })}>
                    <FolderPlus className="size-4" /> Watched Folders
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          content.node
        )}
      </section>
    </div>
  );
}
