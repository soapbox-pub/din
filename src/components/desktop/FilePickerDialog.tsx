import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  EyeOff,
  Folder,
  HardDrive,
  Home,
  RotateCw,
  Star,
  Usb,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  cleanFsError,
  compareEntriesBy,
  formatBytes,
  getFsBridge,
  joinPath,
  parentPath,
} from '@/lib/fs';
import type { FsEntry } from '@/lib/fs';
import { extensionFilter, filterMatches } from '@/lib/fileFilters';
import { recordPickedFiles } from '@/lib/pickedFiles';
import { useBookmarks, useDirectory, useHomeDir, useRecentFiles } from '@/hooks/useFileSystem';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { useVolumes } from '@/hooks/useVolumes';
import type { FilePickerOptions, FilePickerResult } from '@/contexts/FilePickerContext';
import { FileIcon } from '@/components/desktop/apps/files/FileIcon';
import { USER_DIRS } from '@/components/desktop/apps/files/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface FilePickerDialogProps {
  options: FilePickerOptions;
  onConfirm: (result: FilePickerResult) => void;
  onCancel: () => void;
}

type SortKey = 'name' | 'size' | 'modified';
interface SortOrder {
  key: SortKey;
  descending: boolean;
}

interface PickerPrefs {
  /** How folders are sorted. */
  sort: SortOrder;
  /** How Recent is sorted (kept apart: it's nearly always wanted newest first). */
  recentSort: SortOrder;
  showHidden: boolean;
}

const DEFAULT_PREFS: PickerPrefs = {
  sort: { key: 'modified', descending: true },
  recentSort: { key: 'modified', descending: true },
  showHidden: false,
};

/** The sidebar's Recent place; never a real path, which always starts with `/`. */
const RECENT = 'recent:';

/** A row: an entry and where it is (Recent's come from many folders). */
interface PickerItem {
  entry: FsEntry;
  path: string;
  /** The date shown: when it was modified, or in Recent, last used. */
  when: number | null;
}

/**
 * In-Din modal file picker. Reuses the `window.fs` bridge (via the same
 * TanStack Query hooks as the Files app) to browse the real filesystem, but
 * renders entirely inside Din — no host OS dialog. It opens one file or
 * several, chooses folders, or asks where to save a new file, as the
 * request says; Din's own features use it, and so do web pages' uploads
 * and native apps' file dialogs (through the desktop portal).
 *
 * Opening files starts in Recent (the newest screenshots, downloads, and
 * files picked before) unless the asker names a folder. The sidebar has the
 * Files app's places and Favorites, and the sort order is remembered.
 */
