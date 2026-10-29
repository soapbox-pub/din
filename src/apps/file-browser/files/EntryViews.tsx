import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBytes, isValidEntryName, joinPath } from '@/lib/fs';
import type { FsEntry } from '@/lib/fs';
import { typeLabel } from '@/lib/fileTypes';
import { FileIcon } from '@/shared/FileIcon';
import { canDropInto, draggedFiles, dropCopies, takeDrop } from './drag';
import { GRID_ZOOMS, ROW_HEIGHT } from './layout';

export type ViewMode = 'list' | 'grid';
export type SortKey = 'name' | 'size' | 'type' | 'modified';
export interface SortOrder {
  key: SortKey;
  descending: boolean;
}

/**
 * Shared date formatter. Constructing an Intl.DateTimeFormat is expensive
 * (~0.1ms), so per-row `toLocaleString` calls dominate render time on large
 * directories; a single cached instance makes formatting nearly free.
 */
const MTIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Padding inside the scroll area, around the items (px). */
const PAD = 8;
/** The list view's column header, sticky atop its scroll area (px). */
const HEADER_HEIGHT = 32;
const gridTileHeight = (icon: number) => icon + 52;
/** Extra rows rendered above/below the viewport to hide scroll pop-in. */
const OVERSCAN = 6;
/** How far the pointer must move before a press becomes a marquee drag. */
const DRAG_SLOP = 4;

export interface EntryViewProps {
  dir: string;
  entries: FsEntry[];
  mode: ViewMode;
  zoom: number;
  selection: ReadonlySet<string>;
  cursor: string | null;
  /** Names in this folder that are cut (drawn faded). */
  cut: ReadonlySet<string>;
  renaming: string | null;
  sort: SortOrder;
  /** Whether keyboard focus is in the view (selection draws stronger). */
  focused: boolean;
  /** Bumped whenever the cursor should be scrolled into view. */
  revealToken: number;
  onSort: (key: SortKey) => void;
  onItemPointerDown: (name: string, e: React.MouseEvent) => void;
  onItemClick: (name: string, e: React.MouseEvent) => void;
  onItemOpen: (name: string, e: React.MouseEvent) => void;
  /** Middle click: folders open in a new tab. */
  onItemMiddleClick: (name: string) => void;
  /** Replace the selection (marquee). */
  onSelect: (names: Set<string>, cursor: string | null) => void;
  onItemContextMenu: (name: string) => void;
  onBackgroundContextMenu: () => void;
  onItemDragStart: (name: string, e: React.DragEvent) => void;
  onDragEnd: () => void;
  /** Files dropped onto `target` (a folder in the view, or the view's own). */
  onDrop: (target: string, paths: string[], copy: boolean) => void;
  onRenameSubmit: (from: string, to: string) => void;
  onRenameCancel: () => void;
  /** Grid columns, for arrow-key navigation. */
  onColumnsChange: (columns: number) => void;
}

interface Layout {
  columns: number;
  itemWidth: number;
  itemHeight: number;
}

function layoutFor(mode: ViewMode, zoom: number, width: number): Layout {
  if (mode === 'list') return { columns: 1, itemWidth: Math.max(0, width - PAD * 2), itemHeight: ROW_HEIGHT };
  const { tile, icon } = GRID_ZOOMS[zoom] ?? GRID_ZOOMS[1];
  const columns = Math.max(1, Math.floor((width - PAD * 2) / tile));
  // Spread leftover width over the tiles, so the grid fills the row.
  return { columns, itemWidth: Math.floor((width - PAD * 2) / columns), itemHeight: gridTileHeight(icon) };
}

/**
 * The folder's contents as a details list or an icon grid, virtualized
 * either way (folders like /nix/store run to thousands of entries). Owns
 * pointer gestures - marquee selection, drag hover, drops - and leaves what
 * they mean to the tab.
 */
