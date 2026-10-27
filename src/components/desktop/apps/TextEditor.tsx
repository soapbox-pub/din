import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorSelection, EditorState, Text, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  cursorMatchingBracket,
  deleteLine,
  deleteTrailingWhitespace,
  moveLineDown,
  moveLineUp,
  selectAll,
  toggleBlockComment,
  toggleComment,
} from '@codemirror/commands';
import { foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language';
import { selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import {
  Command,
  Files,
  FolderOpen,
  FolderPlus,
  FilePlus,
  ListCollapse,
  Map as MapIcon,
  PanelLeft,
  RefreshCw,
  Save,
  Search,
  WrapText,
} from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { cn } from '@/lib/utils';
import { cleanFsError, getFsBridge, parentPath, type FsBridge, type FsSearchOptions, type FsSearchResult } from '@/lib/fs';
import { setCloseGuard } from '@/lib/closeGuards';
import { invalidateListings } from '@/hooks/useFileSystem';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { Skeleton } from '@/components/ui/skeleton';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { TabStrip } from '@/components/desktop/TabStrip';
import { DialogButton, Overlay } from './files/Dialogs';
import { FileIcon } from './files/FileIcon';
import { IconButton } from './code/controls';
import { openFind } from './code/findPanel';
import { FileTree, type FileTreeActions } from './code/FileTree';
import { languageFor, languageForShebang, languages } from './code/languages';
import { Palette, type PaletteCommand, type PaletteFile, type PaletteMode } from './code/Palette';
import { SearchView } from './code/SearchView';
import { initialSearch, searchRegExp, type SearchState } from './code/search';
import {
  createEditorState,
  describeIndent,
  indentConf,
  indentUnit,
  languageConf,
  prefEffects,
  type EditorPrefs,
} from './code/setup';
import { useIsDark } from './code/theme';

/** Bigger files than this aren't opened. */
const MAX_BYTES = 16 * 1024 * 1024;
const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32];
const DEFAULT_FONT_SIZE = 14;
const WRAP_KEY = 'din:text-editor:wrap';
const FONT_SIZE_KEY = 'din:text-editor:font-size';
const MINIMAP_KEY = 'din:text-editor:minimap';
const SIDEBAR_KEY = 'din:text-editor:sidebar-width';
/** The last folder worked in, its open files and opened folders, for the next launch. */
const WORKSPACE_KEY = 'din:text-editor:workspace';
const MIN_SIDEBAR = 160;
const MAX_SIDEBAR = 600;

function readSetting<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isFontSize = (v: unknown): v is number => typeof v === 'number' && FONT_SIZES.includes(v);
const isWidth = (v: unknown): v is number => typeof v === 'number' && v >= MIN_SIDEBAR && v <= MAX_SIDEBAR;

interface Workspace {
  folder: string;
  files: string[];
  active: string | null;
  expanded: string[];
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isWorkspace = (v: unknown): v is Workspace => {
  if (typeof v !== 'object' || v === null) return false;
  const w = v as Record<string, unknown>;
  return typeof w.folder === 'string' && isStringArray(w.files) && (w.active === null || typeof w.active === 'string') && isStringArray(w.expanded);
};

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A file's text, or why it can't be edited here. */
async function readText(fs: FsBridge, path: string): Promise<{ text: string } | { error: string }> {
  try {
    const result = await fs.readFile(path, MAX_BYTES);
    if (result.truncated) return { error: 'It’s too big for the Text Editor (over 16 MB).' };
    const bytes = result.data;
    // A null byte near the start: it's binary.
    if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) {
      return { error: 'It doesn’t look like a text file.' };
    }
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) };
  } catch (error) {
    return { error: cleanFsError(error) };
  }
}