export function FilePickerDialog({ options, onConfirm, onCancel }: FilePickerDialogProps) {
  const bridge = getFsBridge();
  const home = useHomeDir();
  const saving = options.mode === 'save';
  const directory = options.directory === true && !saving;
  const multiple = options.multiple === true && !saving;
  const hasRecent = !saving && !directory;

  const [storedPrefs, setPrefs] = useLocalStorage<PickerPrefs>('din:filepicker:prefs', DEFAULT_PREFS);
  const prefs = useMemo(() => ({ ...DEFAULT_PREFS, ...storedPrefs }), [storedPrefs]);

  const filters = useMemo(
    () =>
      options.filters?.length
        ? options.filters
        : options.extensions?.length
          ? [extensionFilter(options.extensions)]
          : [],
    [options.filters, options.extensions],
  );
  const [filterIndex, setFilterIndex] = useState(() =>
    Math.min(Math.max(options.currentFilter ?? 0, 0), Math.max(filters.length - 1, 0)),
  );
  const filter = filters[filterIndex] ?? null;

  /** A folder, `RECENT`, or null for home (once it resolves). */
  const [cwd, setCwd] = useState<string | null>(options.initialPath ?? (hasRecent ? RECENT : null));
  /** Paths selected. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** Where a Shift+click range starts. */
  const anchorRef = useRef<string | null>(null);
  const [name, setName] = useState(options.currentName ?? '');
  /** A save that would replace this path, waiting for the user to say so. */
  const [replacing, setReplacing] = useState<string | null>(null);

  const location = cwd ?? home.data ?? null;
  const inRecent = location === RECENT;
  /** The folder shown, or null in Recent (and while home loads). */
  const folder = inRecent ? null : location;
  const listing = useDirectory(folder);
  const recent = useRecentFiles(inRecent);
  const bookmarks = useBookmarks(home.data);
  const homeListing = useDirectory(home.data ?? null);
  const volumes = useVolumes();

  const sort = inRecent ? prefs.recentSort : prefs.sort;
  const showHidden = prefs.showHidden;

  const items = useMemo<PickerItem[]>(() => {
    const compare = compareEntriesBy(sort.key, sort.descending);
    if (inRecent) {
      return (recent.data ?? [])
        // Recent lists only what can be chosen; a folder dims the rest instead.
        .filter((f) => filterMatches(filter, f.name))
        .map((f) => ({ entry: f, path: f.path, when: f.usedMs }))
        // Sorting by date means by when it was last used, which is what Recent shows.
        .sort((a, b) => compare({ ...a.entry, mtimeMs: a.when }, { ...b.entry, mtimeMs: b.when }));
    }
    if (folder === null) return [];
    return (listing.data?.entries ?? [])
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .sort(compare)
      .map((entry) => ({ entry, path: joinPath(folder, entry.name), when: entry.mtimeMs }));
  }, [inRecent, recent.data, filter, folder, listing.data, showHidden, sort]);
  const byPath = useMemo(() => new Map(items.map((item) => [item.path, item])), [items]);

  /** Whether an entry can be what the picker returns. */
  const choosable = useCallback(
    (entry: FsEntry) =>
      directory ? entry.kind === 'directory' : entry.kind === 'file' && filterMatches(filter, entry.name),
    [directory, filter],
  );

  const sections = useMemo(() => {
    const places: Place[] = [];
    if (hasRecent) places.push({ name: 'Recent', path: RECENT, icon: Clock });
    if (home.data) {
      places.push({ name: 'Home', path: home.data, icon: Home });
      const present = new Set(
        (homeListing.data?.entries ?? []).filter((e) => e.kind === 'directory').map((e) => e.name),
      );
      for (const dir of USER_DIRS) {
        if (present.has(dir.name)) places.push({ name: dir.name, path: joinPath(home.data, dir.name), icon: dir.icon });
      }
    }
    const favorites = bookmarks.bookmarks.map<Place>((b) => ({
      name: b.label ?? (b.path === '/' ? '/' : b.path.slice(b.path.lastIndexOf('/') + 1)),
      path: b.path,
      icon: Folder,
    }));
    const devices: Place[] = [
      { name: 'Computer', path: '/', icon: HardDrive },
      ...(volumes.data?.volumes ?? []).flatMap((v) =>
        v.mountPoint ? [{ name: v.name, path: v.mountPoint, icon: Usb }] : [],
      ),
    ];
    return [
      { label: 'Places', places },
      { label: 'Favorites', places: favorites },
      { label: 'Devices', places: devices },
    ];
  }, [hasRecent, home.data, homeListing.data, bookmarks.bookmarks, volumes.data]);

  const navigate = useCallback((target: string) => {
    setSelected(new Set());
    anchorRef.current = null;
    setReplacing(null);
    setCwd(target === RECENT || target.length <= 1 ? target || '/' : target.replace(/\/+$/, ''));
  }, []);

  const setSort = (key: SortKey) =>
    setPrefs((stored) => {
      const p = { ...DEFAULT_PREFS, ...stored };
      const field = inRecent ? 'recentSort' : 'sort';
      const current = p[field];
      return {
        ...p,
        [field]: {
          key,
          descending: current.key === key ? !current.descending : key !== 'name',
        },
      };
    });
  const toggleHidden = () =>
    setPrefs((stored) => ({ ...DEFAULT_PREFS, ...stored, showHidden: !(stored.showHidden ?? false) }));

  const finish = useCallback(
    (paths: string[]) => {
      if (!directory) recordPickedFiles(paths);
      onConfirm({ paths, filter: filter ? filterIndex : null });
    },
    [directory, onConfirm, filter, filterIndex],
  );

  /** Save under `fileName` in the current folder, asking before replacing a file. */
  const save = useCallback(
    (fileName: string) => {
      const clean = fileName.trim();
      if (folder === null || !clean || clean.includes('/') || clean === '.' || clean === '..') return;
      const target = joinPath(folder, clean);
      const existing = byPath.get(target);
      if (existing?.entry.kind === 'directory') return navigate(target);
      if (existing && replacing !== target) return setReplacing(target);
      finish([target]);
    },
    [folder, byPath, replacing, navigate, finish],
  );

  const selectedPaths = useMemo(
    () => [...selected].filter((p) => {
      const item = byPath.get(p);
      return item !== undefined && choosable(item.entry);
    }),
    [selected, byPath, choosable],
  );

  const canConfirm = saving
    ? folder !== null && name.trim() !== '' && !name.includes('/')
    : directory
      ? folder !== null
      : selectedPaths.length > 0;

  const confirm = () => {
    if (saving) return save(name);
    if (directory) {
      if (selectedPaths.length > 0) finish(selectedPaths);
      else if (folder) finish([folder]);
      return;
    }
    if (selectedPaths.length > 0) finish(selectedPaths);
  };

  const clickItem = useCallback(
    (item: PickerItem, event: React.MouseEvent) => {
      const { entry, path } = item;
      if (saving) {
        if (entry.kind === 'file') {
          setName(entry.name);
          setReplacing(null);
        }
        return;
      }
      if (!choosable(entry)) {
        setSelected(new Set());
        return;
      }
      const toggle = multiple && (event.ctrlKey || event.metaKey);
      const range = multiple && event.shiftKey && anchorRef.current !== null;
      if (range) {
        const paths = items.filter((i) => choosable(i.entry)).map((i) => i.path);
        const from = paths.indexOf(anchorRef.current!);
        const to = paths.indexOf(path);
        if (from !== -1 && to !== -1) {
          setSelected(new Set(paths.slice(Math.min(from, to), Math.max(from, to) + 1)));
          return;
        }
      }
      anchorRef.current = path;
      setSelected((current) => {
        if (!toggle) return new Set([path]);
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        return next;
      });
    },
    [saving, choosable, multiple, items],
  );

  const openItem = useCallback(
    (item: PickerItem) => {
      const { entry, path } = item;
      if (entry.kind === 'directory') navigate(path);
      else if (saving && entry.kind === 'file') {
        setName(entry.name);
        save(entry.name);
      } else if (choosable(entry)) finish([path]);
    },
    [navigate, saving, save, choosable, finish],
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = nameRef.current;
    if (!input) return dialogRef.current?.focus();
    input.focus();
    // The name without its extension, ready to type over.
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }, []);

  const favorite = folder !== null && bookmarks.bookmarks.some((b) => b.path === folder);

  const title =
    options.title ??
    (saving ? 'Save file' : directory ? 'Choose a folder' : multiple ? 'Choose files' : 'Choose a file');
  const confirmLabel = replacing
    ? 'Replace'
    : (options.confirmLabel ?? (saving ? 'Save' : directory ? 'Select' : 'Open'));

  let status: React.ReactNode;
  if (replacing) {
    status = (
      <span className="text-foreground">
        “{replacing.split('/').pop()}” already exists. Replace it?
      </span>
    );
  } else if (selectedPaths.length === 1) {
    status = <span className="text-foreground">{selectedPaths[0].split('/').pop()}</span>;
  } else if (selectedPaths.length > 1) {
    status = <span className="text-foreground">{selectedPaths.length} items selected</span>;
  } else if (directory) {
    status = 'Select a folder, or choose the one that’s open';
  } else if (filter && filters.length === 1) {
    status = `Select a file (${filter.name})`;
  } else {
    status = multiple ? 'Select files (Ctrl+click for more)' : 'Select a file';
  }

  const query = inRecent ? recent : listing;
  let body: React.ReactNode;
  if (!bridge) {
    body = (
      <FallbackMessage>
        The file picker needs the Din desktop shell and isn't available
        in a plain browser.
      </FallbackMessage>
    );
  } else if (query.isError) {
    body = <FallbackMessage>{cleanFsError(query.error)}</FallbackMessage>;
  } else if (location === null || query.isLoading) {
    body = (
      <div className="space-y-1 p-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  } else {
    body = (
      // Keyed by place so scroll position resets on navigation.
      <PickerList
        key={location}
        items={items}
        home={home.data}
        showLocation={inRecent}
        sort={sort}
        onSort={setSort}
        empty={
          inRecent
            ? filter
              ? `No recent ${filter.name || 'files'}.`
              : 'No recent files.'
            : 'This folder is empty.'
        }
        choosable={choosable}
        dimmed={(entry) => entry.kind !== 'directory' && !(saving ? filterMatches(filter, entry.name) : choosable(entry))}
        selected={selected}
        multiple={multiple}
        onClick={clickItem}
        onOpen={openItem}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/50 p-6"
      onPointerDown={(e) => {
        // Click on the backdrop (not the dialog) cancels.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex h-[600px] max-h-full w-[900px] max-w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl outline-none"
        onKeyDown={(e) => {
          const typing = e.target instanceof HTMLInputElement;
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            if (canConfirm) confirm();
          } else if (
            folder &&
            folder !== '/' &&
            ((e.altKey && e.key === 'ArrowUp') || (e.key === 'Backspace' && !typing))
          ) {
            e.preventDefault();
            navigate(parentPath(folder));
          } else if (e.ctrlKey && e.key.toLowerCase() === 'h') {
            e.preventDefault();
            toggleHidden();
          } else if (multiple && e.ctrlKey && e.key.toLowerCase() === 'a' && !typing) {
            e.preventDefault();
            setSelected(new Set(items.filter((i) => choosable(i.entry)).map((i) => i.path)));
          }
        }}
      >
        {/* Header / toolbar */}
        <header className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
          <h2 className="mr-2 truncate text-sm font-semibold text-foreground">{title}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Parent folder"
            disabled={!folder || folder === '/'}
            onClick={() => folder && navigate(parentPath(folder))}
          >
            <ArrowUp className="size-4" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Refresh"
            onClick={() => query.refetch()}
          >
            <RotateCw className={cn('size-4', query.isFetching && 'animate-spin')} aria-hidden />
          </Button>
          <div className="ml-1 min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            {inRecent ? 'Recent' : (location ?? 'Loading…')}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
            aria-pressed={favorite}
            title={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
            disabled={folder === null}
            onClick={() => {
              if (!folder) return;
              if (favorite) bookmarks.remove(folder);
              else bookmarks.add(folder);
            }}
          >
            <Star className={cn('size-4', favorite && 'fill-current text-primary')} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            aria-pressed={showHidden}
            title="Show hidden files (Ctrl+H)"
            disabled={inRecent}
            onClick={toggleHidden}
          >
            {showHidden ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
          </Button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Places sidebar */}
          <nav
            aria-label="Places"
            className="hidden w-44 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border/60 bg-muted/20 p-2 sm:flex"
          >
            {sections.map((section) =>
              section.places.length === 0 ? null : (
                <div key={section.label} className="flex flex-col gap-0.5">
                  <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.label}
                  </p>
                  {section.places.map((place) => {
                    const active = location === place.path;
                    return (
                      <button
                        key={place.path}
                        type="button"
                        title={place.path === RECENT ? undefined : place.path}
                        aria-current={active ? 'location' : undefined}
                        onClick={() => navigate(place.path)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active
                            ? 'bg-primary/15 font-medium text-foreground'
                            : 'text-foreground/80 hover:bg-foreground/10 hover:text-foreground',
                        )}
                      >
                        <place.icon
                          className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
                          aria-hidden
                        />
                        <span className="truncate">{place.name}</span>
                      </button>
                    );
                  })}
                </div>
              ),
            )}
          </nav>

          {/* File list */}
          <div className="min-w-0 flex-1 overflow-hidden">{body}</div>
        </div>

        {/* Footer */}
        <footer className="space-y-2 border-t border-border/60 bg-muted/30 px-3 py-2">
          {saving && (
            <label className="flex items-center gap-2 text-sm">
              <span className="shrink-0 text-muted-foreground">Name</span>
              <Input
                ref={nameRef}
                value={name}
                aria-invalid={name.includes('/') || undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  setReplacing(null);
                }}
                className="h-8"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" aria-live="polite">
              {status}
            </p>
            <div className="flex items-center gap-2">
              {filters.length > 1 && (
                <Select
                  value={String(filterIndex)}
                  onValueChange={(value) => {
                    setFilterIndex(Number(value));
                    setSelected(new Set());
                  }}
                >
                  <SelectTrigger size="sm" className="h-8 max-w-48" aria-label="File type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[1001]">
                    {filters.map((f, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {f.name || 'Files'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant={replacing ? 'destructive' : 'default'}
                disabled={!canConfirm}
                onClick={confirm}
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

interface Place {
  name: string;
  path: string;
  icon: LucideIcon;
}

/** Fixed row height for the virtualized picker list (px). */
const ROW_HEIGHT = 32;
/** Extra rows rendered above/below the viewport to hide scroll pop-in. */
const OVERSCAN = 10;

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** "Today, 4:31 PM", "Yesterday, 9:02 AM", or "Oct 3, 2026". */
function formatWhen(ms: number): string {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return `Today, ${TIME_FORMAT.format(ms)}`;
  if (days === 1) return `Yesterday, ${TIME_FORMAT.format(ms)}`;
  return DATE_FORMAT.format(ms);
}

/** A folder for display, with home as `~`. */
function displayFolder(path: string, home: string | undefined): string {
  const dir = parentPath(path);
  if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`;
  return dir;
}

const COLUMNS: { key: SortKey | 'location'; label: string; className: string; align?: 'right' }[] = [
  { key: 'name', label: 'Name', className: 'min-w-0 flex-1' },
  { key: 'location', label: 'Location', className: 'hidden w-40 shrink-0 @2xl:flex' },
  { key: 'size', label: 'Size', className: 'w-20 shrink-0', align: 'right' },
  { key: 'modified', label: 'Modified', className: 'hidden w-36 shrink-0 @md:flex' },
];

/**
 * Virtualized picker listing under sortable column headers. Directory
 * listings can reach thousands of entries (the bridge caps at 5000);
 * windowing keeps the mounted DOM at ~viewport size, and memoized rows keep
 * a selection change from re-rendering every row.
 */
const PickerList = memo(function PickerList({
  items,
  home,
  showLocation,
  sort,
  onSort,
  empty,
  choosable,
  dimmed,
  selected,
  multiple,
  onClick,
  onOpen,
}: {
  items: PickerItem[];
  home: string | undefined;
  showLocation: boolean;
  sort: SortOrder;
  onSort: (key: SortKey) => void;
  empty: string;
  choosable: (entry: FsEntry) => boolean;
  dimmed: (entry: FsEntry) => boolean;
  selected: ReadonlySet<string>;
  multiple: boolean;
  onClick: (item: PickerItem, event: React.MouseEvent) => void;
  onOpen: (item: PickerItem) => void;
}) {
  const { containerRef, onScroll, start, end, totalHeight } = useVirtualRows({
    count: items.length,
    rowHeight: ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const columns = COLUMNS.filter((col) => showLocation || col.key !== 'location');

  return (
    <div ref={containerRef} onScroll={onScroll} className="@container flex h-full flex-col overflow-y-auto">
      {/* In the scroll area, so its columns line up with the rows' beside the scrollbar. */}
      <div
        role="row"
        className="sticky top-0 z-10 flex h-8 shrink-0 items-stretch gap-3 border-b border-border/60 bg-background px-4 text-xs text-muted-foreground"
      >
        {columns.map((col) => {
          const key = col.key;
          if (key === 'location') {
            return (
              <span key={key} role="columnheader" className={cn(col.className, 'items-center font-medium')}>
                {col.label}
              </span>
            );
          }
          const active = sort.key === key;
          return (
            <button
              key={key}
              type="button"
              role="columnheader"
              aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
              onClick={() => onSort(key)}
              className={cn(
                col.className,
                'flex items-center gap-1 rounded-sm font-medium hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                col.align === 'right' && 'justify-end',
                active && 'text-foreground',
              )}
            >
              {key === 'modified' && showLocation ? 'Date' : col.label}
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
      {items.length === 0 ? (
        <div className="min-h-0 flex-1">
          <FallbackMessage>{empty}</FallbackMessage>
        </div>
      ) : (
        <div className="p-1">
          <ul
            className="relative"
            style={{ height: totalHeight }}
            role="listbox"
            aria-multiselectable={multiple || undefined}
          >
            {items.slice(start, end).map((item, i) => (
              <PickerRow
                key={item.path}
                item={item}
                location={showLocation ? displayFolder(item.path, home) : null}
                top={(start + i) * ROW_HEIGHT}
                dim={dimmed(item.entry)}
                isSelected={selected.has(item.path) && choosable(item.entry)}
                onClick={onClick}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});

/** One row in the picker list, absolutely positioned within the virtual list. */
const PickerRow = memo(function PickerRow({
  item,
  location,
  top,
  dim,
  isSelected,
  onClick,
  onOpen,
}: {
  item: PickerItem;
  /** The containing folder, shown in Recent. */
  location: string | null;
  top: number;
  dim: boolean;
  isSelected: boolean;
  onClick: (item: PickerItem, event: React.MouseEvent) => void;
  onOpen: (item: PickerItem) => void;
}) {
  const { entry, path } = item;
  return (
    <li className="absolute inset-x-0" style={{ top, height: ROW_HEIGHT }} role="option" aria-selected={isSelected}>
      <button
        type="button"
        disabled={dim}
        title={location !== null ? path : undefined}
        onClick={(e) => onClick(item, e)}
        onDoubleClick={() => onOpen(item)}
        className={cn(
          'flex h-full w-full items-center gap-3 rounded-md px-3 text-left text-sm',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isSelected
            ? 'bg-primary/15 text-foreground'
            : 'text-foreground hover:bg-foreground/5',
          dim && 'opacity-40',
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <FileIcon
            path={path}
            name={entry.name}
            kind={entry.kind}
            size={entry.size}
            mtimeMs={entry.mtimeMs}
            symlink={entry.symlink}
            px={20}
          />
          <span className="truncate">{entry.name}</span>
        </span>
        {location !== null && (
          <span className="hidden w-40 shrink-0 truncate text-xs text-muted-foreground @2xl:block">
            {location}
          </span>
        )}
        <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {entry.kind === 'file' && entry.size !== null ? formatBytes(entry.size) : ''}
        </span>
        <span className="hidden w-36 shrink-0 truncate text-xs tabular-nums text-muted-foreground @md:block">
          {item.when !== null ? formatWhen(item.when) : ''}
        </span>
      </button>
    </li>
  );
});

function FallbackMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <p className="max-w-xs text-center text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