export const EntryView = memo(function EntryView(props: EntryViewProps) {
  const {
    dir, entries, mode, zoom, selection, cursor, cut, renaming, sort, focused, revealToken,
    onSort, onItemPointerDown, onItemClick, onItemOpen, onItemMiddleClick, onSelect, onItemContextMenu,
    onBackgroundContextMenu, onItemDragStart, onDragEnd, onDrop, onRenameSubmit,
    onRenameCancel, onColumnsChange,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setSize((s) =>
        s.width === el.clientWidth && s.height === el.clientHeight
          ? s
          : { width: el.clientWidth, height: el.clientHeight },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = layoutFor(mode, zoom, size.width);
  const { columns, itemWidth, itemHeight } = layout;
  const rows = Math.ceil(entries.length / columns);
  const totalHeight = rows * itemHeight + PAD * 2;
  const headerHeight = mode === 'list' ? HEADER_HEIGHT : 0;

  useEffect(() => {
    onColumnsChange(columns);
  }, [columns, onColumnsChange]);

  // Keep the cursor in view when the keyboard moves it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || cursor === null || revealToken === 0) return;
    const index = entries.findIndex((e) => e.name === cursor);
    if (index === -1) return;
    // In the scroll area's coordinates, where the header sits on top.
    const top = PAD + Math.floor(index / columns) * itemHeight;
    if (top < el.scrollTop) el.scrollTop = top - PAD;
    else if (top + headerHeight + itemHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + headerHeight + itemHeight - el.clientHeight + PAD;
    }
    // Only on an explicit reveal, not on every cursor change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken]);

  const firstRow = Math.max(0, Math.floor((scrollTop - headerHeight - PAD) / itemHeight) - OVERSCAN);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + size.height) / itemHeight) + OVERSCAN);
  const start = firstRow * columns;
  const end = Math.min(entries.length, lastRow * columns);

  // ---- Marquee selection -------------------------------------------------

  const gesture = useRef<{
    x0: number;
    y0: number;
    clientX: number;
    clientY: number;
    base: Set<string>;
    toggle: boolean;
    active: boolean;
    raf: number;
  } | null>(null);

  const suppressClick = useRef(false);

  // Latest values for the window-level listeners.
  const live = useRef({ entries, layout, onSelect, headerHeight });
  useLayoutEffect(() => {
    live.current = { entries, layout, onSelect, headerHeight };
  });

  /** A client point in the items' coordinates (below the list header). */
  const contentPoint = (clientX: number, clientY: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const header = live.current.headerHeight;
    return {
      x: Math.max(0, Math.min(el.scrollWidth, clientX - rect.left + el.scrollLeft)),
      y: Math.max(0, Math.min(el.scrollHeight - header, clientY - rect.top + el.scrollTop - header)),
    };
  };

  const updateMarquee = useCallback(() => {
    const g = gesture.current;
    if (!g || !g.active) return;
    const { x, y } = contentPoint(g.clientX, g.clientY);
    const box = { x0: g.x0, y0: g.y0, x1: x, y1: y };
    setMarquee(box);
    const { entries, layout: { columns, itemWidth, itemHeight }, onSelect } = live.current;
    const left = Math.min(box.x0, box.x1);
    const right = Math.max(box.x0, box.x1);
    const top = Math.min(box.y0, box.y1);
    const bottom = Math.max(box.y0, box.y1);
    const next = new Set(g.base);
    let last: string | null = null;
    const firstRow = Math.max(0, Math.floor((top - PAD) / itemHeight));
    const lastRow = Math.floor((bottom - PAD) / itemHeight);
    for (let row = firstRow; row <= lastRow; row++) {
      for (let col = 0; col < columns; col++) {
        const i = row * columns + col;
        if (i >= entries.length) break;
        const ix = PAD + col * itemWidth;
        const iy = PAD + row * itemHeight;
        // Grid tiles have a margin; list rows are hit anywhere along their width.
        const inset = columns > 1 || itemHeight !== ROW_HEIGHT ? 6 : 0;
        if (ix + inset > right || ix + itemWidth - inset < left) continue;
        if (iy + inset > bottom || iy + itemHeight - inset < top) continue;
        const name = entries[i].name;
        if (g.toggle && g.base.has(name)) next.delete(name);
        else next.add(name);
        last = name;
      }
    }
    onSelect(next, last);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const g = gesture.current;
      if (!g) return;
      g.clientX = e.clientX;
      g.clientY = e.clientY;
      if (!g.active) {
        const { x, y } = contentPoint(e.clientX, e.clientY);
        if (Math.hypot(x - g.x0, y - g.y0) < DRAG_SLOP) return;
        g.active = true;
        // Auto-scroll while the pointer is past the top or bottom edge.
        const tick = () => {
          const gg = gesture.current;
          const el = scrollRef.current;
          if (!gg || !el) return;
          const rect = el.getBoundingClientRect();
          const over = gg.clientY < rect.top ? gg.clientY - rect.top : gg.clientY > rect.bottom ? gg.clientY - rect.bottom : 0;
          if (over !== 0) {
            el.scrollTop += Math.max(-40, Math.min(40, over / 2));
            updateMarquee();
          }
          gg.raf = requestAnimationFrame(tick);
        };
        g.raf = requestAnimationFrame(tick);
      }
      updateMarquee();
    };
    const onUp = () => {
      const g = gesture.current;
      if (!g) return;
      // The click that ends a marquee isn't a click on the row it ends on.
      suppressClick.current = g.active;
      cancelAnimationFrame(g.raf);
      gesture.current = null;
      setMarquee(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [updateMarquee]);

  const startMarquee = (e: React.MouseEvent, keepSelection: boolean) => {
    const { x, y } = contentPoint(e.clientX, e.clientY);
    gesture.current = {
      x0: x,
      y0: y,
      clientX: e.clientX,
      clientY: e.clientY,
      base: keepSelection ? new Set(selection) : new Set(),
      toggle: e.ctrlKey || e.metaKey,
      active: false,
      raf: 0,
    };
  };

  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, button')) return;
    const row = target.closest<HTMLElement>('[data-entry]');
    if (row) {
      // On a list row, but outside its name: a click selects the row, a
      // drag draws a marquee (as in Explorer's details view).
      if (mode !== 'list' || target.closest('[data-grip]')) return;
      const name = row.dataset.entry!;
      onItemPointerDown(name, e);
      startMarquee(e, e.ctrlKey || e.metaKey || e.shiftKey);
      return;
    }
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!additive) onSelect(new Set(), null);
    startMarquee(e, additive);
  };

  // ---- Drops ---------------------------------------------------------------

  const acceptDrop = (e: React.DragEvent, target: string): boolean => {
    const drag = draggedFiles(e);
    if (!drag || !canDropInto(drag.paths, target, dropCopies(e))) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = dropCopies(e) ? 'copy' : 'move';
    return true;
  };

  const folderTarget = (e: React.DragEvent): string | null => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]');
    if (row?.dataset.folder !== 'true') return null;
    return row.dataset.entry!;
  };

  const onDragOver = (e: React.DragEvent) => {
    const folder = folderTarget(e);
    if (folder !== null && acceptDrop(e, joinPath(dir, folder))) {
      setDropTarget(folder);
      return;
    }
    setDropTarget(null);
    if (folder === null || !draggedFiles(e)) acceptDrop(e, dir);
  };

  const onDropEvent = (e: React.DragEvent) => {
    setDropTarget(null);
    const folder = folderTarget(e);
    const target = folder !== null ? joinPath(dir, folder) : dir;
    if (!acceptDrop(e, target)) return;
    void takeDrop(e, dropCopies(e)).then((dropped) => {
      if (!dropped) return;
      const paths = dropped.paths.filter((p) => canDropInto([p], target, dropped.copy));
      if (paths.length > 0) onDrop(target, paths, dropped.copy);
    });
  };

  // ---- Render ----------------------------------------------------------------

  const visible = entries.slice(start, end);

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="listbox"
        aria-multiselectable
        aria-label="Folder contents"
        aria-activedescendant={cursor !== null ? entryDomId(dir, cursor) : undefined}
        tabIndex={0}
        data-files-view
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onMouseDown={onBackgroundMouseDown}
        onClick={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          const target = e.target as HTMLElement;
          const row = target.closest<HTMLElement>('[data-entry]');
          if (!row || (mode === 'grid' && !target.closest('[data-grip]'))) return;
          onItemClick(row.dataset.entry!, e);
        }}
        onAuxClick={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]');
          if (e.button === 1 && row) onItemMiddleClick(row.dataset.entry!);
        }}
        onContextMenu={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]');
          if (row) onItemContextMenu(row.dataset.entry!);
          else onBackgroundContextMenu();
        }}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDrop={onDropEvent}
        className="relative min-h-0 flex-1 select-none overflow-y-auto overflow-x-hidden outline-none"
      >
        {mode === 'list' && <ListHeader sort={sort} onSort={onSort} />}
        <div className="relative" style={{ height: totalHeight }}>
          {visible.map((entry, i) => {
            const index = start + i;
            const top = PAD + Math.floor(index / columns) * itemHeight;
            const left = PAD + (index % columns) * itemWidth;
            const Item = mode === 'list' ? ListRow : GridTile;
            return (
              <Item
                key={entry.name}
                id={entryDomId(dir, entry.name)}
                dir={dir}
                entry={entry}
                top={top}
                left={left}
                width={itemWidth}
                height={itemHeight}
                iconPx={mode === 'grid' ? (GRID_ZOOMS[zoom] ?? GRID_ZOOMS[1]).icon : 20}
                selected={selection.has(entry.name)}
                isCursor={cursor === entry.name}
                focused={focused}
                isCut={cut.has(entry.name)}
                isDropTarget={dropTarget === entry.name}
                renaming={renaming === entry.name}
                onPointerDown={onItemPointerDown}
                onOpen={onItemOpen}
                onDragStart={onItemDragStart}
                onDragEnd={onDragEnd}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
              />
            );
          })}
          {marquee && (
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-sm border border-primary/60 bg-primary/10"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
});

