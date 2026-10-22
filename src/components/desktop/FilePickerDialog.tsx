import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Download, Eye, EyeOff, Folder, HardDrive, Home, RotateCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  cleanFsError,
  formatBytes,
  getFsBridge,
  joinPath,
  parentPath,
  sortEntries,
} from '@/lib/fs';
import type { FsEntry } from '@/lib/fs';
import { extensionFilter, filterMatches } from '@/lib/fileFilters';
import { useDirectory, useHomeDir } from '@/hooks/useFileSystem';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import type { FilePickerOptions, FilePickerResult } from '@/contexts/FilePickerContext';
import { FileIcon } from '@/components/desktop/apps/files/FileIcon';
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

/**
 * In-Din modal file picker. Reuses the `window.fs` bridge (via the same
 * TanStack Query hooks as the Files app) to browse the real filesystem, but
 * renders entirely inside Din — no host OS dialog. It opens one file or
 * several, chooses folders, or asks where to save a new file, as the
 * request says; Din's own features use it, and so do web pages' uploads
 * and native apps' file dialogs (through the desktop portal).
 */
export function FilePickerDialog({ options, onConfirm, onCancel }: FilePickerDialogProps) {
  const bridge = getFsBridge();
  const home = useHomeDir();
  const saving = options.mode === 'save';
  const directory = options.directory === true && !saving;
  const multiple = options.multiple === true && !saving;

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

  const [cwd, setCwd] = useState<string | null>(options.initialPath ?? null);
  /** Names selected in the current folder. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** Where a Shift+click range starts. */
  const anchorRef = useRef<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [name, setName] = useState(options.currentName ?? '');
  /** A save that would replace this path, waiting for the user to say so. */
  const [replacing, setReplacing] = useState<string | null>(null);

  // Until the user navigates, browse the home directory (once it resolves).
  const effectiveCwd = cwd ?? home.data ?? null;
  const listing = useDirectory(effectiveCwd);

  const entries = useMemo(
    () =>
      sortEntries(
        (listing.data?.entries ?? []).filter((e) => showHidden || !e.name.startsWith('.')),
      ),
    [listing.data, showHidden],
  );
  const byName = useMemo(() => new Map(entries.map((e) => [e.name, e])), [entries]);

  /** Whether an entry can be what the picker returns. */
  const choosable = useCallback(
    (entry: FsEntry) =>
      directory ? entry.kind === 'directory' : entry.kind === 'file' && filterMatches(filter, entry.name),
    [directory, filter],
  );

  const places = useMemo(() => {
    const list: { name: string; path: string; icon: LucideIcon }[] = [];
    if (home.data) {
      list.push({ name: 'Home', path: home.data, icon: Home });
      list.push({ name: 'Downloads', path: joinPath(home.data, 'Downloads'), icon: Download });
      list.push({ name: 'Desktop', path: joinPath(home.data, 'Desktop'), icon: Folder });
    }
    list.push({ name: 'System', path: '/', icon: HardDrive });
    return list;
  }, [home.data]);

  const navigate = useCallback((target: string) => {
    setSelected(new Set());
    anchorRef.current = null;
    setReplacing(null);
    setCwd(target.length > 1 ? target.replace(/\/+$/, '') : '/');
  }, []);

  const finish = useCallback(
    (paths: string[]) => onConfirm({ paths, filter: filter ? filterIndex : null }),
    [onConfirm, filter, filterIndex],
  );

  /** Save under `fileName` in the current folder, asking before replacing a file. */
  const save = useCallback(
    (fileName: string) => {
      const clean = fileName.trim();
      if (effectiveCwd === null || !clean || clean.includes('/') || clean === '.' || clean === '..') return;
      const existing = byName.get(clean);
      const target = joinPath(effectiveCwd, clean);
      if (existing?.kind === 'directory') return navigate(target);
      if (existing && replacing !== target) return setReplacing(target);
      finish([target]);
    },
    [effectiveCwd, byName, replacing, navigate, finish],
  );

  const selectedPaths = useMemo(() => {
    if (effectiveCwd === null) return [];
    return [...selected]
      .map((n) => byName.get(n))
      .filter((e): e is FsEntry => e !== undefined && choosable(e))
      .map((e) => joinPath(effectiveCwd, e.name));
  }, [selected, byName, choosable, effectiveCwd]);

  const canConfirm = saving
    ? name.trim() !== '' && !name.includes('/')
    : directory
      ? effectiveCwd !== null
      : selectedPaths.length > 0;

  const confirm = () => {
    if (saving) return save(name);
    if (directory) {
      if (selectedPaths.length > 0) finish(selectedPaths);
      else if (effectiveCwd) finish([effectiveCwd]);
      return;
    }
    if (selectedPaths.length > 0) finish(selectedPaths);
  };

  const clickEntry = useCallback(
    (entry: FsEntry, event: React.MouseEvent) => {
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
        const names = entries.filter(choosable).map((e) => e.name);
        const from = names.indexOf(anchorRef.current!);
        const to = names.indexOf(entry.name);
        if (from !== -1 && to !== -1) {
          setSelected(new Set(names.slice(Math.min(from, to), Math.max(from, to) + 1)));
          return;
        }
      }
      anchorRef.current = entry.name;
      setSelected((current) => {
        if (!toggle) return new Set([entry.name]);
        const next = new Set(current);
        if (!next.delete(entry.name)) next.add(entry.name);
        return next;
      });
    },
    [saving, choosable, multiple, entries],
  );

  const openEntry = useCallback(
    (entry: FsEntry) => {
      if (effectiveCwd === null) return;
      const target = joinPath(effectiveCwd, entry.name);
      if (entry.kind === 'directory') navigate(target);
      else if (saving && entry.kind === 'file') {
        setName(entry.name);
        save(entry.name);
      } else if (choosable(entry)) finish([target]);
    },
    [effectiveCwd, navigate, saving, save, choosable, finish],
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
        className="flex h-[560px] max-h-full w-[820px] max-w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl outline-none"
        onKeyDown={(e) => {
          const typing = e.target instanceof HTMLInputElement;
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            if (canConfirm) confirm();
          } else if (
            effectiveCwd &&
            effectiveCwd !== '/' &&
            ((e.altKey && e.key === 'ArrowUp') || (e.key === 'Backspace' && !typing))
          ) {
            e.preventDefault();
            navigate(parentPath(effectiveCwd));
          } else if (e.ctrlKey && e.key.toLowerCase() === 'h') {
            e.preventDefault();
            setShowHidden((v) => !v);
          } else if (multiple && e.ctrlKey && e.key.toLowerCase() === 'a' && !typing) {
            e.preventDefault();
            setSelected(new Set(entries.filter(choosable).map((entry) => entry.name)));
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
            disabled={!effectiveCwd || effectiveCwd === '/'}
            onClick={() => effectiveCwd && navigate(parentPath(effectiveCwd))}
          >
            <ArrowUp className="size-4" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Refresh"
            onClick={() => listing.refetch()}
          >
            <RotateCw className={cn('size-4', listing.isFetching && 'animate-spin')} aria-hidden />
          </Button>
          <div className="ml-1 min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            {effectiveCwd ?? 'Loading…'}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            aria-pressed={showHidden}
            title="Show hidden files (Ctrl+H)"
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
          </Button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Places sidebar */}
          <nav className="hidden w-40 shrink-0 space-y-0.5 overflow-y-auto border-r border-border/60 bg-muted/20 p-2 sm:block">
            {places.map((place) => (
              <button
                key={place.path}
                type="button"
                onClick={() => navigate(place.path)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  effectiveCwd === place.path && 'bg-primary/10 text-foreground',
                )}
              >
                <place.icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{place.name}</span>
              </button>
            ))}
          </nav>

          {/* File list */}
          <div className="min-w-0 flex-1 overflow-hidden">
            {!bridge ? (
              <FallbackMessage>
                The file picker needs the Din desktop shell and isn't available
                in a plain browser.
              </FallbackMessage>
            ) : listing.isError ? (
              <FallbackMessage>{cleanFsError(listing.error)}</FallbackMessage>
            ) : listing.isLoading || effectiveCwd === null ? (
              <div className="space-y-1 p-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : entries.length === 0 ? (
              <FallbackMessage>This folder is empty.</FallbackMessage>
            ) : (
              // Keyed by path so scroll position resets on navigation.
              <PickerList
                key={effectiveCwd}
                cwd={effectiveCwd}
                entries={entries}
                choosable={choosable}
                dimmed={(entry) => entry.kind !== 'directory' && !(saving ? filterMatches(filter, entry.name) : choosable(entry))}
                selected={selected}
                multiple={multiple}
                onClick={clickEntry}
                onOpen={openEntry}
              />
            )}
          </div>
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

/** Fixed row height for the virtualized picker list (px). */
const ROW_HEIGHT = 32;
/** Extra rows rendered above/below the viewport to hide scroll pop-in. */
const OVERSCAN = 10;

/**
 * Virtualized picker listing. Directory listings can reach thousands of
 * entries (the bridge caps at 5000); windowing keeps the mounted DOM at
 * ~viewport size, and memoized rows keep a selection change from re-rendering
 * every row.
 */
const PickerList = memo(function PickerList({
  cwd,
  entries,
  choosable,
  dimmed,
  selected,
  multiple,
  onClick,
  onOpen,
}: {
  cwd: string;
  entries: FsEntry[];
  choosable: (entry: FsEntry) => boolean;
  dimmed: (entry: FsEntry) => boolean;
  selected: ReadonlySet<string>;
  multiple: boolean;
  onClick: (entry: FsEntry, event: React.MouseEvent) => void;
  onOpen: (entry: FsEntry) => void;
}) {
  const { containerRef, onScroll, start, end, totalHeight } = useVirtualRows({
    count: entries.length,
    rowHeight: ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="h-full overflow-y-auto p-1"
    >
      <ul
        className="relative"
        style={{ height: totalHeight }}
        role="listbox"
        aria-multiselectable={multiple || undefined}
      >
        {entries.slice(start, end).map((entry, i) => (
          <PickerRow
            key={entry.name}
            entry={entry}
            path={joinPath(cwd, entry.name)}
            top={(start + i) * ROW_HEIGHT}
            dim={dimmed(entry)}
            isSelected={selected.has(entry.name) && choosable(entry)}
            onClick={onClick}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </div>
  );
});

/** One row in the picker list, absolutely positioned within the virtual list. */
const PickerRow = memo(function PickerRow({
  entry,
  path,
  top,
  dim,
  isSelected,
  onClick,
  onOpen,
}: {
  entry: FsEntry;
  path: string;
  top: number;
  dim: boolean;
  isSelected: boolean;
  onClick: (entry: FsEntry, event: React.MouseEvent) => void;
  onOpen: (entry: FsEntry) => void;
}) {
  return (
    <li className="absolute inset-x-0" style={{ top, height: ROW_HEIGHT }} role="option" aria-selected={isSelected}>
      <button
        type="button"
        disabled={dim}
        onClick={(e) => onClick(entry, e)}
        onDoubleClick={() => onOpen(entry)}
        className={cn(
          'flex h-full w-full items-center gap-2 rounded-md px-2 text-left text-sm',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isSelected
            ? 'bg-primary/15 text-foreground'
            : 'text-foreground hover:bg-foreground/5',
          dim && 'opacity-40',
        )}
      >
        <FileIcon
          path={path}
          name={entry.name}
          kind={entry.kind}
          size={entry.size}
          mtimeMs={entry.mtimeMs}
          symlink={entry.symlink}
          px={20}
        />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.kind === 'file' && entry.size !== null && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatBytes(entry.size)}
          </span>
        )}
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
