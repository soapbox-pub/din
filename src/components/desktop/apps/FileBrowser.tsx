import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Folder,
  HardDrive,
  Home,
  LayoutGrid,
  List,
  RotateCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppComponentProps } from '@/lib/apps';
import {
  cleanFsError,
  formatBytes,
  getFsBridge,
  joinPath,
  parentPath,
  sortEntriesBy,
} from '@/lib/fs';
import type { FsEntry } from '@/lib/fs';
import { adobeAppFor, isDelimitedText, isExtractable, isPhotoEditable, isPhotoshopFile, isTextFile, isVectorEditable, isViewableImage, officeAppFor } from '@/lib/fileTypes';
import {
  invalidateListings,
  useBookmarks,
  useDirectory,
  useFsDetails,
  useHomeDir,
  useTrashDir,
  useWatchDirectory,
} from '@/hooks/useFileSystem';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useVolumes } from '@/hooks/useVolumes';
import { useAppContext } from '@/hooks/useAppContext';
import { getAssistantBridge } from '@/lib/assistant';
import { cleanPrintingError, getPrintingBridge, isPrintableFile, printFile } from '@/lib/printing';
import { getNativeAppsBridge, isWindowsProgram } from '@/lib/nativeApps';
import {
  getFileClipboard,
  popUndo,
  pushUndo,
  setFileClipboard,
  useFileClipboard,
} from '@/lib/fileClipboard';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { parkedTab } from '@/lib/tabTransfer';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useWindowIsTop } from '@/contexts/WindowFocusContext';
import { TabStrip } from '@/components/desktop/TabStrip';
import { moveItem } from '@/hooks/useDragReorder';
import { BarsStaggeredIcon } from '@/components/icons/BarsStaggeredIcon';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { EntryView } from './files/EntryViews';
import { GRID_ZOOMS } from './files/layout';
import type { SortKey, SortOrder, ViewMode } from './files/EntryViews';
import { Sidebar } from './files/Sidebar';
import { CompressDialog, ConfirmDialog, PropertiesDialog, ShortcutsDialog } from './files/Dialogs';
import { FileViewerBody } from './files/FileViewerBody';
import { endFileDrag, startFileDrag } from './files/dnd';

let nextTabId = 0;
const newTabId = () => `files-${nextTabId++}`;

/** How long type-ahead keeps adding to what's been typed (ms). */
const TYPEAHEAD_MS = 1000;

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  size: 'Size',
  type: 'Type',
  modified: 'Modified',
};

interface FilesPrefs {
  showHidden: boolean;
  view: ViewMode;
  zoom: number;
  sort: SortOrder;
  sidebar: boolean;
}

const DEFAULT_PREFS: FilesPrefs = {
  showHidden: false,
  view: 'list',
  zoom: 1,
  sort: { key: 'name', descending: false },
  sidebar: true,
};

/** Display name for a folder (tab labels, window title). */
function folderTitle(cwd: string | null, home: string | undefined, trash: string | undefined): string {
  if (!cwd) return 'Files';
  if (cwd === trash) return 'Trash';
  if (cwd === home) return 'Home';
  if (cwd === '/') return 'Computer';
  return cwd.slice(cwd.lastIndexOf('/') + 1) || '/';
}

interface TabSpec {
  id: string;
  path?: string;
  select?: string;
}

/** What a Files tab carries to another window: its directory. */
function isFilesTabTransfer(value: unknown): value is { path: string } {
  return typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string';
}

/**
 * Files - a browser for the OS filesystem, in the manner of Nautilus or
 * Finder: click to select, double-click to open, marquee and modifier-click
 * selection, drag and drop, cut/copy/paste, the Trash, undo, archives,
 * thumbnails, and a keyboard shortcut for nearly everything.
 *
 * Backed by `window.fs` (Electron preload + IPC into the main process, see
 * electron/files.mts for the heavier operations). Each tab is an
 * independent navigation context, all kept mounted so background tabs keep
 * their state; the tab strip is published into the window title bar.
 *
 * Launch params: `{ path?: string, select?: string }` - the folder to show
 * and an item in it to select.
 */
export function FileBrowser({ windowId, params }: AppComponentProps) {
  const bridge = getFsBridge();
  const { close: closeWindow, open } = useWindowActions();
  const setTitlebar = useWindowTitlebar();
  const home = useHomeDir();
  const trash = useTrashDir();
  const [prefs, setPrefs] = useLocalStorage<FilesPrefs>('din:files:prefs', DEFAULT_PREFS);
  const mergedPrefs = useMemo(() => ({ ...DEFAULT_PREFS, ...prefs }), [prefs]);

  const [tabs, setTabs] = useState<TabSpec[]>(() => {
    // A window opened for a tab dragged out of another one.
    const adopted = parkedTab(params);
    if (isFilesTabTransfer(adopted)) return [{ id: newTabId(), path: adopted.path || undefined }];
    return [
      {
        id: newTabId(),
        path: typeof params?.path === 'string' ? params.path : undefined,
        select: typeof params?.select === 'string' ? params.select : undefined,
      },
    ];
  });
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  // Current directory per tab, reported up by each tab for its label.
  const [cwds, setCwds] = useState<Record<string, string | null>>({});

  const openTab = useCallback((path?: string) => {
    const tab = { id: newTabId(), path };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }, []);

  const openWindow = useCallback(
    (path?: string) => open('file-browser', path ? { path } : undefined),
    [open],
  );

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

  const cycleTab = useCallback(
    (delta: number) => {
      setActiveId((current) => {
        const index = tabs.findIndex((t) => t.id === current);
        return tabs[(index + delta + tabs.length) % tabs.length].id;
      });
    },
    [tabs],
  );

  const activeCwd = cwds[activeId] ?? null;
  useWindowTitle(activeCwd && folderTitle(activeCwd, home.data, trash.data));

  const cwdsRef = useRef(cwds);
  useEffect(() => {
    cwdsRef.current = cwds;
  }, [cwds]);

  /** Hand a tab to another window, which reopens its directory. */
  const takeTab = useCallback(
    (id: string) => {
      const path = cwdsRef.current[id];
      closeTab(id);
      // A tab still finding its home directory carries no path.
      return { path: path ?? '' };
    },
    [closeTab],
  );

  const receiveTab = useCallback((payload: unknown, index: number) => {
    if (!isFilesTabTransfer(payload)) return;
    const tab = { id: newTabId(), path: payload.path || undefined };
    setTabs((ts) => [...ts.slice(0, index), tab, ...ts.slice(index)]);
    setActiveId(tab.id);
  }, []);

  const reportCwd = useCallback((id: string, cwd: string | null) => {
    setCwds((c) => (c[id] === cwd ? c : { ...c, [id]: cwd }));
  }, []);

  useEffect(() => {
    if (!bridge) return;
    setTitlebar(
      <TabStrip
        tabs={tabs.map((t) => ({
          id: t.id,
          title: folderTitle(cwds[t.id] ?? null, home.data, trash.data),
          icon:
            cwds[t.id] && cwds[t.id] === trash.data ? (
              <Trash2 className="size-3.5 text-muted-foreground" />
            ) : (
              <Folder className="size-3.5 text-primary" />
            ),
        }))}
        activeId={activeId}
        label="Files tabs"
        newTabLabel="New tab"
        onActivate={setActiveId}
        onClose={closeTab}
        onNew={() => openTab(activeCwd ?? undefined)}
        onMove={(id, to) => setTabs((ts) => moveItem(ts, id, to))}
        transfer={{
          windowId,
          appId: 'file-browser',
          group: 'file-browser',
          title: folderTitle(activeCwd, home.data, trash.data),
          take: takeTab,
          receive: receiveTab,
        }}
      />,
    );
    return () => setTitlebar(null);
  }, [bridge, tabs, cwds, activeId, activeCwd, windowId, closeTab, openTab, takeTab, receiveTab, setTitlebar, home.data, trash.data]);

  if (!bridge) {
    return (
      <div className="grid h-full w-full place-items-center p-6">
        <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
          <HardDrive className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Files needs the Electron shell to access the OS filesystem. Run{' '}
            <code className="rounded bg-foreground/10 px-1 py-0.5">npm run dev</code> or
            boot DinOS; the bridge is not available in a plain browser.
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
            active={tab.id === activeId}
            initialPath={tab.path}
            initialSelect={tab.select}
            prefs={mergedPrefs}
            setPrefs={setPrefs}
            onCwdChange={reportCwd}
            onNewTab={openTab}
            onNewWindow={openWindow}
            onCloseTab={() => closeTab(tab.id)}
            onCycleTab={cycleTab}
          />
        </div>
      ))}
    </div>
  );
}