/** DOM id for an entry (for aria-activedescendant). */
function entryDomId(dir: string, name: string): string {
  let hash = 0;
  const s = `${dir}/${name}`;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return `files-entry-${(hash >>> 0).toString(36)}`;
}

const COLUMNS: { key: SortKey; label: string; className: string; align?: 'right' }[] = [
  { key: 'name', label: 'Name', className: 'min-w-0 flex-1' },
  { key: 'size', label: 'Size', className: 'w-20 shrink-0', align: 'right' },
  { key: 'type', label: 'Type', className: 'hidden w-32 shrink-0 @xl:flex' },
  { key: 'modified', label: 'Modified', className: 'hidden w-40 shrink-0 @md:flex' },
];

function ListHeader({ sort, onSort }: { sort: SortOrder; onSort: (key: SortKey) => void }) {
  return (
    <div
      role="row"
      className="sticky top-0 z-10 flex h-8 items-stretch gap-3 border-b border-border/60 bg-background/95 px-4 text-xs text-muted-foreground backdrop-blur-sm"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {COLUMNS.map((col) => {
        const active = sort.key === col.key;
        return (
          <button
            key={col.key}
            type="button"
            role="columnheader"
            aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
            onClick={() => onSort(col.key)}
            className={cn(
              col.className,
              'flex items-center gap-1 rounded-sm font-medium hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              col.align === 'right' && 'justify-end',
              active && 'text-foreground',
            )}
          >
            {col.label}
            {active &&
              (sort.descending ? (
                <ChevronDown className="size-3.5" aria-hidden />
              ) : (
                <ChevronUp className="size-3.5" aria-hidden />
              ))}
          </button>
        );
      })}
    </div>
  );
}