/** The smallest change turning `from` into `to`, so the cursor and scroll stay put. */
function minimalChange(from: string, to: string) {
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

interface Tab {
  id: string;
  /** Absolute path, or null for a new document not yet saved. */
  path: string | null;
  /** "Untitled-N" for a new document. */
  untitled: number;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  language: string | null;
  indent: string;
}

interface Reveal {
  line: number;
  column: number;
  length?: number;
}

interface Caret {
  line: number;
  column: number;
  selected: number;
  cursors: number;
  lines: number;
}

/** Caret position, kept out of React state so typing doesn't re-render the window. */
function createCaretStore() {
  let caret: Caret = { line: 1, column: 1, selected: 0, cursors: 1, lines: 1 };
  const listeners = new Set<() => void>();
  return {
    get: () => caret,
    set(state: EditorState) {
      const main = state.selection.main;
      const line = state.doc.lineAt(main.head);
      const next = {
        line: line.number,
        column: main.head - line.from + 1,
        selected: state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0),
        cursors: state.selection.ranges.length,
        lines: state.doc.lines,
      };
      if (Object.entries(next).every(([k, v]) => caret[k as keyof Caret] === v)) return;
      caret = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type Asking = { kind: 'tab'; id: string } | { kind: 'window' } | null;

/**
 * Text Editor - code and plain text, in the manner of VS Code: a folder
 * open in the sidebar, files in tabs, quick open (Ctrl+P), the command
 * palette (Ctrl+Shift+P), search across the folder (Ctrl+Shift+F), and
 * CodeMirror's editing: syntax highlighting, multiple cursors, folding,
 * bracket matching, completion, regex find and replace and a minimap.
 * Files changed on disk reload unless they have unsaved changes; closing
 * with unsaved changes asks about them first.
 *
 * Launch params: `{ path?: string }` opens a file, `{ folder?: string }` a
 * folder, `{ blank: true }` an empty window. None reopens the last folder.
 */
export function TextEditor({ windowId, params }: AppComponentProps) {
  const initialPath = typeof params?.path === 'string' ? params.path : null;
  const initialFolder = typeof params?.folder === 'string' ? params.folder : null;
  const fs = getFsBridge();
  const { open, close, focus } = useWindowActions();
  const { pickFiles } = useFilePicker();
  const queryClient = useQueryClient();
  const setTitlebar = useWindowTitlebar();
  const dark = useIsDark();

  // What to open first: a file, a folder, or the last folder with its files.
  const [launch] = useState(() => {
    const workspace = initialPath || initialFolder || params?.blank
      ? null
      : readSetting(WORKSPACE_KEY, null, (v): v is Workspace | null => v === null || isWorkspace(v));
    return {
      folder: initialFolder ?? workspace?.folder ?? null,
      expanded: workspace?.expanded ?? [],
      files: initialPath
        ? [initialPath]
        : workspace ? [...workspace.files, ...(workspace.active ? [workspace.active] : [])] : [],
    };
  });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(launch.folder);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(launch.expanded));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<'explorer' | 'search'>('explorer');
  const [sidebarWidth, setSidebarWidth] = useState(() => readSetting(SIDEBAR_KEY, 256, isWidth));
  const [wrap, setWrap] = useState(() => readSetting(WRAP_KEY, false, isBoolean));
  const [minimap, setMinimap] = useState(() => readSetting(MINIMAP_KEY, true, isBoolean));
  const [fontSize, setFontSize] = useState(() => readSetting(FONT_SIZE_KEY, DEFAULT_FONT_SIZE, isFontSize));
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState<Asking>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [search, setSearch] = useState<SearchState>(initialSearch);
  const [searchFocus, setSearchFocus] = useState(0);
  const [treeRequest, setTreeRequest] = useState<{ kind: 'file' | 'folder'; token: number } | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Each tab's editor state while it isn't the one shown (the view holds that one). */
  const states = useRef(new Map<string, EditorState>());
  /** What each tab's file held when last read or saved. */
  const saved = useRef(new Map<string, Text>());
  const mtimes = useRef(new Map<string, number>());
  const scrolls = useRef(new Map<string, ReturnType<EditorView['scrollSnapshot']>>());
  const reveals = useRef(new Map<string, Reveal>());
  const shown = useRef<string | null>(null);
  const tabsRef = useRef(tabs);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const nextId = useRef(1);
  const nextUntitled = useRef(1);
  const chord = useRef(false);
  const [caretStore] = useState(createCaretStore);

  const prefs: EditorPrefs = useMemo(() => ({ wrap, fontSize, dark, minimap }), [wrap, fontSize, dark, minimap]);
  const prefsRef = useRef(prefs);
  useLayoutEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  useEffect(() => localStorage.setItem(WRAP_KEY, JSON.stringify(wrap)), [wrap]);
  useEffect(() => localStorage.setItem(MINIMAP_KEY, JSON.stringify(minimap)), [minimap]);
  useEffect(() => localStorage.setItem(FONT_SIZE_KEY, JSON.stringify(fontSize)), [fontSize]);
  useEffect(() => localStorage.setItem(SIDEBAR_KEY, JSON.stringify(sidebarWidth)), [sidebarWidth]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const tabName = (tab: Tab) => (tab.path ? basename(tab.path) : `Untitled-${tab.untitled}`);

  useWindowTitle(
    activeTab
      ? `${activeTab.dirty ? '• ' : ''}${tabName(activeTab)}${folder ? ` — ${basename(folder)}` : ''}`
      : folder ? basename(folder) : 'Text Editor',
  );

  // -------------------------------------------------------------------------
  // Tab states.
  // -------------------------------------------------------------------------

  const stateOf = useCallback((id: string): EditorState | undefined => {
    if (id === shown.current && viewRef.current) return viewRef.current.state;
    return states.current.get(id);
  }, []);

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const syncDirty = useCallback((id: string, state: EditorState) => {
    const dirty = !state.doc.eq(saved.current.get(id) ?? Text.empty);
    // Against the latest tabs, not the last render's: a change and a save can land together.
    setTabs((ts) => (ts.some((t) => t.id === id && t.dirty !== dirty) ? ts.map((t) => (t.id === id ? { ...t, dirty } : t)) : ts));
  }, []);

  /** Apply a change to a tab whether or not it's the one shown. */
  const updateTab = useCallback((id: string, spec: TransactionSpec) => {
    const view = viewRef.current;
    if (id === shown.current && view) {
      view.dispatch(spec);
      return;
    }
    const state = states.current.get(id);
    if (!state) return;
    const next = state.update(spec).state;
    states.current.set(id, next);
    syncDirty(id, next);
  }, [syncDirty]);

  const applyReveal = useCallback((id: string) => {
    const view = viewRef.current;
    const at = reveals.current.get(id);
    if (!view || id !== shown.current || !at) return;
    reveals.current.delete(id);
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(1, at.line), doc.lines));
    const from = Math.min(line.from + at.column - 1, line.to);
    const to = Math.min(from + (at.length ?? 0), doc.length);
    view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    view.focus();
  }, []);

  const handleUpdate = useCallback((update: ViewUpdate) => {
    const id = shown.current;
    if (!id) return;
    if (update.docChanged) syncDirty(id, update.state);
    if (update.docChanged || update.selectionSet) caretStore.set(update.state);
  }, [syncDirty, caretStore]);
  const handleUpdateRef = useRef(handleUpdate);
  useLayoutEffect(() => {
    handleUpdateRef.current = handleUpdate;
  }, [handleUpdate]);
  const listenerRef = useRef<Extension | null>(null);

  const makeState = useCallback((doc: string) => {
    listenerRef.current ??= EditorView.updateListener.of((u) => handleUpdateRef.current(u));
    return createEditorState(doc, prefsRef.current, listenerRef.current);
  }, []);

  // One view for the window; tabs swap their states in and out of it.
  useLayoutEffect(() => {
    const view = new EditorView({ parent: hostRef.current!, state: makeState('') });
    viewRef.current = view;
    const tabStates = states.current;
    return () => {
      // The tab it showed keeps its state for the next view to show.
      if (shown.current) tabStates.set(shown.current, view.state);
      shown.current = null;
      view.destroy();
      viewRef.current = null;
    };
  }, [makeState]);

  /** Put the active tab's state in the view (after a switch, or once it loads). */
  const showActive = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const prev = shown.current;
    const next = activeId && states.current.has(activeId) ? activeId : null;
    if (prev === next && next !== null) return;
    if (prev && tabsRef.current.some((t) => t.id === prev) && prev !== next) {
      states.current.set(prev, view.state);
      scrolls.current.set(prev, view.scrollSnapshot());
    }
    shown.current = next;
    view.setState(next ? states.current.get(next)! : makeState(''));
    view.dispatch({ effects: prefEffects(prefsRef.current) });
    caretStore.set(view.state);
    if (!next) return;
    const scroll = scrolls.current.get(next);
    if (scroll) view.dispatch({ effects: scroll });
    if (reveals.current.has(next)) applyReveal(next);
    else view.focus();
  }, [activeId, makeState, caretStore, applyReveal]);

  // While shown, the view owns the state; the map's copy goes stale.
  const [loadedIds, setLoadedIds] = useState(0);
  useLayoutEffect(showActive, [showActive, loadedIds]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: prefEffects(prefs) });
  }, [prefs]);

  const setLanguage = useCallback((id: string, name: string | null) => {
    const desc = name ? languages.find((l) => l.name === name) : null;
    patchTab(id, { language: desc?.name ?? null });
    if (!desc) {
      updateTab(id, { effects: languageConf.reconfigure([]) });
      return;
    }
    desc.load().then(
      (support) => updateTab(id, { effects: languageConf.reconfigure(support) }),
      () => {},
    );
  }, [patchTab, updateTab]);

  const detectLanguage = useCallback((id: string, path: string | null, text: string) => {
    const desc = (path ? languageFor(path) : null) ?? languageForShebang(text.slice(0, text.indexOf('\n') >>> 0));
    setLanguage(id, desc?.name ?? null);
  }, [setLanguage]);

  // -------------------------------------------------------------------------
  // Opening, saving, closing.
  // -------------------------------------------------------------------------

  const newTabId = () => `tab-${nextId.current++}`;

  const addTab = useCallback((tab: Tab, replace?: string) => {
    setTabs((ts) => {
      if (replace) return ts.map((t) => (t.id === replace ? tab : t));
      const at = ts.findIndex((t) => t.id === activeId);
      return at === -1 ? [...ts, tab] : [...ts.slice(0, at + 1), tab, ...ts.slice(at + 1)];
    });
    setActiveId(tab.id);
  }, [activeId]);

  const newFile = useCallback(() => {
    const id = newTabId();
    states.current.set(id, makeState(''));
    saved.current.set(id, Text.empty);
    addTab({ id, path: null, untitled: nextUntitled.current++, dirty: false, loading: false, error: null, language: null, indent: '    ' });
    setLoadedIds((n) => n + 1);
  }, [addTab, makeState]);

  const openPath = useCallback(async (path: string, at?: Reveal) => {
    if (!fs) return;
    const existing = tabsRef.current.find((t) => t.path === path);
    if (existing) {
      if (at) reveals.current.set(existing.id, at);
      if (existing.id === activeId && existing.id === shown.current) {
        if (at) applyReveal(existing.id);
        else viewRef.current?.focus();
      }
      setActiveId(existing.id);
      return;
    }
    // A new untouched document gives way to the file, as in VS Code.
    const current = tabsRef.current.find((t) => t.id === activeId);
    const pristine = current && current.path === null && !current.dirty && stateOf(current.id)?.doc.length === 0 ? current.id : undefined;
    const id = newTabId();
    if (at) reveals.current.set(id, at);
    addTab({ id, path, untitled: 0, dirty: false, loading: true, error: null, language: null, indent: '    ' }, pristine);
    if (pristine) {
      states.current.delete(pristine);
      saved.current.delete(pristine);
    }
    const [result, stat] = await Promise.all([readText(fs, path), fs.stat(path).catch(() => null)]);
    // Closed while loading.
    if (!tabsRef.current.some((t) => t.id === id)) return;
    if ('error' in result) {
      patchTab(id, { loading: false, error: result.error });
      return;
    }
    const state = makeState(result.text);
    states.current.set(id, state);
    saved.current.set(id, state.doc);
    if (stat) mtimes.current.set(id, stat.mtimeMs);
    patchTab(id, { loading: false, indent: state.facet(indentUnit) });
    detectLanguage(id, path, result.text);
    setLoadedIds((n) => n + 1);
  }, [fs, activeId, addTab, patchTab, makeState, detectLanguage, applyReveal, stateOf]);

  const openFileDialog = useCallback(async () => {
    const result = await pickFiles({
      title: 'Open',
      multiple: true,
      initialPath: activeTab?.path ? parentPath(activeTab.path) : folder ?? undefined,
    });
    for (const path of result?.paths ?? []) await openPath(path);
  }, [pickFiles, activeTab, folder, openPath]);

  const openFolder = useCallback((path: string) => {
    setFolder(path);
    setExpanded(new Set());
    setSidebarOpen(true);
    setSidebarView('explorer');
    setSearch(initialSearch);
  }, []);

  const openFolderDialog = useCallback(async () => {
    const result = await pickFiles({
      title: 'Open Folder',
      directory: true,
      confirmLabel: 'Open',
      initialPath: folder ? parentPath(folder) : undefined,
    });
    if (result) openFolder(result.paths[0]);
  }, [pickFiles, folder, openFolder]);

  const saveTab = useCallback(async (id: string, as = false): Promise<boolean> => {
    const tab = tabsRef.current.find((t) => t.id === id);
    const state = stateOf(id);
    if (!fs || !tab || !state || tab.loading) return false;
    let target = tab.path;
    if (as || !target || tab.error) {
      const result = await pickFiles({
        mode: 'save',
        title: 'Save As',
        currentName: tab.path ? basename(tab.path) : `Untitled-${tab.untitled}.txt`,
        initialPath: tab.path ? parentPath(tab.path) : folder ?? undefined,
      });
      if (!result) return false;
      target = result.paths[0];
    }
    const doc = stateOf(id)!.doc;
    setSaving(true);
    setStatus(null);
    try {
      await fs.writeFile(target, doc.toString());
      saved.current.set(id, doc);
      const stat = await fs.stat(target).catch(() => null);
      if (stat) mtimes.current.set(id, stat.mtimeMs);
      const now = stateOf(id);
      patchTab(id, { path: target, error: null, dirty: now ? !now.doc.eq(doc) : false });
      if (target !== tab.path) detectLanguage(id, target, doc.sliceString(0, 200));
      setStatus(`Saved ${basename(target)}`);
      void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile', target] });
      void invalidateListings(queryClient, target);
      return true;
    } catch (error) {
      setStatus(`Couldn’t save ${basename(target)}: ${cleanFsError(error)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [fs, pickFiles, folder, stateOf, patchTab, detectLanguage, queryClient]);

  const saveAll = useCallback(async (): Promise<boolean> => {
    for (const tab of tabsRef.current.filter((t) => t.dirty)) {
      if (!(await saveTab(tab.id))) return false;
    }
    return true;
  }, [saveTab]);

  const closeTabNow = useCallback((id: string) => {
    const ts = tabsRef.current;
    const index = ts.findIndex((t) => t.id === id);
    if (index === -1) return;
    const rest = ts.filter((t) => t.id !== id);
    states.current.delete(id);
    saved.current.delete(id);
    mtimes.current.delete(id);
    scrolls.current.delete(id);
    reveals.current.delete(id);
    if (shown.current === id) shown.current = null;
    // Closing several at once each sees the ones before gone.
    tabsRef.current = rest;
    setTabs(rest);
    setActiveId((current) => (current === id ? (rest[Math.min(index, rest.length - 1)]?.id ?? null) : current));
  }, []);

  const requestCloseTab = useCallback((id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    if (tab.dirty) {
      setActiveId(id);
      setAsking({ kind: 'tab', id });
    } else {
      closeTabNow(id);
    }
  }, [closeTabNow]);

  const anyDirty = tabs.some((t) => t.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    setCloseGuard(windowId, () => {
      focus(windowId);
      setAsking({ kind: 'window' });
      return true;
    });
    return () => setCloseGuard(windowId, null);
  }, [anyDirty, windowId, focus]);

  const closeWindowNow = useCallback(() => {
    setCloseGuard(windowId, null);
    setAsking(null);
    close(windowId);
  }, [windowId, close]);

  const launched = useRef(false);
  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    void (async () => {
      for (const path of launch.files) await openPath(path);
    })();
  }, [launch, openPath]);

  // Remember the folder's session for next time (single files aren't a session).
  useEffect(() => {
    if (!folder) return;
    const workspace: Workspace = {
      folder,
      files: tabs.flatMap((t) => (t.path && !t.error ? [t.path] : [])),
      active: activeTab?.path ?? null,
      expanded: [...expanded].filter((d) => d.startsWith(`${folder}/`)),
    };
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
  }, [folder, tabs, activeTab, expanded]);

  // -------------------------------------------------------------------------
  // Files changed on disk.
  // -------------------------------------------------------------------------

  const checkDisk = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!fs || !tab?.path || tab.loading || tab.error) return;
    const path = tab.path;
    const stat = await fs.stat(path).catch(() => null);
    if (!stat || stat.mtimeMs === mtimes.current.get(id)) return;
    mtimes.current.set(id, stat.mtimeMs);
    const result = await readText(fs, path);
    const state = stateOf(id);
    if ('error' in result || !state) return;
    const current = state.doc.toString();
    if (current === result.text) {
      saved.current.set(id, state.doc);
      syncDirty(id, state);
      return;
    }
    if (tabsRef.current.find((t) => t.id === id)?.dirty) {
      setStatus(`${basename(path)} changed on disk. Saving will overwrite those changes.`);
      return;
    }
    updateTab(id, { changes: minimalChange(current, result.text) });
    const next = stateOf(id);
    if (next) {
      saved.current.set(id, next.doc);
      syncDirty(id, next);
    }
  }, [fs, stateOf, syncDirty, updateTab]);

  const watchedDirs = useMemo(
    () => [...new Set(tabs.flatMap((t) => (t.path && !t.loading ? [parentPath(t.path)] : [])))].sort().join('\0'),
    [tabs],
  );
  useEffect(() => {
    if (!fs || !watchedDirs) return;
    const dirs = watchedDirs.split('\0');
    const ids: number[] = [];
    let cancelled = false;
    for (const dir of dirs) {
      void fs.watch(dir).then((id) => {
        if (id === null) return;
        if (cancelled) void fs.unwatch(id);
        else ids.push(id);
      }, () => {});
    }
    const off = fs.onChange((dir) => {
      if (!dirs.includes(dir)) return;
      for (const tab of tabsRef.current) {
        if (tab.path && parentPath(tab.path) === dir) void checkDisk(tab.id);
      }
    });
    return () => {
      cancelled = true;
      off();
      for (const id of ids) void fs.unwatch(id);
    };
  }, [fs, watchedDirs, checkDisk]);

  // -------------------------------------------------------------------------
  // The folder: its files for quick open, search and replace across it.
  // -------------------------------------------------------------------------

  const projectFiles = useQuery({
    queryKey: ['fs', 'listFiles', folder],
    queryFn: () => fs!.listFiles(folder!),
    enabled: !!fs && !!folder,
    staleTime: 15_000,
  });

  // The list is fetched again each time quick open opens, so new files show up.
  const quickOpen = palette?.kind === 'quick';
  useEffect(() => {
    if (quickOpen && folder) void queryClient.invalidateQueries({ queryKey: ['fs', 'listFiles', folder] });
  }, [quickOpen, folder, queryClient]);

  const paletteFiles = useMemo((): PaletteFile[] => {
    const open = tabs.flatMap((t) => (t.path ? [t.path] : []));
    const label = (path: string) => (folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path);
    const seen = new Set(open);
    const rest = folder ? (projectFiles.data?.files ?? []).map((rel) => `${folder}/${rel}`).filter((p) => !seen.has(p)) : [];
    return [...open, ...rest].map((path) => ({ path, label: label(path) }));
  }, [tabs, folder, projectFiles.data]);

  const replaceInFiles = useCallback(async (result: FsSearchResult, options: FsSearchOptions, replacement: string) => {
    if (!fs || !folder) return;
    const pattern = searchRegExp(options);
    // A literal replacement is taken as is; a regex one may say $1.
    const replaceText = (text: string) =>
      options.regex ? text.replace(pattern, replacement) : text.replace(pattern, () => replacement);
    let files = 0;
    const failed: string[] = [];
    for (const file of result.files) {
      const path = `${folder}/${file.path}`;
      const tab = tabsRef.current.find((t) => t.path === path);
      const state = tab ? stateOf(tab.id) : undefined;
      try {
        if (tab && state) {
          const before = state.doc.toString();
          const after = replaceText(before);
          if (after !== before) updateTab(tab.id, { changes: minimalChange(before, after), userEvent: 'input.replace.all' });
        } else {
          const read = await readText(fs, path);
          if ('error' in read) throw new Error(read.error);
          const after = replaceText(read.text);
          if (after !== read.text) await fs.writeFile(path, after);
        }
        files++;
      } catch {
        failed.push(file.path);
      }
    }
    setStatus(
      failed.length
        ? `Replaced in ${files} file${files === 1 ? '' : 's'}; couldn’t change ${failed.join(', ')}`
        : `Replaced in ${files} file${files === 1 ? '' : 's'}`,
    );
    void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile'] });
  }, [fs, folder, stateOf, updateTab, queryClient]);

  const toggleDir = useCallback((dir: string, wanted?: boolean) => {
    setExpanded((set) => {
      const isOpen = set.has(dir);
      const want = wanted ?? !isOpen;
      if (want === isOpen) return set;
      const next = new Set(set);
      if (want) next.add(dir);
      else next.delete(dir);
      return next;
    });
  }, []);

  const treeActions = useMemo((): FileTreeActions => ({
    open: (path) => void openPath(path),
    renamed: (from, to) => {
      setTabs((ts) => ts.map((t) => {
        if (!t.path || (t.path !== from && !t.path.startsWith(`${from}/`))) return t;
        return { ...t, path: to + t.path.slice(from.length) };
      }));
      setExpanded((set) => new Set([...set].map((d) => (d === from || d.startsWith(`${from}/`) ? to + d.slice(from.length) : d))));
    },
    removed: (path) => {
      // Tabs stay open (their text isn't lost) but are now unsaved.
      for (const t of tabsRef.current) {
        if (t.path === path || t.path?.startsWith(`${path}/`)) {
          saved.current.set(t.id, Text.empty);
          mtimes.current.delete(t.id);
          const state = stateOf(t.id);
          if (state) syncDirty(t.id, state);
        }
      }
    },
    revealInFiles: (path) => open('file-browser', { path: parentPath(path), select: basename(path) }),
    openTerminal: (dir) => open('terminal', { cwd: dir }),
    copyText: (text) => void navigator.clipboard?.writeText(text).catch(() => {}),
    status: setStatus,
  }), [openPath, open, stateOf, syncDirty]);

  // -------------------------------------------------------------------------
  // Commands.
  // -------------------------------------------------------------------------

  const zoom = useCallback((step: number) => {
    setFontSize((size) => {
      if (step === 0) return DEFAULT_FONT_SIZE;
      const i = FONT_SIZES.indexOf(size);
      return FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, i + step))];
    });
  }, []);

  const cycleTab = useCallback((step: number) => {
    const ts = tabsRef.current;
    if (ts.length < 2) return;
    const i = ts.findIndex((t) => t.id === activeId);
    setActiveId(ts[(i + step + ts.length) % ts.length].id);
  }, [activeId]);

  const showSearch = useCallback(() => {
    setSidebarOpen(true);
    setSidebarView('search');
    const view = viewRef.current;
    const sel = view?.state.selection.main;
    if (view && sel && !sel.empty) {
      const text = view.state.sliceDoc(sel.from, sel.to);
      if (!text.includes('\n')) setSearch((s) => ({ ...s, query: text }));
    }
    setSearchFocus((n) => n + 1);
  }, []);

  /** Run a CodeMirror command on the shown file. */
  const exec = useCallback((command: (view: EditorView) => boolean) => {
    const view = viewRef.current;
    if (!view || !shown.current) return;
    command(view);
    view.focus();
  }, []);

  const transformCase = useCallback((upper: boolean) => exec((view) => {
    view.dispatch(view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      return { changes: { from: range.from, to: range.to, insert: upper ? text.toUpperCase() : text.toLowerCase() }, range };
    }));
    return true;
  }), [exec]);

  const sortLines = useCallback(() => exec((view) => {
    const { state } = view;
    const main = state.selection.main;
    const first = state.doc.lineAt(main.from);
    const last = state.doc.lineAt(main.empty ? state.doc.length : main.to);
    const lines = state.sliceDoc(first.from, last.to).split('\n');
    const sorted = [...lines].sort((a, b) => a.localeCompare(b));
    view.dispatch({ changes: { from: first.from, to: last.to, insert: sorted.join('\n') } });
    return true;
  }), [exec]);

  const revert = useCallback(async () => {
    const tab = activeTab;
    if (!fs || !tab?.path) return;
    const result = await readText(fs, tab.path);
    const state = stateOf(tab.id);
    if ('error' in result || !state) return;
    updateTab(tab.id, { changes: minimalChange(state.doc.toString(), result.text) });
    const next = stateOf(tab.id)!;
    saved.current.set(tab.id, next.doc);
    syncDirty(tab.id, next);
  }, [fs, activeTab, stateOf, updateTab, syncDirty]);

  const pickLanguage = useCallback(() => {
    if (!activeTab) return;
    const id = activeTab.id;
    setPalette({
      kind: 'pick',
      placeholder: 'Select a language',
      currentId: activeTab.language ?? 'Plain Text',
      items: [{ id: 'Plain Text', label: 'Plain Text' }, ...languages.map((l) => ({ id: l.name, label: l.name, detail: l.extensions.slice(0, 3).map((e) => `.${e}`).join(' ') }))],
      onPick: (name) => setLanguage(id, name === 'Plain Text' ? null : name),
    });
  }, [activeTab, setLanguage]);

  const pickIndent = useCallback(() => {
    if (!activeTab) return;
    const id = activeTab.id;
    const options = ['\t', '  ', '    ', '        '];
    setPalette({
      kind: 'pick',
      placeholder: 'Indent using',
      currentId: activeTab.indent,
      items: options.map((unit) => ({ id: unit, label: unit === '\t' ? 'Tabs' : `${unit.length} Spaces` })),
      onPick: (unit) => {
        updateTab(id, { effects: indentConf.reconfigure(indentUnit.of(unit)) });
        patchTab(id, { indent: unit });
      },
    });
  }, [activeTab, updateTab, patchTab]);

  const commands = useMemo((): PaletteCommand[] => {
    const path = activeTab?.path;
    return [
      { id: 'file.new', title: 'File: New File', shortcut: 'Ctrl+N', run: newFile },
      { id: 'file.newWindow', title: 'File: New Window', shortcut: 'Ctrl+Shift+N', run: () => open('text-editor', { blank: true }) },
      { id: 'file.open', title: 'File: Open File…', shortcut: 'Ctrl+O', run: () => void openFileDialog() },
      { id: 'file.openFolder', title: 'File: Open Folder…', shortcut: 'Ctrl+K Ctrl+O', run: () => void openFolderDialog() },
      { id: 'file.save', title: 'File: Save', shortcut: 'Ctrl+S', run: () => activeId && void saveTab(activeId) },
      { id: 'file.saveAs', title: 'File: Save As…', shortcut: 'Ctrl+Shift+S', run: () => activeId && void saveTab(activeId, true) },
      { id: 'file.saveAll', title: 'File: Save All', shortcut: 'Ctrl+K S', run: () => void saveAll() },
      { id: 'file.revert', title: 'File: Revert File', run: () => void revert() },
      { id: 'file.close', title: 'View: Close Editor', shortcut: 'Ctrl+W', run: () => activeId && requestCloseTab(activeId) },
      { id: 'file.closeSaved', title: 'View: Close Saved Editors', run: () => tabsRef.current.filter((t) => !t.dirty).forEach((t) => closeTabNow(t.id)) },
      { id: 'window.close', title: 'View: Close Window', shortcut: 'Ctrl+Shift+W', run: () => close(windowId) },
      { id: 'go.file', title: 'Go to File…', shortcut: 'Ctrl+P', run: () => setPalette({ kind: 'quick', initial: '' }) },
      { id: 'go.line', title: 'Go to Line…', shortcut: 'Ctrl+G', run: () => setPalette({ kind: 'quick', initial: ':' }) },
      { id: 'go.nextTab', title: 'View: Open Next Editor', shortcut: 'Ctrl+PageDown', run: () => cycleTab(1) },
      { id: 'go.prevTab', title: 'View: Open Previous Editor', shortcut: 'Ctrl+PageUp', run: () => cycleTab(-1) },
      { id: 'go.bracket', title: 'Go to Bracket', shortcut: 'Ctrl+Shift+\\', run: () => exec(cursorMatchingBracket) },
      { id: 'find.find', title: 'Find', shortcut: 'Ctrl+F', run: () => exec((v) => (openFind(v, false), true)) },
      { id: 'find.replace', title: 'Replace', shortcut: 'Ctrl+H', run: () => exec((v) => (openFind(v, true), true)) },
      { id: 'find.inFiles', title: 'Search: Find in Files', shortcut: 'Ctrl+Shift+F', run: showSearch },
      { id: 'find.replaceInFiles', title: 'Search: Replace in Files', shortcut: 'Ctrl+Shift+H', run: () => { setSearch((s) => ({ ...s, showReplace: true })); showSearch(); } },
      { id: 'view.explorer', title: 'View: Show Explorer', shortcut: 'Ctrl+Shift+E', run: () => { setSidebarOpen(true); setSidebarView('explorer'); } },
      { id: 'view.sidebar', title: 'View: Toggle Sidebar', shortcut: 'Ctrl+B', run: () => setSidebarOpen((o) => !o) },
      { id: 'view.wrap', title: 'View: Toggle Word Wrap', shortcut: 'Alt+Z', run: () => setWrap((w) => !w) },
      { id: 'view.minimap', title: 'View: Toggle Minimap', run: () => setMinimap((m) => !m) },
      { id: 'view.zoomIn', title: 'View: Zoom In', shortcut: 'Ctrl+=', run: () => zoom(1) },
      { id: 'view.zoomOut', title: 'View: Zoom Out', shortcut: 'Ctrl+-', run: () => zoom(-1) },
      { id: 'view.zoomReset', title: 'View: Reset Zoom', shortcut: 'Ctrl+0', run: () => zoom(0) },
      { id: 'editor.language', title: 'Change Language Mode', run: pickLanguage },
      { id: 'editor.indent', title: 'Change Indentation', run: pickIndent },
      { id: 'editor.comment', title: 'Toggle Line Comment', shortcut: 'Ctrl+/', run: () => exec(toggleComment) },
      { id: 'editor.blockComment', title: 'Toggle Block Comment', shortcut: 'Shift+Alt+A', run: () => exec(toggleBlockComment) },
      { id: 'editor.fold', title: 'Fold', shortcut: 'Ctrl+Shift+[', run: () => exec(foldCode) },
      { id: 'editor.unfold', title: 'Unfold', shortcut: 'Ctrl+Shift+]', run: () => exec(unfoldCode) },
      { id: 'editor.foldAll', title: 'Fold All', shortcut: 'Ctrl+Alt+[', run: () => exec(foldAll) },
      { id: 'editor.unfoldAll', title: 'Unfold All', shortcut: 'Ctrl+Alt+]', run: () => exec(unfoldAll) },
      { id: 'editor.moveUp', title: 'Move Line Up', shortcut: 'Alt+Up', run: () => exec(moveLineUp) },
      { id: 'editor.moveDown', title: 'Move Line Down', shortcut: 'Alt+Down', run: () => exec(moveLineDown) },
      { id: 'editor.copyDown', title: 'Duplicate Line', shortcut: 'Shift+Alt+Down', run: () => exec(copyLineDown) },
      { id: 'editor.deleteLine', title: 'Delete Line', shortcut: 'Ctrl+Shift+K', run: () => exec(deleteLine) },
      { id: 'editor.cursorAbove', title: 'Add Cursor Above', shortcut: 'Ctrl+Alt+Up', run: () => exec(addCursorAbove) },
      { id: 'editor.cursorBelow', title: 'Add Cursor Below', shortcut: 'Ctrl+Alt+Down', run: () => exec(addCursorBelow) },
      { id: 'editor.nextOccurrence', title: 'Add Selection to Next Find Match', shortcut: 'Ctrl+D', run: () => exec(selectNextOccurrence) },
      { id: 'editor.allOccurrences', title: 'Select All Occurrences of Find Match', shortcut: 'Ctrl+Shift+L', run: () => exec(selectSelectionMatches) },
      { id: 'editor.selectAll', title: 'Select All', shortcut: 'Ctrl+A', run: () => exec(selectAll) },
      { id: 'editor.trim', title: 'Trim Trailing Whitespace', run: () => exec(deleteTrailingWhitespace) },
      { id: 'editor.sort', title: 'Sort Lines Ascending', run: sortLines },
      { id: 'editor.upper', title: 'Transform to Uppercase', run: () => transformCase(true) },
      { id: 'editor.lower', title: 'Transform to Lowercase', run: () => transformCase(false) },
      ...(folder ? [
        { id: 'folder.close', title: 'File: Close Folder', run: () => { setFolder(null); localStorage.removeItem(WORKSPACE_KEY); } },
        { id: 'folder.refresh', title: 'Explorer: Refresh', run: () => void invalidateListings(queryClient, folder) },
        { id: 'folder.terminal', title: 'Open Folder in Terminal', run: () => open('terminal', { cwd: folder }) },
        { id: 'folder.files', title: 'Reveal Folder in Files', run: () => open('file-browser', { path: folder }) },
      ] : []),
      ...(path ? [
        { id: 'file.reveal', title: 'Reveal Active File in Files', run: () => open('file-browser', { path: parentPath(path), select: basename(path) }) },
        { id: 'file.copyPath', title: 'Copy Path of Active File', run: () => void navigator.clipboard?.writeText(path).catch(() => {}) },
        { id: 'file.terminal', title: 'Open Containing Folder in Terminal', run: () => open('terminal', { cwd: parentPath(path) }) },
      ] : []),
    ];
  }, [
    newFile, open, openFileDialog, openFolderDialog, activeId, saveTab, saveAll, revert, requestCloseTab, closeTabNow,
    close, windowId, cycleTab, exec, showSearch, zoom, pickLanguage, pickIndent, sortLines, transformCase, folder,
    queryClient, activeTab,
  ]);

  const run = useCallback((id: string) => commands.find((c) => c.id === id)?.run(), [commands]);

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (asking) return;
    const key = e.key.toLowerCase();
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    const shift = e.shiftKey;
    // The second key of a Ctrl+K chord.
    if (chord.current) {
      if (['control', 'meta', 'shift', 'alt'].includes(key)) return;
      chord.current = false;
      if (ctrl && key === 'o') run('file.openFolder');
      else if (!e.ctrlKey && key === 's') run('file.saveAll');
      else if (ctrl && key === 'w') tabsRef.current.forEach((t) => requestCloseTab(t.id));
      setStatus(null);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    let handled = true;
    if (ctrl && !shift && key === 'k') {
      chord.current = true;
      setStatus('(Ctrl+K) was pressed. Waiting for the second key of the chord…');
    } else if (ctrl && !shift && key === 's') run('file.save');
    else if (ctrl && shift && key === 's') run('file.saveAs');
    else if (ctrl && !shift && key === 'o') run('file.open');
    else if (ctrl && !shift && key === 'n') run('file.new');
    else if (ctrl && shift && key === 'n') run('file.newWindow');
    else if (ctrl && !shift && key === 'w') {
      if (activeId) requestCloseTab(activeId);
      else close(windowId);
    } else if (ctrl && shift && key === 'w') close(windowId);
    else if (ctrl && !shift && key === 'p') setPalette({ kind: 'quick', initial: '' });
    else if ((ctrl && shift && key === 'p') || e.key === 'F1') setPalette({ kind: 'quick', initial: '>' });
    else if (ctrl && !shift && key === 'g') setPalette({ kind: 'quick', initial: ':' });
    else if (ctrl && !shift && key === 'f' && shown.current) run('find.find');
    else if (ctrl && !shift && key === 'h' && shown.current) run('find.replace');
    else if (ctrl && shift && key === 'f') run('find.inFiles');
    else if (ctrl && shift && key === 'h') run('find.replaceInFiles');
    else if (ctrl && shift && key === 'e') run('view.explorer');
    else if (ctrl && !shift && key === 'b') run('view.sidebar');
    else if (e.ctrlKey && !e.altKey && e.key === 'Tab') cycleTab(shift ? -1 : 1);
    else if (e.ctrlKey && !e.altKey && !shift && e.key === 'PageDown') cycleTab(1);
    else if (e.ctrlKey && !e.altKey && !shift && e.key === 'PageUp') cycleTab(-1);
    else if (ctrl && (key === '=' || key === '+')) zoom(1);
    else if (ctrl && key === '-') zoom(-1);
    else if (ctrl && key === '0') zoom(0);
    else if (e.altKey && !e.ctrlKey && !e.metaKey && !shift && key === 'z') setWrap((w) => !w);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // -------------------------------------------------------------------------
  // Tabs in the title bar.
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (tabs.length === 0) {
      setTitlebar(null);
      return;
    }
    // Two files of one name say which folder each is in.
    const counts = new Map<string, number>();
    for (const t of tabs) counts.set(tabName(t), (counts.get(tabName(t)) ?? 0) + 1);
    setTitlebar(
      <TabStrip
        tabs={tabs.map((t) => {
          const name = tabName(t);
          const parent = t.path && (counts.get(name) ?? 0) > 1 ? ` — ${basename(parentPath(t.path))}` : '';
          return {
            id: t.id,
            title: `${t.dirty ? '• ' : ''}${name}${parent}`,
            icon: <FileIcon path="" name={name} kind="file" size={null} mtimeMs={null} px={14} thumbnail={false} />,
          };
        })}
        activeId={activeId ?? ''}
        label="Open files"
        newTabLabel="New file (Ctrl+N)"
        onActivate={setActiveId}
        onClose={requestCloseTab}
        onNew={newFile}
        newTabMenuLabel="New file"
        tabMenuItems={(id) => {
          const path = tabs.find((t) => t.id === id)?.path;
          if (!path) return null;
          return (
            <>
              <ContextMenuItem onSelect={() => treeActions.revealInFiles(path)}>Reveal in Files</ContextMenuItem>
              <ContextMenuItem onSelect={() => treeActions.openTerminal(parentPath(path))}>Open in Terminal</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => treeActions.copyText(path)}>Copy Path</ContextMenuItem>
              {folder && path.startsWith(`${folder}/`) && (
                <ContextMenuItem onSelect={() => treeActions.copyText(path.slice(folder.length + 1))}>
                  Copy Relative Path
                </ContextMenuItem>
              )}
            </>
          );
        }}
        onMove={(id, to) =>
          setTabs((ts) => {
            const from = ts.findIndex((t) => t.id === id);
            if (from === -1) return ts;
            const next = [...ts];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
          })
        }
      />,
    );
  }, [tabs, activeId, setTitlebar, requestCloseTab, newFile, treeActions, folder]);
  useEffect(() => () => setTitlebar(null), [setTitlebar]);

  // -------------------------------------------------------------------------
  // Sidebar resizing.
  // -------------------------------------------------------------------------

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      setSidebarWidth(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startWidth + ev.clientX - startX)));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  if (!fs) {
    return (
      <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        The Text Editor needs the Electron shell to read and save files.
      </p>
    );
  }

  const askingTab = asking?.kind === 'tab' ? tabs.find((t) => t.id === asking.id) : undefined;
  const dirtyCount = tabs.filter((t) => t.dirty).length;
  const editorReady = !!activeTab && !activeTab.loading && !activeTab.error;
  const relative = activeTab?.path && folder && activeTab.path.startsWith(`${folder}/`)
    ? activeTab.path.slice(folder.length + 1)
    : activeTab?.path ?? null;

  return (
    <div className="relative flex h-full w-full flex-col" onKeyDownCapture={onKeyDownCapture}>
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <>
            <aside
              className="flex shrink-0 flex-col border-r border-border/60 bg-foreground/[0.02]"
              style={{ width: sidebarWidth }}
              aria-label={sidebarView === 'explorer' ? 'Explorer' : 'Search'}
            >
              <div className="flex h-10 shrink-0 items-center gap-0.5 px-2">
                <SidebarTab active={sidebarView === 'explorer'} onClick={() => setSidebarView('explorer')} label="Explorer (Ctrl+Shift+E)">
                  <Files className="size-4" />
                </SidebarTab>
                <SidebarTab active={sidebarView === 'search'} onClick={showSearch} label="Search (Ctrl+Shift+F)">
                  <Search className="size-4" />
                </SidebarTab>
                <span
                  className="ml-2 min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  title={folder ?? undefined}
                >
                  {sidebarView === 'search' ? 'Search' : folder ? basename(folder) || folder : 'Explorer'}
                </span>
                {sidebarView === 'explorer' && folder && (
                  <>
                    <IconButton label="New File…" small onClick={() => setTreeRequest((r) => ({ kind: 'file', token: (r?.token ?? 0) + 1 }))}>
                      <FilePlus className="size-4" />
                    </IconButton>
                    <IconButton label="New Folder…" small onClick={() => setTreeRequest((r) => ({ kind: 'folder', token: (r?.token ?? 0) + 1 }))}>
                      <FolderPlus className="size-4" />
                    </IconButton>
                    <IconButton label="Refresh" small onClick={() => void invalidateListings(queryClient, folder)}>
                      <RefreshCw className="size-4" />
                    </IconButton>
                    <IconButton label="Collapse Folders" small onClick={() => setExpanded(new Set())}>
                      <ListCollapse className="size-4" />
                    </IconButton>
                  </>
                )}
              </div>
              {!folder ? (
                <div className="space-y-3 px-4 py-2 text-sm text-muted-foreground">
                  <p>{sidebarView === 'search' ? 'Open a folder to search the files in it.' : 'You haven’t opened a folder.'}</p>
                  <DialogButton variant="primary" onClick={() => void openFolderDialog()}>
                    Open Folder…
                  </DialogButton>
                </div>
              ) : sidebarView === 'explorer' ? (
                <FileTree
                  key={folder}
                  root={folder}
                  expanded={expanded}
                  onToggle={toggleDir}
                  activePath={activeTab?.path ?? null}
                  actions={treeActions}
                  request={treeRequest}
                />
              ) : (
                <SearchView
                  key={folder}
                  root={folder}
                  state={search}
                  onChange={setSearch}
                  focusToken={searchFocus}
                  onOpenMatch={(path, line, column, length) => void openPath(path, { line, column, length })}
                  onReplaceAll={replaceInFiles}
                />
              )}
            </aside>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              aria-valuenow={sidebarWidth}
              aria-valuemin={MIN_SIDEBAR}
              aria-valuemax={MAX_SIDEBAR}
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setSidebarWidth((w) => Math.max(MIN_SIDEBAR, w - 16));
                else if (e.key === 'ArrowRight') setSidebarWidth((w) => Math.min(MAX_SIDEBAR, w + 16));
              }}
              className="-ml-1 w-1 shrink-0 cursor-col-resize hover:bg-sidebar-ring/40 focus-visible:bg-sidebar-ring/60 focus-visible:outline-none"
            />
          </>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
            <IconButton label="Toggle Sidebar (Ctrl+B)" small pressed={sidebarOpen} onClick={() => setSidebarOpen((o) => !o)}>
              <PanelLeft className="size-4" />
            </IconButton>
            <nav aria-label="Path" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden px-1 text-sm text-muted-foreground">
              {relative?.split('/').map((part, i, parts) => (
                <span key={i} className={cn('flex shrink items-center gap-1 truncate', i === parts.length - 1 && 'shrink-0 text-foreground')}>
                  {i > 0 && <span aria-hidden className="text-muted-foreground/60">›</span>}
                  {part}
                </span>
              ))}
            </nav>
            <IconButton label="Open Folder… (Ctrl+K Ctrl+O)" small onClick={() => void openFolderDialog()}>
              <FolderOpen className="size-4" />
            </IconButton>
            <IconButton label="Save (Ctrl+S)" small disabled={!activeTab || activeTab.loading || saving} onClick={() => run('file.save')}>
              <Save className="size-4" />
            </IconButton>
            <IconButton label="Find and Replace (Ctrl+F)" small disabled={!editorReady} onClick={() => run('find.find')}>
              <Search className="size-4" />
            </IconButton>
            <IconButton label="Word Wrap (Alt+Z)" small pressed={wrap} onClick={() => setWrap((w) => !w)}>
              <WrapText className="size-4" />
            </IconButton>
            <IconButton label="Minimap" small pressed={minimap} onClick={() => setMinimap((m) => !m)}>
              <MapIcon className="size-4" />
            </IconButton>
            <IconButton label="Command Palette (Ctrl+Shift+P)" small onClick={() => setPalette({ kind: 'quick', initial: '>' })}>
              <Command className="size-4" />
            </IconButton>
          </div>

          <div className="relative min-h-0 flex-1">
            <div
              ref={hostRef}
              className={cn('absolute inset-0', !editorReady && 'invisible')}
              aria-label={activeTab ? `Contents of ${tabName(activeTab)}` : undefined}
            />
            {activeTab?.loading && (
              <div className="absolute inset-0 space-y-2 p-4" aria-hidden>
                <Skeleton className="h-4 w-3/4 bg-foreground/10" />
                <Skeleton className="h-4 w-full bg-foreground/10" />
                <Skeleton className="h-4 w-2/3 bg-foreground/10" />
              </div>
            )}
            {activeTab?.error && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center">
                <div className="max-w-sm space-y-1">
                  <p className="text-sm font-medium text-foreground">Couldn’t open {tabName(activeTab)}</p>
                  <p className="text-sm text-muted-foreground">{activeTab.error}</p>
                </div>
              </div>
            )}
            {!activeTab && (
              <Welcome
                hasFolder={!!folder}
                onNew={newFile}
                onOpen={() => void openFileDialog()}
                onOpenFolder={() => void openFolderDialog()}
                onPalette={() => setPalette({ kind: 'quick', initial: '>' })}
                onQuickOpen={() => setPalette({ kind: 'quick', initial: '' })}
              />
            )}
          </div>
        </main>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border/60 bg-background/50 px-3 text-xs text-muted-foreground">
        <span
          role="status"
          className={cn('min-w-0 flex-1 truncate', status?.startsWith('Couldn’t') && 'text-destructive')}
        >
          {saving ? 'Saving…' : status}
        </span>
        {editorReady && activeTab && (
          <>
            <CaretStatus store={caretStore} onClick={() => setPalette({ kind: 'quick', initial: ':' })} />
            <StatusButton title="Change Indentation" onClick={pickIndent}>{describeIndent(activeTab.indent)}</StatusButton>
            <StatusButton title="Change Language Mode" onClick={pickLanguage}>{activeTab.language ?? 'Plain Text'}</StatusButton>
            {fontSize !== DEFAULT_FONT_SIZE && (
              <StatusButton title="Reset Zoom (Ctrl+0)" onClick={() => zoom(0)}>
                {Math.round((fontSize / DEFAULT_FONT_SIZE) * 100)}%
              </StatusButton>
            )}
          </>
        )}
      </div>

      {palette && (
        <Palette
          // A command that opens a list (Change Language Mode) starts it afresh.
          key={palette.kind === 'pick' ? `pick:${palette.placeholder}` : `quick:${palette.initial}`}
          mode={palette}
          files={paletteFiles}
          filesLoading={!!folder && projectFiles.isFetching && !projectFiles.data}
          hasFolder={!!folder}
          commands={commands}
          lineCount={editorReady ? caretStore.get().lines : null}
          onOpenFile={(path) => void openPath(path)}
          onGotoLine={(line, column) => {
            if (!activeId) return;
            reveals.current.set(activeId, { line, column });
            applyReveal(activeId);
          }}
          onClose={() => {
            setPalette(null);
            requestAnimationFrame(() => {
              if (shown.current && !document.querySelector('[role="dialog"]')) viewRef.current?.focus();
            });
          }}
        />
      )}

      {askingTab && (
        <Overlay label="Unsaved changes" onClose={() => setAsking(null)}>
          <div className="p-4">
            <p className="text-sm font-medium text-foreground">Save changes to “{tabName(askingTab)}”?</p>
            <p className="mt-1 text-sm text-muted-foreground">If you don’t, your changes will be lost.</p>
            <div className="mt-4 flex justify-end gap-2">
              <DialogButton variant="destructive" onClick={() => { setAsking(null); closeTabNow(askingTab.id); }} disabled={saving}>
                Don’t Save
              </DialogButton>
              <span className="flex-1" />
              <DialogButton onClick={() => setAsking(null)} disabled={saving}>Cancel</DialogButton>
              <DialogButton
                variant="primary"
                autoFocus
                disabled={saving}
                onClick={() => {
                  setAsking(null);
                  void saveTab(askingTab.id).then((ok) => ok && closeTabNow(askingTab.id));
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </DialogButton>
            </div>
          </div>
        </Overlay>
      )}

      {asking?.kind === 'window' && (
        <Overlay label="Unsaved changes" onClose={() => setAsking(null)}>
          <div className="p-4">
            <p className="text-sm font-medium text-foreground">
              {dirtyCount === 1
                ? `Save changes to “${tabName(tabs.find((t) => t.dirty)!)}” before closing?`
                : `Save changes to ${dirtyCount} files before closing?`}
            </p>
            {dirtyCount > 1 && (
              <ul className="mt-2 max-h-32 overflow-auto text-sm text-muted-foreground">
                {tabs.filter((t) => t.dirty).map((t) => <li key={t.id} className="truncate">{tabName(t)}</li>)}
              </ul>
            )}
            <p className="mt-1 text-sm text-muted-foreground">If you don’t, your changes will be lost.</p>
            <div className="mt-4 flex justify-end gap-2">
              <DialogButton variant="destructive" onClick={closeWindowNow} disabled={saving}>
                Don’t Save
              </DialogButton>
              <span className="flex-1" />
              <DialogButton onClick={() => setAsking(null)} disabled={saving}>Cancel</DialogButton>
              <DialogButton
                variant="primary"
                autoFocus
                disabled={saving}
                onClick={() => {
                  setAsking(null);
                  void saveAll().then((ok) => ok && closeWindowNow());
                }}
              >
                {saving ? 'Saving…' : dirtyCount === 1 ? 'Save' : 'Save All'}
              </DialogButton>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function SidebarTab({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md text-foreground/60 hover:bg-foreground/10 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-foreground/10 text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function StatusButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="shrink-0 rounded px-1 tabular-nums hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function CaretStatus({ store, onClick }: { store: ReturnType<typeof createCaretStore>; onClick: () => void }) {
  const caret = useSyncExternalStore(store.subscribe, store.get);
  return (
    <StatusButton title="Go to Line (Ctrl+G)" onClick={onClick}>
      Ln {caret.line}, Col {caret.column}
      {caret.cursors > 1
        ? ` (${caret.cursors} selections)`
        : caret.selected > 0 && ` (${caret.selected.toLocaleString()} selected)`}
    </StatusButton>
  );
}

function Welcome({
  hasFolder,
  onNew,
  onOpen,
  onOpenFolder,
  onPalette,
  onQuickOpen,
}: {
  hasFolder: boolean;
  onNew: () => void;
  onOpen: () => void;
  onOpenFolder: () => void;
  onPalette: () => void;
  onQuickOpen: () => void;
}) {
  const shortcuts: [string, string, () => void][] = [
    ['New File', 'Ctrl+N', onNew],
    ['Open File…', 'Ctrl+O', onOpen],
    ['Open Folder…', 'Ctrl+K Ctrl+O', onOpenFolder],
    ...(hasFolder ? [['Go to File…', 'Ctrl+P', onQuickOpen] as [string, string, () => void]] : []),
    ['Show All Commands', 'Ctrl+Shift+P', onPalette],
  ];
  return (
    <div className="absolute inset-0 grid place-items-center overflow-auto p-6">
      <div className="w-full max-w-xs space-y-1">
        {shortcuts.map(([label, keys, action]) => (
          <button
            key={label}
            type="button"
            onClick={action}
            className="flex w-full items-center justify-between gap-4 rounded-md px-3 py-2 text-sm text-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>{label}</span>
            <kbd className="font-sans text-xs text-muted-foreground">{keys}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}
