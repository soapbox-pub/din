import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Download,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Link as LinkIcon,
  Pencil,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppComponentProps } from '@/lib/apps';
import {
  cleanFsError,
  formatBytes,
  getFsBridge,
  isValidEntryName,
  joinPath,
  parentPath,
  sortEntries,
} from '@/lib/fs';
import type { FsEntry } from '@/lib/fs';
import {
  useDirectory,
  useFileContent,
  useFsMutations,
  useHomeDir,
} from '@/hooks/useFileSystem';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { getNativeAppsBridge, isWindowsProgram } from '@/lib/nativeApps';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { TabStrip } from '@/components/desktop/TabStrip';
import { moveItem } from '@/hooks/useDragReorder';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';

/** Cap for image preview reads: enough for big images, cheap over IPC. */
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
/** Cap for text preview reads (we only render the beginning anyway). */
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** Never render more text than this (keeps the DOM responsive). */
const TEXT_PREVIEW_MAX_CHARS = 512 * 1024;

/**
 * Shared date formatter. Constructing an Intl.DateTimeFormat is expensive
 * (~0.1ms), so per-row `toLocaleString` calls dominate render time on large
 * directories; a single cached instance makes formatting nearly free.
 */
const MTIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

const CODE_EXTENSIONS = new Set([
  'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'html', 'xml',
  'sh', 'bash', 'zsh', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'nix', 'toml',
  'yaml', 'yml', 'lock',
]);

const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'tar', 'gz', 'xz', 'zst', 'bz2', '7z', 'rar', 'qcow2', 'iso', 'img',
]);

function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/** Icon for a directory entry, keyed off its kind and file extension. */
function EntryIcon({ entry }: { entry: FsEntry }) {
  const className = cn(
    'size-4 shrink-0',
    entry.kind === 'directory' ? 'text-primary' : 'text-muted-foreground',
  );
  if (entry.kind === 'directory') return <Folder className={className} aria-hidden />;
  const ext = extensionOf(entry.name);
  if (ext in IMAGE_MIME) return <FileImage className={className} aria-hidden />;
  if (CODE_EXTENSIONS.has(ext)) return <FileCode className={className} aria-hidden />;
  if (ARCHIVE_EXTENSIONS.has(ext)) return <FileArchive className={className} aria-hidden />;
  if (isWindowsProgram(entry.name)) return <AppWindow className={className} aria-hidden />;
  if (ext === 'md' || ext === 'txt' || ext === 'log') {
    return <FileText className={className} aria-hidden />;
  }
  return <File className={className} aria-hidden />;
}

let nextTabId = 0;
const newTabId = () => `files-${nextTabId++}`;

/** Basename shown on a tab for a given directory (root shows "/"). */
function tabTitle(cwd: string | null): string {
  if (!cwd) return 'Files';
  if (cwd === '/') return '/';
  const base = cwd.slice(cwd.lastIndexOf('/') + 1);
  return base || '/';
}

/**
 * Files - a browser for the underlying OS filesystem.
 *
 * Backed by `window.fs` (Electron preload + IPC into the main process), so it
 * sees the VM's real filesystem. This shell manages tabs: each tab is an
 * independent navigation context (its own history, cwd, and preview), all
 * kept mounted so background tabs retain their state; only the active one is
 * visible. The tab strip is published into the window title bar. Outside the
 * Electron shell (plain-browser dev) it shows an explanatory fallback.
 */