interface ItemProps {
  id: string;
  dir: string;
  entry: FsEntry;
  top: number;
  left: number;
  width: number;
  height: number;
  iconPx: number;
  selected: boolean;
  isCursor: boolean;
  focused: boolean;
  isCut: boolean;
  isDropTarget: boolean;
  renaming: boolean;
  onPointerDown: (name: string, e: React.MouseEvent) => void;
  onOpen: (name: string, e: React.MouseEvent) => void;
  onDragStart: (name: string, e: React.DragEvent) => void;
  onDragEnd: () => void;
  onRenameSubmit: (from: string, to: string) => void;
  onRenameCancel: () => void;
}

function itemTone({ selected, isCursor, focused, isDropTarget }: ItemProps) {
  return cn(
    isDropTarget
      ? 'bg-primary/25 ring-2 ring-primary'
      : selected
        ? focused
          ? 'bg-primary/20'
          : 'bg-foreground/10'
        : 'hover:bg-foreground/5',
    isCursor && focused && !isDropTarget && 'ring-1 ring-inset ring-primary/50',
  );
}

/**
 * An entry's own name and, for a search result from a subfolder (named by
 * its path beneath the folder shown), that subfolder.
 */
function splitName(name: string): [string, string | null] {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? [name, null] : [name.slice(slash + 1), name.slice(0, slash)];
}