type Dialog =
  | { type: 'properties'; names: string[] }
  | { type: 'compress'; names: string[]; error: string | null; pending: boolean }
  | { type: 'delete'; names: string[]; reason?: string }
  | { type: 'emptyTrash' }
  | { type: 'shortcuts' };

type Status = { kind: 'busy' | 'error' | 'info'; text: string } | null;

/** Grouped item counts for messages: "3 items", "“notes.txt”". */
function describe(names: string[]): string {
  return names.length === 1 ? `“${names[0]}”` : `${names.length} items`;
}

/** A name in `entries` not taken yet: "New Folder", "New Folder 2", ... */
function freshName(entries: FsEntry[] | undefined, base: string): string {
  const taken = new Set((entries ?? []).map((e) => e.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * One Files tab: an independent navigation context with its own history,
 * selection, and dialogs. Reports its current directory up via
 * `onCwdChange` so the shell can label the tab.
 */
function FileBrowserTab({
  tabId,
  active,
  initialPath,
  initialSelect,
  prefs,
  setPrefs,
  onCwdChange,
  onNewTab,
  onNewWindow,
  onCloseTab,
  onCycleTab,
}: {
  tabId: string;
  active: boolean;
  initialPath?: string;
  initialSelect?: string;
  prefs: FilesPrefs;
  setPrefs: (update: (prev: FilesPrefs) => FilesPrefs) => void;
  onCwdChange: (id: string, cwd: string | null) => void;
  onNewTab: (path?: string) => void;
  onNewWindow: (path?: string) => void;
  onCloseTab: () => void;
  onCycleTab: (delta: number) => void;
}) {
  const queryClient = useQueryClient();
  const { open } = useWindowActions();
  const isTop = useWindowIsTop();
  const home = useHomeDir();
  const trash = useTrashDir();
  const bookmarks = useBookmarks(home.data);
  const clipboard = useFileClipboard();
  const fs = getFsBridge()!;

  const [history, setHistory] = useState<string[]>(() => (initialPath ? [initialPath] : []));
  const [historyIndex, setHistoryIndex] = useState(initialPath ? 0 : -1);
  // While the user is typing a location; null shows the breadcrumbs.
  const [addressEdit, setAddressEdit] = useState<string | null>(null);
  // Filter for the current folder (Ctrl+F); null hides the field.
  const [filter, setFilter] = useState<string | null>(null);

  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  // Items to select once they show up in the listing (new, pasted, the
  // folder just left), and whether to start renaming the first.
  const [pending, setPending] = useState<{ names: string[]; rename?: boolean } | null>(() =>
    initialSelect ? { names: [initialSelect] } : null,
  );
  const [revealToken, setRevealToken] = useState(0);
  const reveal = useCallback(() => setRevealToken((t) => t + 1), []);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [quickLook, setQuickLook] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [focused, setFocused] = useState(false);
  const [columns, setColumns] = useState(1);
  const [menuFor, setMenuFor] = useState<'items' | 'background'>('background');
  const typeahead = useRef({ text: '', at: 0 });
  const startingRef = useRef(new Set<string>());
  const rootRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Until the user navigates, the current directory is the home directory.
  const cwd = historyIndex >= 0 ? history[historyIndex] : (home.data ?? null);
  const isTrash = cwd !== null && cwd === trash.data;

  useEffect(() => {
    onCwdChange(tabId, cwd);
  }, [tabId, cwd, onCwdChange]);

  const listing = useDirectory(cwd);
  useWatchDirectory(active ? cwd : null);
  const cwdDetails = useFsDetails(cwd);

  const entries = useMemo(() => {
    let items = listing.data?.entries ?? [];
    if (!prefs.showHidden) items = items.filter((e) => !e.name.startsWith('.'));
    if (filter) {
      const needle = filter.toLowerCase();
      items = items.filter((e) => e.name.toLowerCase().includes(needle));
    }
    return sortEntriesBy(items, prefs.sort.key, prefs.sort.descending);
  }, [listing.data, prefs.showHidden, prefs.sort, filter]);

  const byName = useMemo(() => new Map(entries.map((e, i) => [e.name, i])), [entries]);
  // The selection, less anything that's gone (deleted, filtered, hidden).
  const selected = useMemo(
    () => new Set([...selection].filter((n) => byName.has(n))),
    [selection, byName],
  );
  const selectedNames = useMemo(
    () => entries.filter((e) => selected.has(e.name)).map((e) => e.name),
    [entries, selected],
  );
  const selectedEntries = useMemo(
    () => selectedNames.map((n) => entries[byName.get(n)!]),
    [selectedNames, entries, byName],
  );
  const cut = useMemo(() => {
    if (!clipboard || clipboard.op !== 'cut' || cwd === null) return new Set<string>();
    return new Set(clipboard.paths.filter((p) => parentPath(p) === cwd).map(basename));
  }, [clipboard, cwd]);

  const focusView = useCallback(() => {
    rootRef.current?.querySelector<HTMLElement>('[data-files-view]')?.focus({ preventScroll: true });
  }, []);

  // Select what was waiting for the listing to catch up (adjusting state
  // during render, so the new items never draw unselected).
  if (pending) {
    const present = pending.names.filter((n) => byName.has(n));
    if (present.length > 0) {
      setSelection(new Set(present));
      setCursor(present[0]);
      setAnchor(present[0]);
      if (pending.rename) setRenaming(present[0]);
      setPending(null);
      setRevealToken((t) => t + 1);
    }
  }

  // Focus follows the tab and window: activating either puts it on the view.
  useEffect(() => {
    if (!active || !isTop) return;
    const el = rootRef.current;
    if (el && !el.contains(document.activeElement)) focusView();
  }, [active, isTop, focusView, cwd, listing.isSuccess]);

  // ---- Navigation ------------------------------------------------------------

  const navigate = useCallback(
    (target: string, select?: string) => {
      const normalized = target.length > 1 ? target.replace(/\/+$/, '') : '/';
      setAddressEdit(null);
      setFilter(null);
      setRenaming(null);
      setQuickLook(false);
      setSelection(new Set());
      setCursor(null);
      setAnchor(null);
      setPending(select ? { names: [select] } : null);
      if (normalized === cwd) return;
      setHistory((h) => {
        const base = historyIndex >= 0 ? h.slice(0, historyIndex + 1) : cwd ? [cwd] : [];
        setHistoryIndex(base.length);
        return [...base, normalized];
      });
      requestAnimationFrame(focusView);
    },
    [historyIndex, cwd, focusView],
  );

  // A disk ejected or pulled out takes its folders with it: go home rather
  // than sit on an error, as Finder closes the disk's windows.
  const volumes = useVolumes();
  const mounted = useMemo(
    () => (volumes.data?.volumes ?? []).flatMap((v) => (v.mountPoint ? [v.mountPoint] : [])),
    [volumes.data],
  );
  const lastMounted = useRef(mounted);
  useEffect(() => {
    const gone = lastMounted.current.filter((p) => !mounted.includes(p));
    lastMounted.current = mounted;
    if (cwd && home.data && gone.some((p) => cwd === p || cwd.startsWith(`${p}/`))) navigate(home.data);
  }, [mounted, cwd, home.data, navigate]);

  const go = useCallback(
    (delta: number) => {
      const target = historyIndex + delta;
      if (target < 0 || target >= history.length) return;
      // Going back selects the folder just left, when it's in this one.
      const leaving = cwd;
      setAddressEdit(null);
      setFilter(null);
      setRenaming(null);
      setQuickLook(false);
      setSelection(new Set());
      setCursor(null);
      setPending(leaving && parentPath(leaving) === history[target] ? { names: [basename(leaving)] } : null);
      setHistoryIndex(target);
    },
    [historyIndex, history, cwd],
  );

  const goUp = useCallback(() => {
    if (cwd && cwd !== '/') navigate(parentPath(cwd), basename(cwd));
  }, [cwd, navigate]);

  const submitAddress = async (raw: string) => {
    let target = raw.trim();
    if (target === '~' || target.startsWith('~/')) target = `${home.data ?? ''}${target.slice(1)}`;
    if (!target.startsWith('/') && cwd) target = joinPath(cwd, target);
    try {
      const stat = await fs.stat(target);
      if (stat.kind === 'directory') navigate(target);
      else navigate(parentPath(target), basename(target));
    } catch (error) {
      setStatus({ kind: 'error', text: cleanFsError(error) });
    }
  };

  // ---- Operations ------------------------------------------------------------

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setStatus({ kind: 'busy', text: label });
      try {
        await fn();
        setStatus((s) => (s?.kind === 'busy' && s.text === label ? null : s));
      } catch (error) {
        setStatus({ kind: 'error', text: cleanFsError(error) });
      }
    },
    [],
  );

  const refresh = useCallback(
    (...paths: string[]) => {
      void invalidateListings(queryClient, ...paths);
      void queryClient.invalidateQueries({ queryKey: ['fs', 'du'] });
    },
    [queryClient],
  );

  const pathsOf = useCallback(
    (names: string[]) => (cwd === null ? [] : names.map((n) => joinPath(cwd, n))),
    [cwd],
  );

  const openNames = useCallback(
    (names: string[], how: 'default' | 'tab' | 'window' = 'default') => {
      if (cwd === null || names.length === 0) return;
      const items = names.map((n) => entries[byName.get(n)!]).filter(Boolean);
      const folders = items.filter((e) => e.kind === 'directory');
      const files = items.filter((e) => e.kind === 'file');
      if (how === 'default' && folders.length === 1 && files.length === 0) {
        navigate(joinPath(cwd, folders[0].name));
        return;
      }
      for (const folder of folders) {
        const path = joinPath(cwd, folder.name);
        if (how === 'window') onNewWindow(path);
        else onNewTab(path);
      }
      const nativeApps = getNativeAppsBridge();
      for (const file of files) {
        const target = joinPath(cwd, file.name);
        if (nativeApps && isWindowsProgram(file.name)) {
          // Windows programs run, as they would from Explorer. The first one
          // also sets up Wine, which takes a while, so say something meanwhile.
          // Habitual double-clicks land here twice; one copy is plenty.
          if (startingRef.current.has(target)) continue;
          startingRef.current.add(target);
          setStatus({ kind: 'busy', text: `Opening ${file.name}…` });
          nativeApps
            .runWindowsProgram(target)
            .then(() => setStatus((s) => (s?.text === `Opening ${file.name}…` ? null : s)))
            .catch((error: unknown) => setStatus({ kind: 'error', text: cleanFsError(error) }))
            .finally(() => {
              // Wine takes a moment more to put the window up.
              setTimeout(() => startingRef.current.delete(target), 3_000);
            });
        } else {
          open(isTextFile(file.name) ? 'text-editor' : isPhotoshopFile(file.name) ? 'photo-editor' : (officeAppFor(file.name) ?? adobeAppFor(file.name) ?? 'preview'), { path: target });
        }
      }
    },
    [cwd, entries, byName, navigate, onNewTab, onNewWindow, open],
  );

  const copyOrCut = useCallback(
    (op: 'copy' | 'cut', names: string[]) => {
      if (names.length === 0) return;
      setFileClipboard({ op, paths: pathsOf(names) });
      setStatus({
        kind: 'info',
        text: `${op === 'copy' ? 'Copied' : 'Cut'} ${describe(names)} - paste with Ctrl+V`,
      });
    },
    [pathsOf],
  );

  const trashPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const names = paths.map(basename);
      void run(`Moving ${describe(names)} to the Trash…`, async () => {
        const trashed: string[] = [];
        try {
          for (const p of paths) trashed.push(await fs.trash(p));
        } catch (error) {
          const message = cleanFsError(error);
          if (/another drive/.test(message)) {
            const rest = paths.slice(trashed.length).map(basename);
            setDialog({ type: 'delete', names: rest, reason: message });
            return;
          }
          throw error;
        } finally {
          refresh(...paths);
          if (trashed.length > 0) {
            pushUndo({
              label: `trashing ${describe(names.slice(0, trashed.length))}`,
              undo: async () => {
                const restored: string[] = [];
                for (const t of trashed) restored.push(await fs.restore(t));
                refresh(...restored);
              },
            });
          }
        }
      });
    },
    [fs, run, refresh],
  );

  const deleteNames = useCallback(
    (names: string[]) => {
      if (cwd === null) return;
      void run(`Deleting ${describe(names)}…`, async () => {
        try {
          for (const name of names) {
            if (isTrash) await fs.purge(name);
            else {
              const entry = entries[byName.get(name) ?? -1];
              await fs.rm(joinPath(cwd, name), { recursive: entry?.kind === 'directory' });
            }
          }
        } finally {
          setDialog(null);
          refresh(...pathsOf(names));
        }
      });
    },
    [cwd, isTrash, fs, run, refresh, pathsOf, entries, byName],
  );

  const requestTrash = useCallback(
    (names: string[]) => {
      if (names.length === 0) return;
      // Things in the Trash can only go for good.
      if (isTrash) setDialog({ type: 'delete', names });
      else trashPaths(pathsOf(names));
    },
    [isTrash, trashPaths, pathsOf],
  );

  /** Copy or move `paths` into `target` (paste, drag and drop). */
  const transfer = useCallback(
    (target: string, paths: string[], copy: boolean) => {
      if (paths.length === 0) return;
      if (target === trash.data && !copy) {
        trashPaths(paths);
        return;
      }
      const names = paths.map(basename);
      void run(`${copy ? 'Copying' : 'Moving'} ${describe(names)}…`, async () => {
        const done: { from: string; to: string }[] = [];
        try {
          for (const from of paths) {
            const to = copy ? await fs.copyInto(from, target) : await fs.moveInto(from, target);
            if (to !== from) done.push({ from, to });
          }
        } finally {
          refresh(target, ...paths, ...done.map((d) => d.to));
          if (target === cwd && done.length > 0) setPending({ names: done.map((d) => basename(d.to)) });
          if (done.length > 0) {
            pushUndo({
              label: `${copy ? 'copy' : 'move'} of ${describe(done.map((d) => basename(d.to)))}`,
              undo: async () => {
                if (copy) {
                  for (const d of done) await fs.trash(d.to);
                } else {
                  for (const d of [...done].reverse()) await fs.move(d.to, d.from);
                }
                refresh(target, ...done.flatMap((d) => [d.from, d.to]));
              },
            });
          }
        }
      });
    },
    [trash.data, trashPaths, run, fs, refresh, cwd],
  );

  const paste = useCallback(
    (into?: string) => {
      const board = getFileClipboard();
      const target = into ?? cwd;
      if (!board || target === null) return;
      transfer(target, board.paths, board.op === 'copy');
      if (board.op === 'cut') setFileClipboard(null);
    },
    [cwd, transfer],
  );

  const renameEntry = useCallback(
    (from: string, to: string) => {
      setRenaming(null);
      requestAnimationFrame(focusView);
      if (cwd === null || from === to) return;
      const src = joinPath(cwd, from);
      const dest = joinPath(cwd, to);
      void run(`Renaming ${from}…`, async () => {
        await fs.move(src, dest);
        refresh(src, dest);
        setPending({ names: [to] });
        pushUndo({
          label: `rename of “${to}”`,
          undo: async () => {
            await fs.move(dest, src);
            refresh(src, dest);
          },
        });
      });
    },
    [cwd, fs, run, refresh, focusView],
  );

  const createNew = useCallback(
    (kind: 'folder' | 'file') => {
      if (cwd === null || isTrash) return;
      const name = freshName(listing.data?.entries, kind === 'folder' ? 'New Folder' : 'New Document');
      const path = joinPath(cwd, name);
      void run(`Creating ${name}…`, async () => {
        if (kind === 'folder') await fs.mkdir(path);
        else await fs.writeFile(path, '');
        refresh(path);
        setPending({ names: [name], rename: true });
        pushUndo({
          label: `creation of “${name}”`,
          undo: async () => {
            await fs.rm(path);
            refresh(path);
          },
        });
      });
    },
    [cwd, isTrash, listing.data, fs, run, refresh],
  );

  const duplicate = useCallback(
    (names: string[]) => {
      if (cwd === null || names.length === 0) return;
      void run(`Duplicating ${describe(names)}…`, async () => {
        const made: string[] = [];
        try {
          for (const name of names) made.push(await fs.copyInto(joinPath(cwd, name), cwd));
        } finally {
          refresh(cwd);
          if (made.length > 0) {
            setPending({ names: made.map(basename) });
            pushUndo({
              label: `duplicate of ${describe(made.map(basename))}`,
              undo: async () => {
                for (const p of made) await fs.trash(p);
                refresh(cwd);
              },
            });
          }
        }
      });
    },
    [cwd, fs, run, refresh],
  );

  const extract = useCallback(
    (names: string[]) => {
      if (cwd === null) return;
      const archives = names.filter(isExtractable);
      if (archives.length === 0) return;
      void run(`Extracting ${describe(archives)}…`, async () => {
        const made: string[] = [];
        try {
          for (const name of archives) made.push(await fs.extract(joinPath(cwd, name), cwd));
        } finally {
          refresh(cwd);
          if (made.length > 0) {
            setPending({ names: made.map(basename) });
            pushUndo({
              label: `extraction of ${describe(made.map(basename))}`,
              undo: async () => {
                for (const p of made) await fs.trash(p);
                refresh(cwd);
              },
            });
          }
        }
      });
    },
    [cwd, fs, run, refresh],
  );

  const compress = useCallback(
    (names: string[], fileName: string) => {
      if (cwd === null) return;
      setDialog({ type: 'compress', names, error: null, pending: true });
      fs.compress(cwd, names, fileName).then(
        (out) => {
          setDialog(null);
          refresh(cwd);
          setPending({ names: [basename(out)] });
          pushUndo({
            label: `creation of “${basename(out)}”`,
            undo: async () => {
              await fs.trash(out);
              refresh(cwd);
            },
          });
          requestAnimationFrame(focusView);
        },
        (error: unknown) =>
          setDialog({ type: 'compress', names, error: cleanFsError(error), pending: false }),
      );
    },
    [cwd, fs, refresh, focusView],
  );

  const restore = useCallback(
    (names: string[]) => {
      void run(`Restoring ${describe(names)}…`, async () => {
        const restored: string[] = [];
        try {
          for (const name of names) restored.push(await fs.restore(name));
        } finally {
          refresh(...pathsOf(names), ...restored);
        }
      });
    },
    [fs, run, refresh, pathsOf],
  );

  const emptyTrash = useCallback(() => {
    void run('Emptying the Trash…', async () => {
      try {
        await fs.purge();
      } finally {
        setDialog(null);
        if (trash.data) refresh(trash.data);
      }
    });
  }, [fs, run, refresh, trash.data]);

  const undo = useCallback(() => {
    const entry = popUndo();
    if (!entry) {
      setStatus({ kind: 'info', text: 'Nothing to undo' });
      return;
    }
    void run(`Undoing ${entry.label}…`, entry.undo);
  }, [run]);

  const openInTerminal = useCallback((path: string) => open('terminal', { cwd: path }), [open]);
  const canPrint = !!getPrintingBridge();
  const print = useCallback((path: string | undefined) => {
    if (!path) return;
    printFile(path).catch((error) => setStatus({ kind: 'error', text: cleanPrintingError(error) }));
  }, []);
  const { config } = useAppContext();
  const hasAssistant = !!getAssistantBridge() && config.assistantEnabled;
  const openInAssistant = useCallback(
    (path: string) => open('assistant', { directory: path, nonce: Date.now() }),
    [open],
  );

  const copyPaths = useCallback((paths: string[]) => {
    void navigator.clipboard?.writeText(paths.join('\n'));
    setStatus({ kind: 'info', text: paths.length === 1 ? 'Copied the path' : `Copied ${paths.length} paths` });
  }, []);

  const toggleBookmark = useCallback(
    (path: string) => {
      if (bookmarks.bookmarks.some((b) => b.path === path)) bookmarks.remove(path);
      else bookmarks.add(path);
    },
    [bookmarks],
  );

  const setSort = useCallback(
    (key: SortKey) =>
      setPrefs((p) => ({
        ...p,
        sort: { key, descending: p.sort.key === key ? !p.sort.descending : key === 'modified' || key === 'size' },
      })),
    [setPrefs],
  );

  // ---- Selection -------------------------------------------------------------

  const selectOnly = useCallback((name: string | null) => {
    setSelection(name === null ? new Set() : new Set([name]));
    setCursor(name);
    setAnchor(name);
  }, []);

  const selectRange = useCallback(
    (to: string, additive: boolean) => {
      const from = anchor ?? to;
      const a = byName.get(from) ?? 0;
      const b = byName.get(to) ?? 0;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = entries.slice(lo, hi + 1).map((e) => e.name);
      setSelection((s) => new Set(additive ? [...s, ...range] : range));
      setCursor(to);
    },
    [anchor, byName, entries],
  );

  const onItemPointerDown = useCallback(
    (name: string, e: React.MouseEvent) => {
      if (renaming !== null && renaming !== name) setRenaming(null);
      if (e.shiftKey) selectRange(name, e.ctrlKey || e.metaKey);
      else if (e.ctrlKey || e.metaKey) setCursor(name);
      else if (!selected.has(name)) selectOnly(name);
      else setCursor(name);
    },
    [renaming, selected, selectRange, selectOnly],
  );

  const onItemClick = useCallback(
    (name: string, e: React.MouseEvent) => {
      if (e.shiftKey) return;
      if (e.ctrlKey || e.metaKey) {
        setSelection((s) => {
          const next = new Set(s);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
        setAnchor(name);
        return;
      }
      // A plain click on one of several selected items narrows to it.
      selectOnly(name);
    },
    [selectOnly],
  );

  const onItemOpen = useCallback(
    (name: string, e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      openNames([name]);
    },
    [openNames],
  );

  const onMarqueeSelect = useCallback((names: Set<string>, last: string | null) => {
    setSelection(names);
    if (last !== null) {
      setCursor(last);
      setAnchor(last);
    } else if (names.size === 0) {
      setCursor(null);
      setAnchor(null);
    }
  }, []);

  const onItemContextMenu = useCallback(
    (name: string) => {
      setMenuFor('items');
      if (!selected.has(name)) selectOnly(name);
    },
    [selected, selectOnly],
  );

  const onBackgroundContextMenu = useCallback(() => {
    setMenuFor('background');
    selectOnly(null);
  }, [selectOnly]);

  const onItemDragStart = useCallback(
    (name: string, e: React.DragEvent) => {
      if (cwd === null) return;
      const names = selected.has(name) ? selectedNames : [name];
      if (!selected.has(name)) selectOnly(name);
      const folders = new Set(
        names.filter((n) => entries[byName.get(n)!]?.kind === 'directory').map((n) => joinPath(cwd, n)),
      );
      startFileDrag(e, { paths: pathsOf(names), folders }, names.length === 1 ? names[0] : `${names.length} items`);
    },
    [cwd, selected, selectedNames, selectOnly, entries, byName, pathsOf],
  );

  // ---- Keyboard --------------------------------------------------------------

  const moveCursor = (index: number, e: React.KeyboardEvent) => {
    if (entries.length === 0) return;
    const clamped = Math.max(0, Math.min(entries.length - 1, index));
    const name = entries[clamped].name;
    if (e.shiftKey) selectRange(name, false);
    else if (e.ctrlKey || e.metaKey) setCursor(name);
    else selectOnly(name);
    reveal();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inField = target.matches('input, textarea, select, [contenteditable="true"]');
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Window and tab shortcuts work everywhere, fields included.
    if (ctrl && !e.altKey) {
      if (key === 't' && !e.shiftKey) return handled(), onNewTab(cwd ?? undefined);
      if (key === 'n' && !e.shiftKey) return handled(), onNewWindow(cwd ?? undefined);
      if (key === 'n' && e.shiftKey) return handled(), createNew('folder');
      if (key === 'w' && !e.shiftKey) return handled(), onCloseTab();
      if (key === 'Tab') return handled(), onCycleTab(e.shiftKey ? -1 : 1);
      if (key === 'PageDown' || key === 'PageUp') return handled(), onCycleTab(key === 'PageUp' ? -1 : 1);
      if (key === 'l' && !e.shiftKey) {
        handled();
        setAddressEdit(cwd ?? '');
        requestAnimationFrame(() => addressRef.current?.select());
        return;
      }
      if (key === 'f' && !e.shiftKey) {
        handled();
        setFilter((f) => f ?? '');
        requestAnimationFrame(() => filterRef.current?.select());
        return;
      }
      if (key === 'h' && !e.shiftKey) {
        handled();
        setPrefs((p) => ({ ...p, showHidden: !p.showHidden }));
        return;
      }
      if (key === 'r' && !e.shiftKey) return handled(), void listing.refetch();
    }
    if (e.altKey && !ctrl) {
      if (key === 'ArrowLeft') return handled(), go(-1);
      if (key === 'ArrowRight') return handled(), go(1);
      if (key === 'ArrowUp') return handled(), goUp();
      if (key === 'Home' && home.data) return handled(), navigate(home.data);
      if (key === 'Enter' && !inField) {
        handled();
        setDialog({ type: 'properties', names: selectedNames });
        return;
      }
    }
    if (key === 'F5' && !ctrl) return handled(), void listing.refetch();
    if (key === 'F9') return handled(), setPrefs((p) => ({ ...p, sidebar: !p.sidebar }));
    if (inField) return;

    if (ctrl && !e.altKey) {
      if (key === 'a') {
        handled();
        setSelection(new Set(entries.map((x) => x.name)));
        return;
      }
      if (key === 'c' && !e.shiftKey) return handled(), copyOrCut('copy', selectedNames);
      if (key === 'x') return handled(), copyOrCut('cut', selectedNames);
      if (key === 'v') return handled(), paste();
      if (key === 'z' && !e.shiftKey) return handled(), undo();
      if (key === 'd' && cwd) {
        handled();
        const one = selectedEntries.length === 1 && selectedEntries[0].kind === 'directory';
        toggleBookmark(one ? joinPath(cwd, selectedNames[0]) : cwd);
        return;
      }
      if (key === '1') return handled(), setPrefs((p) => ({ ...p, view: 'list' }));
      if (key === '2') return handled(), setPrefs((p) => ({ ...p, view: 'grid' }));
      if (key === '=' || key === '+') {
        handled();
        setPrefs((p) => ({ ...p, view: 'grid', zoom: Math.min(GRID_ZOOMS.length - 1, p.zoom + (p.view === 'grid' ? 1 : 0)) }));
        return;
      }
      if (key === '-') {
        handled();
        setPrefs((p) => (p.view === 'grid' && p.zoom === 0 ? { ...p, view: 'list' } : { ...p, zoom: Math.max(0, p.zoom - 1) }));
        return;
      }
      if (key === ' ' && cursor) {
        handled();
        setSelection((s) => {
          const next = new Set(s);
          if (next.has(cursor)) next.delete(cursor);
          else next.add(cursor);
          return next;
        });
        return;
      }
      if (key === '/' || key === '?') return handled(), setDialog({ type: 'shortcuts' });
    }
    if (ctrl || e.altKey) return;

    const index = cursor !== null ? (byName.get(cursor) ?? -1) : -1;
    const page = Math.max(1, Math.floor((rootRef.current?.querySelector('[data-files-view]')?.clientHeight ?? 320) / 40)) * columns;
    switch (key) {
      case 'ArrowDown':
        return handled(), moveCursor(index === -1 ? 0 : index + columns, e);
      case 'ArrowUp':
        return handled(), moveCursor(index === -1 ? 0 : index - columns, e);
      case 'ArrowRight':
        if (columns > 1) return handled(), moveCursor(index + 1, e);
        return;
      case 'ArrowLeft':
        if (columns > 1) return handled(), moveCursor(index === -1 ? 0 : index - 1, e);
        return;
      case 'Home':
        return handled(), moveCursor(0, e);
      case 'End':
        return handled(), moveCursor(entries.length - 1, e);
      case 'PageDown':
        return handled(), moveCursor(index + page, e);
      case 'PageUp':
        return handled(), moveCursor(index - page, e);
      case 'Enter':
        return handled(), openNames(selectedNames);
      case 'Backspace':
        return handled(), goUp();
      case 'Delete':
        handled();
        if (e.shiftKey) setDialog({ type: 'delete', names: selectedNames });
        else requestTrash(selectedNames);
        return;
      case 'F2':
        if (selectedNames.length >= 1) {
          handled();
          setRenaming(cursor && selected.has(cursor) ? cursor : selectedNames[0]);
        }
        return;
      case 'F1':
        return handled(), setDialog({ type: 'shortcuts' });
      case 'Escape':
        handled();
        if (quickLook) setQuickLook(false);
        else if (filter !== null) setFilter(null);
        else selectOnly(null);
        return;
      case ' ':
        if (typeahead.current.text === '' || Date.now() - typeahead.current.at > TYPEAHEAD_MS) {
          handled();
          if (quickLook) setQuickLook(false);
          else if (cursor ?? selectedNames[0]) {
            if (!cursor) setCursor(selectedNames[0]);
            setQuickLook(true);
          }
          return;
        }
        break;
    }

    // Type-ahead: typing a name's first letters selects it.
    if (e.key.length === 1) {
      const now = Date.now();
      const t = typeahead.current;
      t.text = now - t.at > TYPEAHEAD_MS ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
      t.at = now;
      const from = index === -1 ? 0 : t.text.length === 1 ? index + 1 : index;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[(from + i) % entries.length];
        if (entry.name.toLowerCase().startsWith(t.text)) {
          handled();
          selectOnly(entry.name);
          reveal();
          return;
        }
      }
    }
  };

  // ---- Render ----------------------------------------------------------------

  const quickLookEntry = quickLook && cursor !== null ? entries[byName.get(cursor) ?? -1] : undefined;
  const bookmarked = new Set(bookmarks.bookmarks.map((b) => b.path));
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const singleFolderPath = single?.kind === 'directory' && cwd ? joinPath(cwd, single.name) : null;
  const anyExtractable = selectedNames.some(isExtractable);
  const selectionBytes = selectedEntries.reduce((n, e) => n + (e.kind === 'file' ? (e.size ?? 0) : 0), 0);

  const viewMenuItems = (
    parts: {
      Checkbox: typeof ContextMenuCheckboxItem | typeof DropdownMenuCheckboxItem;
      Sub: typeof ContextMenuSub | typeof DropdownMenuSub;
      SubTrigger: typeof ContextMenuSubTrigger | typeof DropdownMenuSubTrigger;
      SubContent: typeof ContextMenuSubContent | typeof DropdownMenuSubContent;
      RadioGroup: typeof ContextMenuRadioGroup | typeof DropdownMenuRadioGroup;
      Radio: typeof ContextMenuRadioItem | typeof DropdownMenuRadioItem;
      Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator;
      Shortcut: typeof ContextMenuShortcut | typeof DropdownMenuShortcut;
    },
  ) => {
    const { Checkbox, Sub, SubTrigger, SubContent, RadioGroup, Radio, Separator, Shortcut } = parts;
    return (
      <>
        <Sub>
          <SubTrigger>Sort By</SubTrigger>
          <SubContent>
            <RadioGroup
              value={prefs.sort.key}
              onValueChange={(v) => setPrefs((p) => ({ ...p, sort: { ...p.sort, key: v as SortKey } }))}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <Radio key={k} value={k}>
                  {SORT_LABELS[k]}
                </Radio>
              ))}
            </RadioGroup>
            <Separator />
            <Checkbox
              checked={prefs.sort.descending}
              onCheckedChange={(v) => setPrefs((p) => ({ ...p, sort: { ...p.sort, descending: v === true } }))}
            >
              Reversed
            </Checkbox>
          </SubContent>
        </Sub>
        <Sub>
          <SubTrigger>View As</SubTrigger>
          <SubContent>
            <RadioGroup value={prefs.view} onValueChange={(v) => setPrefs((p) => ({ ...p, view: v as ViewMode }))}>
              <Radio value="list">
                List <Shortcut>Ctrl+1</Shortcut>
              </Radio>
              <Radio value="grid">
                Icons <Shortcut>Ctrl+2</Shortcut>
              </Radio>
            </RadioGroup>
          </SubContent>
        </Sub>
        <Checkbox
          checked={prefs.showHidden}
          onCheckedChange={(v) => setPrefs((p) => ({ ...p, showHidden: v === true }))}
        >
          Show Hidden Files <Shortcut>Ctrl+H</Shortcut>
        </Checkbox>
      </>
    );
  };

  const contextParts = {
    Checkbox: ContextMenuCheckboxItem,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
    RadioGroup: ContextMenuRadioGroup,
    Radio: ContextMenuRadioItem,
    Separator: ContextMenuSeparator,
    Shortcut: ContextMenuShortcut,
  };
  const dropdownParts = {
    Checkbox: DropdownMenuCheckboxItem,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
    RadioGroup: DropdownMenuRadioGroup,
    Radio: DropdownMenuRadioItem,
    Separator: DropdownMenuSeparator,
    Shortcut: DropdownMenuShortcut,
  };

  return (
    <div
      ref={rootRef}
      className="flex h-full w-full flex-col"
      onKeyDown={onKeyDown}
      onFocusCapture={(e) => setFocused((e.target as HTMLElement).hasAttribute('data-files-view'))}
      onBlurCapture={() => setFocused(false)}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-background/50 px-2 py-1.5">
        <ToolButton label="Back (Alt+Left)" disabled={historyIndex <= 0} onClick={() => go(-1)}>
          <ArrowLeft className="size-4" />
        </ToolButton>
        <ToolButton
          label="Forward (Alt+Right)"
          disabled={historyIndex >= history.length - 1}
          onClick={() => go(1)}
        >
          <ArrowRight className="size-4" />
        </ToolButton>
        <ToolButton label="Up (Alt+Up)" disabled={cwd === null || cwd === '/'} onClick={goUp}>
          <ArrowUp className="size-4" />
        </ToolButton>

        {addressEdit !== null ? (
          <form
            className="min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              void submitAddress(addressEdit);
            }}
          >
            <input
              ref={addressRef}
              type="text"
              aria-label="Location"
              value={addressEdit}
              onChange={(e) => setAddressEdit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setAddressEdit(null);
                  focusView();
                }
              }}
              onBlur={() => setAddressEdit(null)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              className="h-8 w-full rounded-md border border-ring/60 bg-background px-3 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </form>
        ) : (
          <Breadcrumbs
            cwd={cwd}
            home={home.data}
            trash={trash.data}
            onNavigate={navigate}
            onEdit={() => {
              setAddressEdit(cwd ?? '');
              requestAnimationFrame(() => addressRef.current?.select());
            }}
            onDrop={transfer}
          />
        )}

        {filter !== null ? (
          <div className="relative w-40 shrink-0 sm:w-48">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              ref={filterRef}
              type="search"
              aria-label="Filter this folder"
              placeholder="Filter"
              value={filter}
              autoFocus
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setFilter(null);
                  focusView();
                } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  if (entries.length > 0 && selected.size === 0) selectOnly(entries[0].name);
                  focusView();
                }
              }}
              className="h-8 w-full rounded-md border border-border/60 bg-background pl-7 pr-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
        ) : (
          <ToolButton
            label="Filter (Ctrl+F)"
            onClick={() => {
              setFilter('');
              requestAnimationFrame(() => filterRef.current?.focus());
            }}
          >
            <Search className="size-4" />
          </ToolButton>
        )}

        <div role="radiogroup" aria-label="View" className="flex shrink-0 rounded-md bg-foreground/5 p-0.5">
          {(['list', 'grid'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={prefs.view === mode}
              aria-label={mode === 'list' ? 'List view (Ctrl+1)' : 'Icon view (Ctrl+2)'}
              title={mode === 'list' ? 'List view (Ctrl+1)' : 'Icon view (Ctrl+2)'}
              onClick={() => setPrefs((p) => ({ ...p, view: mode }))}
              className={cn(
                'grid size-7 place-items-center rounded text-foreground/70',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                prefs.view === mode ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground',
              )}
            >
              {mode === 'list' ? <List className="size-4" /> : <LayoutGrid className="size-4" />}
            </button>
          ))}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Menu"
              title="Menu"
              className="grid size-8 shrink-0 place-items-center rounded-md text-foreground/80 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/10"
            >
              <BarsStaggeredIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60" onCloseAutoFocus={(e) => {
            if (document.activeElement === document.body || !document.activeElement) {
              e.preventDefault();
              focusView();
            }
          }}>
            <DropdownMenuItem onSelect={() => onNewTab(cwd ?? undefined)}>
              New Tab <DropdownMenuShortcut>Ctrl+T</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewWindow(cwd ?? undefined)}>
              New Window <DropdownMenuShortcut>Ctrl+N</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={isTrash} onSelect={() => createNew('folder')}>
              New Folder <DropdownMenuShortcut>Ctrl+Shift+N</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isTrash} onSelect={() => createNew('file')}>
              New Document
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={undo}>
              Undo <DropdownMenuShortcut>Ctrl+Z</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {viewMenuItems(dropdownParts)}
            <DropdownMenuCheckboxItem
              checked={prefs.sidebar}
              onCheckedChange={(v) => setPrefs((p) => ({ ...p, sidebar: v === true }))}
            >
              Show Sidebar <DropdownMenuShortcut>F9</DropdownMenuShortcut>
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {cwd && (
              <DropdownMenuItem onSelect={() => toggleBookmark(cwd)}>
                {bookmarked.has(cwd) ? 'Remove from Favorites' : 'Add to Favorites'}
                <DropdownMenuShortcut>Ctrl+D</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {cwd && <DropdownMenuItem onSelect={() => openInTerminal(cwd)}>Open in Terminal</DropdownMenuItem>}
            {cwd && hasAssistant && (
              <DropdownMenuItem onSelect={() => openInAssistant(cwd)}>Open in Assistant</DropdownMenuItem>
            )}
            {isTrash && (
              <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ type: 'emptyTrash' })}>
                Empty Trash…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setDialog({ type: 'properties', names: [] })}>
              Folder Properties
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog({ type: 'shortcuts' })}>
              Keyboard Shortcuts <DropdownMenuShortcut>F1</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {prefs.sidebar && (
          <div className="hidden sm:block">
            <Sidebar
              home={home.data}
              trashDir={trash.data}
              cwd={cwd}
              bookmarks={bookmarks.bookmarks}
              onNavigate={(p) => navigate(p)}
              onOpenInNewTab={onNewTab}
              onOpenInNewWindow={onNewWindow}
              onAddBookmark={bookmarks.add}
              onRemoveBookmark={bookmarks.remove}
              onDrop={transfer}
              onEmptyTrash={() => setDialog({ type: 'emptyTrash' })}
              onProperties={(p) => {
                if (p !== cwd) navigate(p);
                setDialog({ type: 'properties', names: [] });
              }}
            />
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {isTrash && (
            <div className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-foreground/5 px-4 py-2 text-sm">
              <Trash2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                Items in the Trash can be restored, or deleted for good.
              </span>
              <button
                type="button"
                disabled={entries.length === 0}
                onClick={() => setDialog({ type: 'emptyTrash' })}
                className="h-7 shrink-0 rounded-md px-3 text-sm font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                Empty Trash
              </button>
            </div>
          )}

          {listing.isLoading || cwd === null ? (
            <ListSkeleton />
          ) : listing.isError ? (
            <div className="grid flex-1 place-items-center p-6">
              <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  Couldn’t open this folder: {cleanFsError(listing.error)}
                </p>
              </div>
            </div>
          ) : (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <EntryView
                    key={cwd}
                    dir={cwd}
                    entries={entries}
                    mode={prefs.view}
                    zoom={prefs.zoom}
                    selection={selected}
                    cursor={cursor}
                    cut={cut}
                    renaming={renaming}
                    sort={prefs.sort}
                    focused={focused}
                    revealToken={revealToken}
                    onSort={setSort}
                    onItemPointerDown={onItemPointerDown}
                    onItemClick={onItemClick}
                    onItemOpen={onItemOpen}
                    onItemMiddleClick={(name) => {
                      if (entries[byName.get(name) ?? -1]?.kind === 'directory') openNames([name], 'tab');
                    }}
                    onSelect={onMarqueeSelect}
                    onItemContextMenu={onItemContextMenu}
                    onBackgroundContextMenu={onBackgroundContextMenu}
                    onItemDragStart={onItemDragStart}
                    onDragEnd={endFileDrag}
                    onDrop={transfer}
                    onRenameSubmit={renameEntry}
                    onRenameCancel={() => {
                      setRenaming(null);
                      requestAnimationFrame(focusView);
                    }}
                    onColumnsChange={setColumns}
                  />
                  {entries.length === 0 && (
                    <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
                      <p className="text-sm text-muted-foreground">
                        {filter ? `Nothing here matches “${filter}”.` : isTrash ? 'The Trash is empty.' : 'This folder is empty.'}
                      </p>
                    </div>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                className="w-60"
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  if (document.activeElement === document.body || !document.activeElement) focusView();
                }}
              >
                {menuFor === 'items' && selectedNames.length > 0 ? (
                  <>
                    <ContextMenuItem onSelect={() => openNames(selectedNames)}>
                      {single && isWindowsProgram(single.name) ? 'Run' : 'Open'}
                      <ContextMenuShortcut>Enter</ContextMenuShortcut>
                    </ContextMenuItem>
                    {selectedEntries.some((e) => e.kind === 'directory') && (
                      <>
                        <ContextMenuItem onSelect={() => openNames(selectedNames.filter((n) => entries[byName.get(n)!].kind === 'directory'), 'tab')}>
                          Open in New Tab
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => openNames(selectedNames.filter((n) => entries[byName.get(n)!].kind === 'directory'), 'window')}>
                          Open in New Window
                        </ContextMenuItem>
                      </>
                    )}
                    {single?.kind === 'file' && (
                      <ContextMenuItem onSelect={() => setQuickLook(true)}>
                        Quick Look <ContextMenuShortcut>Space</ContextMenuShortcut>
                      </ContextMenuItem>
                    )}
                    {single?.kind === 'file' && !isTrash && !isTextFile(single.name) && (
                      <ContextMenuItem onSelect={() => open('text-editor', { path: pathsOf([single.name])[0] })}>
                        Open in Text Editor
                      </ContextMenuItem>
                    )}
                    {single?.kind === 'file' && !isTrash && isDelimitedText(single.name) && (
                      <ContextMenuItem onSelect={() => open('spreadsheet', { path: pathsOf([single.name])[0] })}>
                        Open in Spreadsheet
                      </ContextMenuItem>
                    )}
                    {single?.kind === 'file' && !isTrash && isViewableImage(single.name) && (
                      <ContextMenuItem onSelect={() => open('paint', { path: pathsOf([single.name])[0] })}>
                        Edit in Paint
                      </ContextMenuItem>
                    )}
                    {single?.kind === 'file' && !isTrash && isPhotoEditable(single.name) && !isPhotoshopFile(single.name) && (
                      <ContextMenuItem onSelect={() => open('photo-editor', { path: pathsOf([single.name])[0] })}>
                        Edit in Photo Editor
                      </ContextMenuItem>
                    )}
                    {single?.kind === 'file' && !isTrash && isVectorEditable(single.name) && (
                      <ContextMenuItem onSelect={() => open('vector-editor', { path: pathsOf([single.name])[0] })}>
                        Edit in Vector Editor
                      </ContextMenuItem>
                    )}
                    {single?.kind === 'file' && !isTrash && canPrint && isPrintableFile(single.name) && (
                      <ContextMenuItem onSelect={() => print(pathsOf([single.name])[0])}>Print…</ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    {isTrash ? (
                      <ContextMenuItem onSelect={() => restore(selectedNames)}>Restore</ContextMenuItem>
                    ) : (
                      <>
                        <ContextMenuItem onSelect={() => copyOrCut('cut', selectedNames)}>
                          Cut <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => copyOrCut('copy', selectedNames)}>
                          Copy <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
                        </ContextMenuItem>
                        {singleFolderPath && (
                          <ContextMenuItem disabled={!clipboard} onSelect={() => paste(singleFolderPath)}>
                            Paste Into Folder
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem onSelect={() => duplicate(selectedNames)}>Duplicate</ContextMenuItem>
                        {single && (
                          <ContextMenuItem onSelect={() => setRenaming(single.name)}>
                            Rename… <ContextMenuShortcut>F2</ContextMenuShortcut>
                          </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                        {anyExtractable && (
                          <ContextMenuItem onSelect={() => extract(selectedNames)}>Extract Here</ContextMenuItem>
                        )}
                        <ContextMenuItem
                          onSelect={() =>
                            setDialog({ type: 'compress', names: selectedNames, error: null, pending: false })
                          }
                        >
                          Compress…
                        </ContextMenuItem>
                      </>
                    )}
                    {singleFolderPath && (
                      <>
                        <ContextMenuItem onSelect={() => toggleBookmark(singleFolderPath)}>
                          {bookmarked.has(singleFolderPath) ? 'Remove from Favorites' : 'Add to Favorites'}
                          <ContextMenuShortcut>Ctrl+D</ContextMenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => openInTerminal(singleFolderPath)}>
                          Open in Terminal
                        </ContextMenuItem>
                        {hasAssistant && (
                          <ContextMenuItem onSelect={() => openInAssistant(singleFolderPath)}>
                            Open in Assistant
                          </ContextMenuItem>
                        )}
                      </>
                    )}
                    <ContextMenuItem onSelect={() => copyPaths(pathsOf(selectedNames))}>
                      Copy {selectedNames.length === 1 ? 'Path' : 'Paths'}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {!isTrash && (
                      <ContextMenuItem onSelect={() => requestTrash(selectedNames)}>
                        Move to Trash <ContextMenuShortcut>Delete</ContextMenuShortcut>
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => setDialog({ type: 'delete', names: selectedNames })}
                    >
                      Delete Permanently… <ContextMenuShortcut>Shift+Del</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => setDialog({ type: 'properties', names: selectedNames })}>
                      Properties <ContextMenuShortcut>Alt+Enter</ContextMenuShortcut>
                    </ContextMenuItem>
                  </>
                ) : (
                  <>
                    {!isTrash && (
                      <>
                        <ContextMenuItem onSelect={() => createNew('folder')}>
                          New Folder <ContextMenuShortcut>Ctrl+Shift+N</ContextMenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => createNew('file')}>New Document</ContextMenuItem>
                        <ContextMenuItem disabled={!clipboard} onSelect={() => paste()}>
                          Paste <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                      </>
                    )}
                    <ContextMenuItem
                      disabled={entries.length === 0}
                      onSelect={() => setSelection(new Set(entries.map((x) => x.name)))}
                    >
                      Select All <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {viewMenuItems(contextParts)}
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => cwd && openInTerminal(cwd)}>Open in Terminal</ContextMenuItem>
                    {cwd && hasAssistant && (
                      <ContextMenuItem onSelect={() => openInAssistant(cwd)}>Open in Assistant</ContextMenuItem>
                    )}
                    {cwd && (
                      <ContextMenuItem onSelect={() => toggleBookmark(cwd)}>
                        {bookmarked.has(cwd) ? 'Remove from Favorites' : 'Add to Favorites'}
                      </ContextMenuItem>
                    )}
                    {isTrash && (
                      <ContextMenuItem variant="destructive" disabled={entries.length === 0} onSelect={() => setDialog({ type: 'emptyTrash' })}>
                        Empty Trash…
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem onSelect={() => setDialog({ type: 'properties', names: [] })}>
                      Properties
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          )}
        </div>

        {quickLookEntry && cwd && (
          <div className="absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in-0">
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {quickLookEntry.name}
              </span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                Arrow keys browse · Enter opens
              </span>
              <ToolButton label="Close (Space)" onClick={() => { setQuickLook(false); focusView(); }}>
                <X className="size-4" />
              </ToolButton>
            </div>
            <div className="min-h-0 flex-1">
              {quickLookEntry.kind === 'directory' ? (
                <div className="grid h-full place-items-center text-sm text-muted-foreground">
                  A folder - press Enter to open it.
                </div>
              ) : (
                <FileViewerBody
                  key={quickLookEntry.name}
                  path={joinPath(cwd, quickLookEntry.name)}
                  size={quickLookEntry.size}
                  mtimeMs={quickLookEntry.mtimeMs}
                  onExtract={() => {
                    setQuickLook(false);
                    extract([quickLookEntry.name]);
                  }}
                />
              )}
            </div>
          </div>
        )}

        {dialog?.type === 'properties' && cwd && (
          <PropertiesDialog
            dir={cwd}
            entries={dialog.names.map((n) => entries[byName.get(n) ?? -1]).filter(Boolean)}
            onClose={() => {
              setDialog(null);
              focusView();
            }}
          />
        )}
        {dialog?.type === 'compress' && (
          <CompressDialog
            defaultName={dialog.names.length === 1 ? dialog.names[0].replace(/(\.[^.]+)+$/, '') || dialog.names[0] : 'Archive'}
            count={dialog.names.length}
            pending={dialog.pending}
            error={dialog.error}
            onSubmit={(fileName) => compress(dialog.names, fileName)}
            onCancel={() => {
              setDialog(null);
              focusView();
            }}
          />
        )}
        {dialog?.type === 'delete' && dialog.names.length > 0 && (
          <ConfirmDialog
            title={`Delete ${describe(dialog.names)} permanently?`}
            message={`${dialog.reason ? `${dialog.reason}. ` : ''}This can’t be undone.`}
            confirmLabel="Delete"
            pending={status?.kind === 'busy'}
            onConfirm={() => deleteNames(dialog.names)}
            onCancel={() => {
              setDialog(null);
              focusView();
            }}
          />
        )}
        {dialog?.type === 'emptyTrash' && (
          <ConfirmDialog
            title="Empty the Trash?"
            message="Everything in it will be deleted for good. This can’t be undone."
            confirmLabel="Empty Trash"
            pending={status?.kind === 'busy'}
            onConfirm={emptyTrash}
            onCancel={() => {
              setDialog(null);
              focusView();
            }}
          />
        )}
        {dialog?.type === 'shortcuts' && (
          <ShortcutsDialog
            onClose={() => {
              setDialog(null);
              focusView();
            }}
          />
        )}
      </div>

      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 bg-background/50 px-3 py-1 text-xs text-muted-foreground">
        <span className="shrink-0 tabular-nums">
          {!listing.data
            ? '…'
            : selectedNames.length === 0
              ? `${entries.length.toLocaleString()} item${entries.length === 1 ? '' : 's'}`
              : selectedNames.length === 1
                ? `“${selectedNames[0]}” selected${selectionBytes > 0 ? ` (${formatBytes(selectionBytes)})` : ''}`
                : `${selectedNames.length.toLocaleString()} of ${entries.length.toLocaleString()} selected${selectionBytes > 0 ? ` (${formatBytes(selectionBytes)})` : ''}`}
        </span>
        {listing.data?.truncated && (
          <span className="shrink-0 text-amber-600 dark:text-amber-400">
            Showing the first {listing.data.entries.length.toLocaleString()} items.
          </span>
        )}
        <span
          role={status?.kind === 'error' ? 'alert' : 'status'}
          className={cn(
            'min-w-0 flex-1 truncate text-right',
            status?.kind === 'error' && 'text-destructive',
          )}
        >
          {status?.text}
        </span>
        {status && status.kind !== 'busy' && (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setStatus(null)}
            className="grid size-4 shrink-0 place-items-center rounded hover:bg-foreground/10"
          >
            <X className="size-3" />
          </button>
        )}
        {status?.kind === 'busy' && <RotateCw className="size-3 shrink-0 animate-spin" aria-hidden />}
        {cwdDetails.data?.free != null && !status && (
          <span className="shrink-0 tabular-nums">{formatBytes(cwdDetails.data.free)} free</span>
        )}
      </div>
    </div>
  );
}

/**
 * The path as clickable segments (Home › Projects › din). Each segment is a
 * drop target too; clicking the empty space after them types a location.
 */
function Breadcrumbs({
  cwd,
  home,
  trash,
  onNavigate,
  onEdit,
  onDrop,
}: {
  cwd: string | null;
  home: string | undefined;
  trash: string | undefined;
  onNavigate: (path: string) => void;
  onEdit: () => void;
  onDrop: (target: string, paths: string[], copy: boolean) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const crumbs = useMemo(() => {
    if (!cwd) return [];
    const list: { path: string; label: string; icon?: 'home' | 'root' | 'trash' }[] = [];
    let rest: string;
    let base: string;
    if (trash && (cwd === trash || cwd.startsWith(`${trash}/`))) {
      list.push({ path: trash, label: 'Trash', icon: 'trash' });
      rest = cwd.slice(trash.length);
      base = trash;
    } else if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
      list.push({ path: home, label: 'Home', icon: 'home' });
      rest = cwd.slice(home.length);
      base = home;
    } else {
      list.push({ path: '/', label: 'Computer', icon: 'root' });
      rest = cwd;
      base = '';
    }
    let acc = base;
    for (const part of rest.split('/').filter(Boolean)) {
      acc = `${acc}/${part}`;
      list.push({ path: acc, label: part });
    }
    return list;
  }, [cwd, home, trash]);

  // Keep the deepest segment in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [crumbs]);

  return (
    <div
      ref={scrollRef}
      className="flex h-8 min-w-0 flex-1 cursor-text items-center overflow-x-auto rounded-md border border-border/60 bg-secondary/60 px-1 [scrollbar-width:none]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onEdit();
      }}
      title="Click to type a location (Ctrl+L)"
    >
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={c.path} className="flex shrink-0 items-center">
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />}
            <button
              type="button"
              onClick={() => onNavigate(c.path)}
              aria-current={last ? 'location' : undefined}
              onDragOver={(e) => {
                if (last || !e.dataTransfer.types.includes('application/x-din-files')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
                setOver(c.path);
              }}
              onDragLeave={() => setOver((o) => (o === c.path ? null : o))}
              onDrop={(e) => {
                setOver(null);
                const raw = e.dataTransfer.getData('application/x-din-files');
                if (!raw) return;
                e.preventDefault();
                try {
                  onDrop(c.path, JSON.parse(raw) as string[], e.ctrlKey);
                } catch {
                  // Not ours after all.
                }
              }}
              className={cn(
                'flex h-6 items-center gap-1.5 rounded px-1.5 text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                over === c.path
                  ? 'bg-primary/20 ring-2 ring-primary'
                  : last
                    ? 'font-medium text-foreground'
                    : 'text-foreground/70 hover:bg-foreground/10 hover:text-foreground',
              )}
            >
              {c.icon === 'home' && <Home className="size-3.5" aria-hidden />}
              {c.icon === 'root' && <HardDrive className="size-3.5" aria-hidden />}
              {c.icon === 'trash' && <Trash2 className="size-3.5" aria-hidden />}
              <span className="max-w-48 truncate">{c.label}</span>
            </button>
          </span>
        );
      })}
      <span className="h-full min-w-8 flex-1" onClick={onEdit} />
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 p-2" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton className="size-5 rounded bg-foreground/10" />
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