export function FileBrowser({ windowId }: AppComponentProps) {
  const bridge = getFsBridge();
  const { close: closeWindow } = useWindowActions();
  const setTitlebar = useWindowTitlebar();

  const [tabs, setTabs] = useState<{ id: string }[]>(() => [{ id: newTabId() }]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  // Current directory per tab, reported up by each tab for its label.
  const [cwds, setCwds] = useState<Record<string, string | null>>({});

  const openTab = useCallback(() => {
    const tab = { id: newTabId() };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((ts) => {
        const index = ts.findIndex((t) => t.id === id);
        if (index === -1) return ts;
        const next = ts.filter((t) => t.id !== id);
        if (next.length === 0) {
          closeWindow(windowId);
          return ts;
        }
        setActiveId((current) =>
          current === id ? next[Math.max(0, index - 1)].id : current,
        );
        return next;
      });
      setCwds((c) => {
        const { [id]: _, ...rest } = c;
        return rest;
      });
    },
    [closeWindow, windowId],
  );

  const activeCwd = cwds[activeId] ?? null;
  useWindowTitle(activeCwd && tabTitle(activeCwd));

  const reportCwd = useCallback((id: string, cwd: string | null) => {
    setCwds((c) => (c[id] === cwd ? c : { ...c, [id]: cwd }));
  }, []);

  useEffect(() => {
    if (!bridge) return;
    setTitlebar(
      <TabStrip
        tabs={tabs.map((t) => ({
          id: t.id,
          title: tabTitle(cwds[t.id] ?? null),
          icon: <Folder className="size-3.5 text-primary" />,
        }))}
        activeId={activeId}
        label="Files tabs"
        newTabLabel="New tab"
        onActivate={setActiveId}
        onClose={closeTab}
        onNew={openTab}
        onMove={(id, to) => setTabs((ts) => moveItem(ts, id, to))}
      />,
    );
    return () => setTitlebar(null);
  }, [bridge, tabs, cwds, activeId, closeTab, openTab, setTitlebar]);

  if (!bridge) {
    return (
      <div className="grid h-full w-full place-items-center p-6">
        <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
          <HardDrive className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Files needs the Electron shell to access the OS filesystem. Run{' '}
            <code className="rounded bg-foreground/10 px-1 py-0.5">make dev</code> or
            boot the VM; the bridge is not available in a plain browser.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="absolute inset-0"
          style={
            tab.id === activeId
              ? undefined
              : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <FileBrowserTab
            tabId={tab.id}
            onCwdChange={reportCwd}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * One Files tab: an independent navigation context (history, cwd, preview,
 * and inline-edit UI state). Reports its current directory up via
 * `onCwdChange` so the shell can label the tab.
 */
function FileBrowserTab({
  tabId,
  onCwdChange,
}: {
  tabId: string;
  onCwdChange: (id: string, cwd: string | null) => void;
}) {
  const home = useHomeDir();
  const { mkdir, rename, rm } = useFsMutations();

  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  // While the user is editing the path bar; null shows the current path.
  const [addressEdit, setAddressEdit] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  // Whether the "new folder" name editor row is open.
  const [creating, setCreating] = useState(false);
  // Name of the entry currently being renamed inline, if any.
  const [renamingName, setRenamingName] = useState<string | null>(null);
  // Entry awaiting delete confirmation, if any.
  const [confirmDelete, setConfirmDelete] = useState<FsEntry | null>(null);
  // Last failed operation, shown in the status bar.
  const [opError, setOpError] = useState<string | null>(null);
  // Windows program being started, while Wine gets it going.
  const [opening, setOpening] = useState<string | null>(null);
  const startingRef = useRef(new Set<string>());

  // Until the user navigates, the current directory is the home directory.
  const cwd = cursor >= 0 ? history[cursor] : (home.data ?? null);
  const address = addressEdit ?? cwd ?? '';

  // Report the current directory up so the shell can label this tab.
  useEffect(() => {
    onCwdChange(tabId, cwd);
  }, [tabId, cwd, onCwdChange]);

  const navigate = useCallback(
    (target: string) => {
      const normalized = target.length > 1 ? target.replace(/\/+$/, '') : '/';
      setPreviewPath(null);
      setAddressEdit(null);
      setCreating(false);
      setRenamingName(null);
      setConfirmDelete(null);
      setOpError(null);
      setHistory((h) => {
        const base = cursor >= 0 ? h.slice(0, cursor + 1) : cwd ? [cwd] : [];
        setCursor(base.length);
        return [...base, normalized];
      });
    },
    [cursor, cwd],
  );

  const go = useCallback(
    (delta: number) => {
      const target = cursor + delta;
      if (target < 0 || target >= history.length) return;
      setPreviewPath(null);
      setAddressEdit(null);
      setCreating(false);
      setRenamingName(null);
      setConfirmDelete(null);
      setCursor(target);
    },
    [cursor, history],
  );

  const listing = useDirectory(cwd);

  const entries = useMemo(() => {
    const items = listing.data?.entries ?? [];
    const visible = showHidden
      ? items
      : items.filter((e) => !e.name.startsWith('.'));
    return sortEntries(visible);
  }, [listing.data, showHidden]);

  const places = useMemo(() => {
    const list: { name: string; path: string; icon: LucideIcon }[] = [];
    if (home.data) {
      list.push({ name: 'Home', path: home.data, icon: Home });
      list.push({ name: 'Downloads', path: joinPath(home.data, 'Downloads'), icon: Download });
    }
    list.push({ name: 'System', path: '/', icon: HardDrive });
    return list;
  }, [home.data]);

  const openEntry = useCallback(
    (entry: FsEntry) => {
      if (cwd === null) return;
      const target = joinPath(cwd, entry.name);
      const nativeApps = getNativeAppsBridge();
      if (entry.kind === 'directory') {
        navigate(target);
      } else if (entry.kind === 'file' && nativeApps && isWindowsProgram(entry.name)) {
        // Windows programs run, as they would from Explorer. The first one
        // also sets up Wine, which takes a while, so say something meanwhile.
        // Habitual double-clicks land here twice; one copy is plenty.
        if (startingRef.current.has(target)) return;
        startingRef.current.add(target);
        setOpError(null);
        setOpening(entry.name);
        nativeApps
          .runWindowsProgram(target)
          .catch((error: unknown) => setOpError(cleanFsError(error)))
          .finally(() => {
            // Wine takes a moment more to put the window up.
            setTimeout(() => startingRef.current.delete(target), 3_000);
            setOpening((name) => (name === entry.name ? null : name));
          });
      } else if (entry.kind === 'file') {
        setPreviewPath(target);
      }
    },
    [cwd, navigate],
  );

  const createFolder = useCallback(
    (name: string) => {
      if (cwd === null) return;
      setOpError(null);
      mkdir.mutate(joinPath(cwd, name), {
        onSuccess: () => setCreating(false),
        onError: (error) => setOpError(cleanFsError(error)),
      });
    },
    [cwd, mkdir],
  );

  const renameEntry = useCallback(
    (from: string, to: string) => {
      if (cwd === null) return;
      setRenamingName(null);
      if (from === to) return;
      setOpError(null);
      rename.mutate(
        { from: joinPath(cwd, from), to: joinPath(cwd, to) },
        { onError: (error) => setOpError(cleanFsError(error)) },
      );
    },
    [cwd, rename],
  );

  const deleteEntry = useCallback(
    (entry: FsEntry) => {
      if (cwd === null) return;
      setOpError(null);
      rm.mutate(
        {
          path: joinPath(cwd, entry.name),
          recursive: entry.kind === 'directory',
        },
        {
          onSettled: () => setConfirmDelete(null),
          onError: (error) => setOpError(cleanFsError(error)),
        },
      );
    },
    [cwd, rm],
  );

  const startRename = useCallback((entry: FsEntry) => {
    setCreating(false);
    setRenamingName(entry.name);
  }, []);

  const requestDelete = useCallback((entry: FsEntry) => {
    setConfirmDelete(entry);
  }, []);

  const cancelRename = useCallback(() => setRenamingName(null), []);

  return (
    <div className="flex h-full w-full flex-col">
      {/* Toolbar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const raw = address.trim();
          if (raw.startsWith('/')) navigate(raw);
        }}
        className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-background/50 px-2 py-1.5"
      >
        <ToolButton label="Go back" disabled={cursor <= 0} onClick={() => go(-1)}>
          <ArrowLeft className="size-4" />
        </ToolButton>
        <ToolButton
          label="Go forward"
          disabled={cursor >= history.length - 1}
          onClick={() => go(1)}
        >
          <ArrowRight className="size-4" />
        </ToolButton>
        <ToolButton
          label="Go to parent directory"
          disabled={cwd === null || cwd === '/'}
          onClick={() => cwd && navigate(parentPath(cwd))}
        >
          <ArrowUp className="size-4" />
        </ToolButton>
        <ToolButton
          label="Refresh"
          onClick={() => listing.refetch()}
        >
          <RotateCw className={cn('size-4', listing.isFetching && 'animate-spin')} />
        </ToolButton>

        <input
          type="text"
          aria-label="Current directory path"
          value={address}
          onChange={(e) => setAddressEdit(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-secondary/80 px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />

        <ToolButton
          label="New folder"
          disabled={listing.data === undefined}
          onClick={() => {
            setRenamingName(null);
            setCreating(true);
          }}
        >
          <FolderPlus className="size-4" />
        </ToolButton>
        <ToolButton
          label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </ToolButton>
      </form>

      <div className="relative flex min-h-0 flex-1">
        {/* Sidebar */}
        <nav
          aria-label="Places"
          className="hidden w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/60 bg-background/30 p-2 sm:flex"
        >
          {places.map((place) => (
            <button
              key={place.path}
              type="button"
              onClick={() => navigate(place.path)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                cwd === place.path
                  ? 'bg-foreground/15 text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
              )}
            >
              <place.icon className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{place.name}</span>
            </button>
          ))}
        </nav>

        {/* Entry list */}
        <div className="flex min-w-0 flex-1 flex-col">
          {creating && (
            <div className="border-b border-border/60 px-1 py-1">
              <NameEditor
                icon={<Folder className="size-4 shrink-0 text-primary" aria-hidden />}
                initialValue="untitled folder"
                label="New folder name"
                pending={mkdir.isPending}
                onSubmit={createFolder}
                onCancel={() => setCreating(false)}
              />
            </div>
          )}
          {listing.isLoading || cwd === null ? (
            <ListSkeleton />
          ) : listing.isError ? (
            <div className="grid flex-1 place-items-center p-6">
              <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  Could not open this directory: {cleanFsError(listing.error)}
                </p>
              </div>
            </div>
          ) : entries.length === 0 && !creating ? (
            <div className="grid flex-1 place-items-center p-6">
              <p className="text-sm text-muted-foreground">This folder is empty.</p>
            </div>
          ) : (
            // Keyed by path so scroll position resets on navigation.
            <EntryList
              key={cwd}
              entries={entries}
              onOpen={openEntry}
              onRenameStart={startRename}
              onDelete={requestDelete}
              renamingName={renamingName}
              onRenameSubmit={renameEntry}
              onRenameCancel={cancelRename}
            />
          )}
        </div>

        {previewPath !== null && (
          <FilePreview path={previewPath} onClose={() => setPreviewPath(null)} />
        )}

        {confirmDelete !== null && (
          <DeleteConfirm
            entry={confirmDelete}
            pending={rm.isPending}
            onConfirm={() => deleteEntry(confirmDelete)}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </div>

      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 bg-background/50 px-3 py-1 text-xs text-muted-foreground">
        <span>
          {listing.data
            ? `${entries.length} item${entries.length === 1 ? '' : 's'}`
            : '…'}
        </span>
        {listing.data?.truncated && (
          <span className="text-amber-400/80">
            Listing truncated - directory has more entries than shown.
          </span>
        )}
        {opening !== null && opError === null && (
          <span role="status" className="min-w-0 flex-1 truncate text-right">
            Opening {opening}…
          </span>
        )}
        {opError !== null && (
          <span role="alert" className="min-w-0 flex-1 truncate text-right text-destructive">
            {opError}
          </span>
        )}
      </div>
    </div>
  );
}

/** Fixed row height for the virtualized entry list (px). */
const ROW_HEIGHT = 32;
/** Extra rows rendered above/below the viewport to hide scroll pop-in. */
const OVERSCAN = 10;

/**
 * Virtualized directory listing.
 *
 * Directories like /nix/store can hit the 5000-entry cap; rendering that many
 * rows makes every render (and layout) of the app expensive. Windowing (see
 * useVirtualRows) keeps render cost constant regardless of directory size.
 * Memoized so parent re-renders (toolbar typing, preview open/close) skip it
 * entirely when the listing is unchanged.
 */
const EntryList = memo(function EntryList({
  entries,
  onOpen,
  onRenameStart,
  onDelete,
  renamingName,
  onRenameSubmit,
  onRenameCancel,
}: {
  entries: FsEntry[];
  onOpen: (entry: FsEntry) => void;
  onRenameStart: (entry: FsEntry) => void;
  onDelete: (entry: FsEntry) => void;
  renamingName: string | null;
  onRenameSubmit: (from: string, to: string) => void;
  onRenameCancel: () => void;
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
      className="min-h-0 flex-1 overflow-y-auto px-1 py-1"
    >
      <ul className="relative" style={{ height: totalHeight }}>
        {entries.slice(start, end).map((entry, i) => (
          <EntryRow
            key={entry.name}
            entry={entry}
            top={(start + i) * ROW_HEIGHT}
            onOpen={onOpen}
            onRenameStart={onRenameStart}
            onDelete={onDelete}
            isRenaming={entry.name === renamingName}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
          />
        ))}
      </ul>
    </div>
  );
});

/** One row in the entry list, absolutely positioned within the virtual list. */
const EntryRow = memo(function EntryRow({
  entry,
  top,
  onOpen,
  onRenameStart,
  onDelete,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
}: {
  entry: FsEntry;
  top: number;
  onOpen: (entry: FsEntry) => void;
  onRenameStart: (entry: FsEntry) => void;
  onDelete: (entry: FsEntry) => void;
  isRenaming: boolean;
  onRenameSubmit: (from: string, to: string) => void;
  onRenameCancel: () => void;
}) {
  if (isRenaming) {
    return (
      <li className="absolute inset-x-0" style={{ top, height: ROW_HEIGHT }}>
        <NameEditor
          icon={<EntryIcon entry={entry} />}
          initialValue={entry.name}
          label={`Rename ${entry.name}`}
          onSubmit={(name) => onRenameSubmit(entry.name, name)}
          onCancel={onRenameCancel}
        />
      </li>
    );
  }

  return (
    <li
      className="absolute inset-x-0"
      style={{ top, height: ROW_HEIGHT }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => onOpen(entry)}
            disabled={entry.kind === 'other'}
            className={cn(
              'flex h-full w-full items-center gap-2 rounded-md px-2 text-left',
              'hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent',
            )}
          >
            <EntryIcon entry={entry} />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {entry.name}
            </span>
            {entry.symlink && (
              <LinkIcon
                className="size-3 shrink-0 text-muted-foreground/80"
                aria-label="Symbolic link"
              />
            )}
            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {entry.kind === 'file' && entry.size !== null
                ? formatBytes(entry.size)
                : ''}
            </span>
            <span className="hidden w-36 shrink-0 text-right text-xs tabular-nums text-muted-foreground md:block">
              {entry.mtimeMs !== null ? MTIME_FORMAT.format(entry.mtimeMs) : ''}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onRenameStart(entry)}>
            <Pencil className="size-4" aria-hidden />
            Rename
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => onDelete(entry)}>
            <Trash2 className="size-4" aria-hidden />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
});

/**
 * Inline single-name editor row (new folder, rename). Enter submits, Escape
 * or blur cancels; invalid names (slashes, '.', '..') can't be submitted.
 */
function NameEditor({
  icon,
  initialValue,
  label,
  pending,
  onSubmit,
  onCancel,
}: {
  icon: React.ReactNode;
  initialValue: string;
  label: string;
  pending?: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const valid = isValidEntryName(value.trim());

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !pending) onSubmit(value.trim());
      }}
      className="flex items-center gap-2 rounded-md px-2"
      style={{ height: ROW_HEIGHT }}
    >
      {icon}
      <input
        type="text"
        aria-label={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => {
          if (!pending) onCancel();
        }}
        onFocus={(e) => e.currentTarget.select()}
        disabled={pending}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'h-6 min-w-0 flex-1 rounded border bg-secondary/80 px-2 text-sm text-foreground',
          'focus-visible:outline-none focus-visible:ring-2',
          valid
            ? 'border-border focus-visible:ring-ring/70'
            : 'border-destructive/60 focus-visible:ring-destructive/40',
          'disabled:opacity-50',
        )}
      />
    </form>
  );
}