const ListRow = memo(function ListRow(props: ItemProps) {
  const { id, dir, entry, top, left, width, height, iconPx, selected, isCut, renaming } = props;
  const path = joinPath(dir, entry.name);
  const [name, folder] = splitName(entry.name);
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-entry={entry.name}
      data-folder={entry.kind === 'directory'}
      className={cn(
        'absolute flex items-center gap-3 rounded-md px-2 text-sm',
        itemTone(props),
        entry.kind === 'other' && 'opacity-60',
      )}
      style={{ top, left, width, height }}
      onDoubleClick={(e) => props.onOpen(entry.name, e)}
    >
      <div
        data-grip
        draggable={!renaming}
        onMouseDown={(e) => {
          if (e.button === 0) props.onPointerDown(entry.name, e);
        }}
        onDragStart={(e) => props.onDragStart(entry.name, e)}
        onDragEnd={props.onDragEnd}
        className={cn('flex min-w-0 items-center gap-2', renaming ? 'flex-1' : 'max-w-full', isCut && 'opacity-50')}
      >
        <FileIcon
          path={path}
          name={name}
          kind={entry.kind}
          size={entry.size}
          mtimeMs={entry.mtimeMs}
          symlink={entry.symlink}
          px={iconPx}
        />
        {renaming ? (
          <RenameInput entry={entry} onSubmit={props.onRenameSubmit} onCancel={props.onRenameCancel} />
        ) : (
          <span className="truncate text-foreground">{name}</span>
        )}
      </div>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={folder ?? undefined}>
        {folder}
      </span>
      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {entry.kind === 'file' && entry.size !== null ? formatBytes(entry.size) : ''}
      </span>
      <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground @xl:block">
        {typeLabel(name, entry.kind)}
      </span>
      <span className="hidden w-40 shrink-0 truncate text-xs tabular-nums text-muted-foreground @md:block">
        {entry.mtimeMs !== null ? MTIME_FORMAT.format(entry.mtimeMs) : ''}
      </span>
    </div>
  );
});

const GridTile = memo(function GridTile(props: ItemProps) {
  const { id, dir, entry, top, left, width, height, iconPx, selected, isCut, renaming } = props;
  const path = joinPath(dir, entry.name);
  const [name] = splitName(entry.name);
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-entry={entry.name}
      data-folder={entry.kind === 'directory'}
      className="absolute p-1"
      style={{ top, left, width, height }}
    >
      <div
        data-grip
        draggable={!renaming}
        onMouseDown={(e) => {
          if (e.button === 0) props.onPointerDown(entry.name, e);
        }}
        onDoubleClick={(e) => props.onOpen(entry.name, e)}
        onDragStart={(e) => props.onDragStart(entry.name, e)}
        onDragEnd={props.onDragEnd}
        className={cn(
          'flex h-full flex-col items-center gap-1 rounded-lg px-1 pt-2 text-center',
          itemTone(props),
          (isCut || entry.kind === 'other') && 'opacity-50',
        )}
        title={entry.name}
      >
        <FileIcon
          path={path}
          name={name}
          kind={entry.kind}
          size={entry.size}
          mtimeMs={entry.mtimeMs}
          symlink={entry.symlink}
          px={iconPx}
        />
        {renaming ? (
          <RenameInput entry={entry} onSubmit={props.onRenameSubmit} onCancel={props.onRenameCancel} centered />
        ) : (
          <span
            className={cn(
              'line-clamp-2 w-full break-words px-0.5 text-xs leading-4 text-foreground',
              selected && 'font-medium',
            )}
          >
            {name}
          </span>
        )}
      </div>
    </div>
  );
});

/**
 * Inline rename field. Selects the name without its extension, as native
 * file managers do; Enter commits, Escape or clicking away cancels.
 */
function RenameInput({
  entry,
  onSubmit,
  onCancel,
  centered,
}: {
  entry: FsEntry;
  onSubmit: (from: string, to: string) => void;
  onCancel: () => void;
  centered?: boolean;
}) {
  const [name] = splitName(entry.name);
  const [value, setValue] = useState(name);
  const valid = isValidEntryName(value.trim());
  const done = useRef(false);

  return (
    <input
      type="text"
      aria-label={`Rename ${name}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          done.current = true;
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (!valid) return;
          done.current = true;
          onSubmit(entry.name, value.trim());
        }
      }}
      onBlur={() => {
        if (done.current) return;
        // Clicking away keeps a valid edit, like Nautilus and Finder.
        if (valid && value.trim() !== name) onSubmit(entry.name, value.trim());
        else onCancel();
      }}
      ref={(el) => {
        if (!el || el.dataset.ready) return;
        el.dataset.ready = 'true';
        el.focus();
        const dot = entry.kind === 'directory' ? -1 : name.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : name.length);
      }}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        'h-6 w-full min-w-0 rounded border bg-background px-1.5 text-sm text-foreground shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2',
        centered && 'text-center text-xs',
        valid
          ? 'border-border focus-visible:ring-ring/70'
          : 'border-destructive/60 focus-visible:ring-destructive/40',
      )}
    />
  );
}
