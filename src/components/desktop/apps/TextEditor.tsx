import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronUp,
  FilePlus,
  FolderOpen,
  Save,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { cn } from '@/lib/utils';
import { cleanFsError, getFsBridge, parentPath, type FsBridge } from '@/lib/fs';
import { setCloseGuard } from '@/lib/closeGuards';
import { invalidateListings } from '@/hooks/useFileSystem';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { Skeleton } from '@/components/ui/skeleton';
import { DialogButton, Overlay } from './files/Dialogs';

/** Bigger files than this aren't opened: a textarea gets sluggish well before. */
const MAX_BYTES = 8 * 1024 * 1024;
const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32];
const DEFAULT_FONT_SIZE = 14;
const WRAP_KEY = 'din:text-editor:wrap';
const FONT_SIZE_KEY = 'din:text-editor:font-size';

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

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Insert text at the selection the way typing would, so Ctrl+Z undoes it. */
function insertText(el: HTMLTextAreaElement, text: string) {
  el.focus();
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Select a range and bring it into view. */
function selectRange(el: HTMLTextAreaElement, start: number, end: number) {
  el.focus();
  el.setSelectionRange(start, end);
  // Chromium scrolls a textarea to its caret on focus, not on setSelectionRange.
  el.blur();
  el.focus();
}

/** A file's text, or why it can't be edited here. */
async function readText(fs: FsBridge, path: string): Promise<{ text: string } | { error: string }> {
  try {
    const result = await fs.readFile(path, MAX_BYTES);
    if (result.truncated) return { error: 'It’s too big for the Text Editor (over 8 MB).' };
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

/** Every place `query` occurs in `text`, case-insensitively. */
function findAll(text: string, query: string): number[] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const found: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    found.push(i);
  }
  return found;
}

/**
 * Text Editor - plain text and code: new documents, opening and saving
 * anywhere through Din's file picker, find and replace, word wrap. Closing
 * a window with unsaved changes asks about them first.
 *
 * Launch params: `{ path?: string }` (absolute); none starts an empty document.
 */
export function TextEditor({ windowId, params }: AppComponentProps) {
  const initial = typeof params?.path === 'string' ? params.path : null;
  const fs = getFsBridge();
  const { open, close, focus } = useWindowActions();
  const { pickFile, pickFiles } = useFilePicker();
  const queryClient = useQueryClient();

  const [path, setPath] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(initial !== null && fs !== undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [wrap, setWrap] = useState(() => readSetting(WRAP_KEY, true, isBoolean));
  const [fontSize, setFontSize] = useState(() => readSetting(FONT_SIZE_KEY, DEFAULT_FONT_SIZE, isFontSize));
  const [caret, setCaret] = useState({ line: 1, column: 1, selected: 0 });
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const loadSeq = useRef(0);

  const dirty = value !== saved;
  const name = path ? basename(path) : 'Untitled';
  useWindowTitle(`${dirty ? '• ' : ''}${name}`);

  useEffect(() => localStorage.setItem(WRAP_KEY, JSON.stringify(wrap)), [wrap]);
  useEffect(() => localStorage.setItem(FONT_SIZE_KEY, JSON.stringify(fontSize)), [fontSize]);

  /** Read a file into this window, replacing what's here. */
  const load = useCallback(
    (target: string) => {
      if (!fs) return;
      const seq = ++loadSeq.current;
      readText(fs, target).then((result) => {
        if (seq !== loadSeq.current) return;
        setPath(target);
        setLoading(false);
        setStatus(null);
        if ('error' in result) {
          setLoadError(result.error);
          return;
        }
        setSaved(result.text);
        setValue(result.text);
        setLoadError(null);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus({ preventScroll: true });
          el.setSelectionRange(0, 0);
          el.scrollTop = 0;
        });
      });
    },
    [fs],
  );

  // The file this window was opened with, and any asked of it later.
  const [prevInitial, setPrevInitial] = useState<string | null>(null);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    if (initial && fs) setLoading(true);
  }
  useEffect(() => {
    if (initial) load(initial);
  }, [initial, load]);

  useEffect(() => {
    if (!loading) textareaRef.current?.focus({ preventScroll: true });
  }, [loading]);

  const saveTo = useCallback(
    async (target: string): Promise<boolean> => {
      if (!fs) return false;
      setSaving(true);
      setStatus(null);
      const contents = value;
      try {
        await fs.writeFile(target, contents);
        setPath(target);
        setSaved(contents);
        setLoadError(null);
        setStatus('Saved');
        void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile', target] });
        void invalidateListings(queryClient, target);
        return true;
      } catch (error) {
        setStatus(`Couldn’t save: ${cleanFsError(error)}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [fs, value, queryClient],
  );

  const saveAs = useCallback(async (): Promise<boolean> => {
    const result = await pickFiles({
      mode: 'save',
      title: 'Save As',
      currentName: path ? basename(path) : 'Untitled.txt',
      initialPath: path ? parentPath(path) : undefined,
    });
    if (!result) return false;
    return saveTo(result.paths[0]);
  }, [pickFiles, path, saveTo]);

  const save = useCallback(
    (): Promise<boolean> => (path && !loadError ? saveTo(path) : saveAs()),
    [path, loadError, saveTo, saveAs],
  );

  const openFile = useCallback(async () => {
    const target = await pickFile({
      title: 'Open',
      initialPath: path ? parentPath(path) : undefined,
    });
    if (!target) return;
    // Unsaved work stays where it is; the file gets a window of its own.
    if (dirty) {
      open('text-editor', { path: target });
      return;
    }
    setLoading(true);
    load(target);
  }, [pickFile, path, dirty, open, load]);

  // Closing with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    setCloseGuard(windowId, () => {
      focus(windowId);
      setAsking(true);
      return true;
    });
    return () => setCloseGuard(windowId, null);
  }, [dirty, windowId, focus]);

  const closeNow = useCallback(() => {
    setCloseGuard(windowId, null);
    setAsking(false);
    close(windowId);
  }, [windowId, close]);

  // Line numbers, beside unwrapped text (wrapped lines wouldn't line up).
  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) n++;
    return n;
  }, [value]);
  const gutter = useMemo(
    () => (wrap ? '' : Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')),
    [wrap, lineCount],
  );
  const syncGutter = useCallback(() => {
    const el = textareaRef.current;
    const g = gutterRef.current;
    if (el && g) g.style.transform = `translateY(${-el.scrollTop}px)`;
  }, []);
  useLayoutEffect(syncGutter, [syncGutter, wrap, gutter]);

  const updateCaret = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const lineStart = before.lastIndexOf('\n') + 1;
    let line = 1;
    for (let i = before.indexOf('\n'); i !== -1; i = before.indexOf('\n', i + 1)) line++;
    setCaret({
      line,
      column: el.selectionStart - lineStart + 1,
      selected: el.selectionEnd - el.selectionStart,
    });
  }, []);

  // Find and replace.
  const matches = useMemo(() => (findOpen ? findAll(value, query) : []), [findOpen, value, query]);
  const [matchIndex, setMatchIndex] = useState(-1);

  const findNext = useCallback(
    (direction: 1 | -1 = 1) => {
      const el = textareaRef.current;
      if (!el || matches.length === 0) return;
      const from = direction === 1 ? el.selectionEnd : el.selectionStart;
      let index = direction === 1
        ? matches.findIndex((m) => m >= from)
        : matches.findLastIndex((m) => m + query.length <= from);
      if (index === -1) index = direction === 1 ? 0 : matches.length - 1;
      setMatchIndex(index);
      selectRange(el, matches[index], matches[index] + query.length);
      updateCaret();
    },
    [matches, query, updateCaret],
  );

  const replaceOne = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !query) return;
    const selected = el.value.slice(el.selectionStart, el.selectionEnd);
    if (selected.toLowerCase() === query.toLowerCase()) insertText(el, replacement);
    findNext(1);
  }, [query, replacement, findNext]);

  const replaceAll = useCallback(() => {
    const el = textareaRef.current;
    if (!el || matches.length === 0) return;
    let next = '';
    let last = 0;
    for (const m of matches) {
      next += el.value.slice(last, m) + replacement;
      last = m + query.length;
    }
    next += el.value.slice(last);
    // One edit, so one Ctrl+Z undoes it.
    el.focus();
    el.select();
    insertText(el, next);
    el.setSelectionRange(0, 0);
    setStatus(`Replaced ${matches.length} match${matches.length === 1 ? '' : 'es'}`);
  }, [matches, query, replacement]);

  const showFind = useCallback((withReplace: boolean) => {
    const el = textareaRef.current;
    if (el && el.selectionEnd > el.selectionStart) {
      const selected = el.value.slice(el.selectionStart, el.selectionEnd);
      if (!selected.includes('\n')) setQuery(selected);
    }
    setFindOpen(true);
    if (withReplace) setReplaceOpen(true);
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  }, []);

  const hideFind = useCallback(() => {
    setFindOpen(false);
    setReplaceOpen(false);
    setMatchIndex(-1);
    textareaRef.current?.focus();
  }, []);

  const zoom = useCallback((step: number) => {
    setFontSize((size) => {
      if (step === 0) return DEFAULT_FONT_SIZE;
      const i = FONT_SIZES.indexOf(size);
      return FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, i + step))];
    });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (asking) return;
    const key = e.key.toLowerCase();
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    let handled = true;
    if (ctrl && !e.shiftKey && key === 's') void save();
    else if (ctrl && e.shiftKey && key === 's') void saveAs();
    else if (ctrl && !e.shiftKey && key === 'o') void openFile();
    else if (ctrl && !e.shiftKey && key === 'n') open('text-editor');
    else if (ctrl && !e.shiftKey && (key === 'w' || key === 'q')) close(windowId);
    else if (ctrl && !e.shiftKey && key === 'f') showFind(false);
    else if (ctrl && !e.shiftKey && key === 'h') showFind(true);
    else if ((ctrl && key === 'g') || e.key === 'F3') findNext(e.shiftKey ? -1 : 1);
    else if (ctrl && (key === '=' || key === '+')) zoom(1);
    else if (ctrl && key === '-') zoom(-1);
    else if (ctrl && key === '0') zoom(0);
    else if (e.altKey && !e.ctrlKey && !e.metaKey && key === 'z') setWrap((w) => !w);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Tab' && !e.shiftKey) {
      // Tab indents, as in any text editor.
      e.preventDefault();
      insertText(el, '\t');
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // A new line keeps the indentation of the one it splits.
      const lineStart = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
      const indent = /^[\t ]*/.exec(el.value.slice(lineStart, el.selectionStart))![0];
      if (!indent) return;
      e.preventDefault();
      insertText(el, `\n${indent}`);
    } else if (e.key === 'Escape' && findOpen) {
      e.preventDefault();
      hideFind();
    }
  };

  if (!fs) {
    return (
      <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        The Text Editor needs the Electron shell to read and save files.
      </p>
    );
  }

  const lineHeight = Math.round(fontSize * 1.6);
  const textStyle = { fontSize, lineHeight: `${lineHeight}px` };

  return (
    <div className="relative flex h-full w-full flex-col" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-background/50 px-2 py-1.5">
        <BarButton label="New (Ctrl+N)" onClick={() => open('text-editor')}>
          <FilePlus className="size-4" />
        </BarButton>
        <BarButton label="Open… (Ctrl+O)" onClick={() => void openFile()}>
          <FolderOpen className="size-4" />
        </BarButton>
        <BarButton label="Save (Ctrl+S)" onClick={() => void save()} disabled={saving || loading}>
          <Save className="size-4" />
        </BarButton>
        <button
          type="button"
          onClick={() => void saveAs()}
          disabled={saving || loading}
          className={cn(
            'h-8 shrink-0 rounded-md px-2 text-sm text-foreground/80',
            'hover:bg-foreground/10 hover:text-foreground disabled:opacity-40',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
          title="Save As… (Ctrl+Shift+S)"
        >
          Save As…
        </button>
        <span className="min-w-0 flex-1" />
        <BarButton label="Find and Replace (Ctrl+F)" pressed={findOpen} onClick={() => (findOpen ? hideFind() : showFind(false))}>
          <Search className="size-4" />
        </BarButton>
        <BarButton label="Wrap Lines (Alt+Z)" pressed={wrap} onClick={() => setWrap((w) => !w)}>
          <WrapText className="size-4" />
        </BarButton>
      </div>

      {findOpen && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-background/50 px-2 py-1.5">
          <div className="flex min-w-48 flex-1 items-center gap-1">
            <button
              type="button"
              aria-label={replaceOpen ? 'Hide replace' : 'Show replace'}
              aria-expanded={replaceOpen}
              onClick={() => setReplaceOpen((r) => !r)}
              className="grid size-7 shrink-0 place-items-center rounded-md text-foreground/70 hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown className={cn('size-4 transition-transform motion-reduce:transition-none', !replaceOpen && '-rotate-90')} />
            </button>
            <input
              ref={findRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIndex(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  findNext(e.shiftKey ? -1 : 1);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  hideFind();
                }
              }}
              placeholder="Find"
              aria-label="Find"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="w-20 shrink-0 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
              {query
                ? matches.length === 0
                  ? 'No results'
                  : matchIndex >= 0
                    ? `${matchIndex + 1} of ${matches.length}`
                    : `${matches.length} found`
                : ''}
            </span>
            <BarButton label="Previous (Shift+Enter)" small onClick={() => findNext(-1)} disabled={matches.length === 0}>
              <ChevronUp className="size-4" />
            </BarButton>
            <BarButton label="Next (Enter)" small onClick={() => findNext(1)} disabled={matches.length === 0}>
              <ChevronDown className="size-4" />
            </BarButton>
            <BarButton label="Close (Escape)" small onClick={hideFind}>
              <X className="size-4" />
            </BarButton>
          </div>
          {replaceOpen && (
            <div className="flex w-full items-center gap-1 pl-8">
              <input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    replaceOne();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    hideFind();
                  }
                }}
                placeholder="Replace with"
                aria-label="Replace with"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <DialogButton onClick={replaceOne} disabled={matches.length === 0} className="h-7">
                Replace
              </DialogButton>
              <DialogButton onClick={replaceAll} disabled={matches.length === 0} className="h-7">
                All
              </DialogButton>
            </div>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="w-full space-y-2 p-4" aria-hidden>
            <Skeleton className="h-4 w-3/4 bg-foreground/10" />
            <Skeleton className="h-4 w-full bg-foreground/10" />
            <Skeleton className="h-4 w-2/3 bg-foreground/10" />
          </div>
        ) : loadError !== null ? (
          <div className="grid w-full place-items-center p-6 text-center">
            <div className="max-w-sm space-y-1">
              <p className="text-sm font-medium text-foreground">Couldn’t open {name}</p>
              <p className="text-sm text-muted-foreground">{loadError}</p>
            </div>
          </div>
        ) : (
          <>
            {!wrap && (
              <div className="shrink-0 overflow-hidden border-r border-border/40 bg-foreground/[0.03]" aria-hidden>
                <pre
                  ref={gutterRef}
                  className="px-3 py-3 text-right font-mono text-muted-foreground/70 select-none will-change-transform"
                  style={textStyle}
                >
                  {gutter}
                </pre>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setStatus(null);
                updateCaret();
              }}
              onKeyDown={onTextKeyDown}
              onSelect={updateCaret}
              onScroll={syncGutter}
              wrap={wrap ? 'soft' : 'off'}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label={`Contents of ${name}`}
              style={textStyle}
              className={cn(
                'min-h-0 min-w-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-foreground outline-none [tab-size:4]',
                !wrap && 'whitespace-pre',
              )}
            />
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-border/60 bg-background/50 px-3 py-1 text-xs text-muted-foreground">
        <span
          role="status"
          className={cn('min-w-0 flex-1 truncate', status?.startsWith('Couldn’t') && 'text-destructive')}
        >
          {saving ? 'Saving…' : (status ?? (dirty ? 'Edited' : ''))}
        </span>
        {!loading && loadError === null && (
          <>
            <span className="tabular-nums">
              Ln {caret.line}, Col {caret.column}
              {caret.selected > 0 && ` (${caret.selected.toLocaleString()} selected)`}
            </span>
            <span className="hidden tabular-nums sm:inline">
              {lineCount.toLocaleString()} line{lineCount === 1 ? '' : 's'}
            </span>
            {fontSize !== DEFAULT_FONT_SIZE && (
              <button
                type="button"
                onClick={() => zoom(0)}
                title="Reset zoom (Ctrl+0)"
                className="rounded px-1 tabular-nums hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {Math.round((fontSize / DEFAULT_FONT_SIZE) * 100)}%
              </button>
            )}
          </>
        )}
      </div>

      {asking && (
        <Overlay label="Unsaved changes" onClose={() => setAsking(false)}>
          <div className="p-4">
            <p className="text-sm font-medium text-foreground">Save changes to “{name}” before closing?</p>
            <p className="mt-1 text-sm text-muted-foreground">If you don’t, your changes will be lost.</p>
            <div className="mt-4 flex justify-end gap-2">
              <DialogButton variant="destructive" onClick={closeNow} disabled={saving}>
                Don’t Save
              </DialogButton>
              <span className="flex-1" />
              <DialogButton onClick={() => setAsking(false)} disabled={saving}>
                Cancel
              </DialogButton>
              <DialogButton
                variant="primary"
                autoFocus
                disabled={saving}
                onClick={() => {
                  setAsking(false);
                  void save().then((ok) => {
                    if (ok) closeNow();
                  });
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </DialogButton>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function BarButton({
  label,
  onClick,
  pressed,
  disabled,
  small,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid shrink-0 place-items-center rounded-md text-foreground/80',
        small ? 'size-7' : 'size-8',
        'hover:bg-foreground/10 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed && 'bg-foreground/10 text-foreground',
      )}
    >
      {children}
    </button>
  );
}
