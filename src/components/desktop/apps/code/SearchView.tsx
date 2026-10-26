import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Ellipsis, Loader2, Replace } from 'lucide-react';
import { cleanFsError, getFsBridge, type FsSearchOptions, type FsSearchResult } from '@/lib/fs';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/utils';
import { FileIcon } from '../files/FileIcon';
import { FieldBox, IconButton, OptionToggle, TextButton, fieldInputClass } from './controls';
import { searchRegExp, type SearchState } from './search';

/**
 * Search across every file in the open folder (Ctrl+Shift+F), VS Code
 * style: results grouped by file as you type, a click opens the match, and
 * Replace All rewrites every file at once.
 */
export function SearchView({
  root,
  state,
  onChange,
  focusToken,
  onOpenMatch,
  onReplaceAll,
}: {
  root: string;
  state: SearchState;
  onChange: (state: SearchState) => void;
  /** Changes whenever the search field should take focus (Ctrl+Shift+F again). */
  focusToken: number;
  onOpenMatch: (path: string, line: number, column: number, length: number) => void;
  /** Replace in every file of `result`; resolves when done. */
  onReplaceAll: (result: FsSearchResult, options: FsSearchOptions, replacement: string) => Promise<void>;
}) {
  const fs = getFsBridge();
  const inputRef = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<{ key: string; result: FsSearchResult | null; error: string | null } | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [refresh, setRefresh] = useState(0);
  const seq = useRef(0);

  const options: FsSearchOptions = {
    query: state.query,
    regex: state.regex,
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    include: state.include,
    exclude: state.exclude,
  };
  const debouncedKey = useDebouncedValue(JSON.stringify(options), 250);
  const requestKey = `${debouncedKey}\0${refresh}`;
  const request = useMemo(() => JSON.parse(debouncedKey) as FsSearchOptions, [debouncedKey]);
  const patternError = useMemo(() => {
    if (!request.regex) return null;
    try {
      searchRegExp(request);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'Invalid pattern';
    }
  }, [request]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  useEffect(() => {
    if (!fs || !request.query || patternError) return;
    const mine = ++seq.current;
    fs.search(root, request).then(
      (result) => {
        if (mine !== seq.current) return;
        setOutcome({ key: requestKey, result, error: null });
        setCollapsed(new Set());
      },
      (e: unknown) => {
        if (mine === seq.current) setOutcome({ key: requestKey, result: null, error: cleanFsError(e) });
      },
    );
  }, [fs, root, request, requestKey, patternError]);

  const active = !!state.query && !!request.query && !patternError;
  const searching = active && outcome?.key !== requestKey;
  const result = active ? (outcome?.result ?? null) : null;
  const error = patternError ?? (active ? (outcome?.error ?? null) : null);

  const set = (changes: Partial<SearchState>) => onChange({ ...state, ...changes });
  const total = result?.files.reduce((n, f) => n + f.matches.length, 0) ?? 0;
  const [confirming, setConfirming] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const replaceAll = async () => {
    if (!result) return;
    setConfirming(false);
    setReplacing(true);
    try {
      await onReplaceAll(result, options, state.replace);
    } finally {
      setReplacing(false);
      setRefresh((n) => n + 1);
    }
  };

  const summary = error
    ? error
    : !state.query
      ? null
      : searching && !result
        ? 'Searching…'
        : result && total === 0
          ? `No results in ${result.searched.toLocaleString()} file${result.searched === 1 ? '' : 's'}.`
          : result
            ? `${total.toLocaleString()} result${total === 1 ? '' : 's'} in ${result.files.length.toLocaleString()} file${result.files.length === 1 ? '' : 's'}${result.truncated ? ' (stopped early, narrow it down)' : ''}`
            : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 px-2 pb-2" role="search">
        <IconButton
          label={state.showReplace ? 'Hide replace' : 'Show replace'}
          small
          className="mt-0.5"
          onClick={() => set({ showReplace: !state.showReplace })}
        >
          <ChevronRight className={cn('size-4 transition-transform motion-reduce:transition-none', state.showReplace && 'rotate-90')} />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldBox invalid={!!error && state.regex}>
            <input
              ref={inputRef}
              value={state.query}
              onChange={(e) => set({ query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setRefresh((n) => n + 1);
                else if (e.altKey && e.key.toLowerCase() === 'c') set({ caseSensitive: !state.caseSensitive });
                else if (e.altKey && e.key.toLowerCase() === 'w') set({ wholeWord: !state.wholeWord });
                else if (e.altKey && e.key.toLowerCase() === 'r') set({ regex: !state.regex });
                else return;
                e.preventDefault();
              }}
              placeholder="Search"
              aria-label="Search in files"
              spellCheck={false}
              className={fieldInputClass}
            />
            <OptionToggle label="Match Case (Alt+C)" pressed={state.caseSensitive} onToggle={() => set({ caseSensitive: !state.caseSensitive })}>
              Aa
            </OptionToggle>
            <OptionToggle label="Match Whole Word (Alt+W)" pressed={state.wholeWord} onToggle={() => set({ wholeWord: !state.wholeWord })}>
              <span className="underline decoration-1 underline-offset-2">ab</span>
            </OptionToggle>
            <OptionToggle label="Use Regular Expression (Alt+R)" pressed={state.regex} onToggle={() => set({ regex: !state.regex })}>
              .*
            </OptionToggle>
          </FieldBox>
          {state.showReplace && (
            <div className="flex min-w-0 items-center gap-1">
              <FieldBox className="flex-1">
                <input
                  value={state.replace}
                  onChange={(e) => set({ replace: e.target.value })}
                  placeholder="Replace"
                  aria-label="Replace in files"
                  spellCheck={false}
                  className={fieldInputClass}
                />
              </FieldBox>
              <IconButton label="Replace All" small disabled={!result || total === 0 || replacing} onClick={() => setConfirming(true)}>
                {replacing ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Replace className="size-4" />}
              </IconButton>
            </div>
          )}
          <div className="flex justify-end">
            <IconButton label="Toggle file filters" small pressed={state.showFilters} onClick={() => set({ showFilters: !state.showFilters })} className="size-6">
              <Ellipsis className="size-4" />
            </IconButton>
          </div>
          {state.showFilters && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="code-search-include">Files to include</label>
              <FieldBox>
                <input
                  id="code-search-include"
                  value={state.include}
                  onChange={(e) => set({ include: e.target.value })}
                  placeholder="e.g. *.ts, src/**"
                  spellCheck={false}
                  className={fieldInputClass}
                />
              </FieldBox>
              <label className="text-xs text-muted-foreground" htmlFor="code-search-exclude">Files to exclude</label>
              <FieldBox>
                <input
                  id="code-search-exclude"
                  value={state.exclude}
                  onChange={(e) => set({ exclude: e.target.value })}
                  placeholder="e.g. *.test.ts, dist"
                  spellCheck={false}
                  className={fieldInputClass}
                />
              </FieldBox>
            </div>
          )}
        </div>
      </div>

      {confirming && result && (
        <div className="mx-2 mb-2 rounded-lg border border-border bg-background/80 p-3 text-sm" role="alertdialog" aria-label="Replace all">
          <p>
            Replace {total.toLocaleString()} match{total === 1 ? '' : 'es'} in {result.files.length.toLocaleString()} file
            {result.files.length === 1 ? '' : 's'} with “{state.replace}”?
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Open files change in their tabs; the rest are saved straight away.</p>
          <div className="mt-2 flex justify-end gap-1">
            <TextButton onClick={() => setConfirming(false)}>Cancel</TextButton>
            <TextButton onClick={() => void replaceAll()}>Replace</TextButton>
          </div>
        </div>
      )}

      {summary && (
        <p
          className={cn('flex items-center gap-2 px-4 pb-2 text-xs text-muted-foreground', error && 'text-destructive')}
          aria-live="polite"
        >
          {searching && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />}
          {summary}
        </p>
      )}

      <div className={cn('min-h-0 flex-1 overflow-auto pb-4 text-sm', searching && 'opacity-70')} role="tree" aria-label="Search results">
        {result?.files.map((file) => {
          const isCollapsed = collapsed.has(file.path);
          const slash = file.path.lastIndexOf('/');
          const name = file.path.slice(slash + 1);
          return (
            <div key={file.path} role="treeitem" aria-expanded={!isCollapsed} aria-selected={false}>
              <button
                type="button"
                onClick={() =>
                  setCollapsed((c) => {
                    const next = new Set(c);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  })
                }
                title={file.path}
                className="flex h-6 w-full items-center gap-1.5 px-2 text-left hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', !isCollapsed && 'rotate-90')} aria-hidden />
                <FileIcon path="" name={name} kind="file" size={null} mtimeMs={null} px={16} thumbnail={false} />
                <span className="shrink-0 truncate">{name}</span>
                {slash > 0 && <span className="min-w-0 truncate text-xs text-muted-foreground">{file.path.slice(0, slash)}</span>}
                <span className="ml-auto shrink-0 rounded-full bg-foreground/10 px-1.5 text-xs tabular-nums text-muted-foreground">
                  {file.matches.length}
                </span>
              </button>
              {!isCollapsed && (
                <div role="group">
                  {file.matches.map((m, i) => (
                    <button
                      key={i}
                      type="button"
                      role="treeitem"
                      aria-selected={false}
                      title={`Line ${m.line}`}
                      onClick={() => onOpenMatch(`${root}/${file.path}`, m.line, m.column + 1, m.length)}
                      className="flex h-6 w-full items-center gap-2 pl-10 pr-2 text-left font-mono text-xs hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="min-w-0 truncate whitespace-pre text-foreground/80">
                        {m.preview.slice(0, m.previewColumn)}
                        {state.showReplace && state.replace !== '' ? (
                          <>
                            <del className="bg-destructive/20 text-foreground">{m.preview.slice(m.previewColumn, m.previewColumn + m.length)}</del>
                            <ins className="bg-emerald-500/20 text-foreground no-underline">{state.replace}</ins>
                          </>
                        ) : (
                          <mark className="rounded-sm bg-amber-400/40 text-foreground">{m.preview.slice(m.previewColumn, m.previewColumn + m.length)}</mark>
                        )}
                        {m.preview.slice(m.previewColumn + m.length)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