/** In-window confirmation overlay for deleting an entry. */
function DeleteConfirm({
  entry,
  pending,
  onConfirm,
  onCancel,
}: {
  entry: FsEntry;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`Delete ${entry.name}?`}
      className="absolute inset-0 z-20 grid place-items-center bg-black/60 p-6"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-xl border border-border/60 bg-popover p-4 shadow-2xl">
        <p className="text-sm text-foreground">
          Delete <span className="font-mono">{entry.name}</span>
          {entry.kind === 'directory' ? ' and everything inside it' : ''}?
        </p>
        <p className="mt-1 text-xs text-muted-foreground">This cannot be undone.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            autoFocus
            className="h-8 rounded-md px-3 text-sm text-foreground/80 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="h-8 rounded-md bg-destructive px-3 text-sm font-medium text-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-50"
          >
            {pending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** In-window preview overlay for a single file (text or image). */
function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const mime = IMAGE_MIME[extensionOf(name)];
  // Text/binary files only need the first chunk; images need full bytes.
  const content = useFileContent(
    path,
    mime ? PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES,
  );

  const imageUrl = useMemo(() => {
    if (!mime || !content.data || content.data.truncated) return null;
    return URL.createObjectURL(
      new Blob([content.data.data.slice().buffer], { type: mime }),
    );
  }, [mime, content.data]);

  // Release each object URL once it is no longer rendered.
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const text = useMemo(() => {
    if (mime || !content.data) return null;
    const bytes = content.data.data;
    // Null byte in the head -> treat as binary.
    const head = bytes.subarray(0, Math.min(bytes.length, 8192));
    if (head.includes(0)) return null;
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return decoded.slice(0, TEXT_PREVIEW_MAX_CHARS);
  }, [mime, content.data]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-background/50 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
          {name}
        </span>
        {content.data && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatBytes(content.data.size)}
          </span>
        )}
        <ToolButton label="Close preview" onClick={onClose}>
          <X className="size-4" />
        </ToolButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {content.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-3/4 bg-foreground/10" />
            <Skeleton className="h-4 w-full bg-foreground/10" />
            <Skeleton className="h-4 w-2/3 bg-foreground/10" />
          </div>
        ) : content.isError ? (
          <p className="p-4 text-sm text-muted-foreground">
            Could not read file: {cleanFsError(content.error)}
          </p>
        ) : imageUrl ? (
          <div className="grid h-full place-items-center p-4">
            <img
              src={imageUrl}
              alt={name}
              className="max-h-full max-w-full rounded-md object-contain"
            />
          </div>
        ) : text !== null ? (
          <>
            {(content.data?.truncated ||
              text.length >= TEXT_PREVIEW_MAX_CHARS) && (
              <p className="border-b border-border/60 bg-amber-950/40 px-4 py-1.5 text-xs text-amber-300/90">
                Preview truncated - showing the beginning of the file.
              </p>
            )}
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground/90">
              {text}
            </pre>
          </>
        ) : (
          <div className="grid h-full place-items-center p-6">
            <div className="text-center">
              <File className="mx-auto mb-3 size-8 text-muted-foreground/60" aria-hidden />
              <p className="text-sm text-muted-foreground">
                Binary file - no preview available.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 p-2" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton className="size-4 rounded bg-foreground/10" />
          <Skeleton
            className="h-4 bg-foreground/10"
            style={{ width: `${30 + ((i * 17) % 40)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md text-foreground/80',
        'hover:bg-foreground/10 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}
