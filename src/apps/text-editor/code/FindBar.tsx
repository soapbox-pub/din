import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { ArrowDown, ArrowUp, ChevronRight, TextSelect, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FieldBox, IconButton, OptionToggle, TextButton, fieldInputClass } from './controls';

/** Matches counted before the bar just says "10,000+". */
const MAX_COUNTED = 10_000;

export interface FindBarStore {
  subscribe(listener: () => void): () => void;
  version(): number;
  /** Whether the replace row shows. */
  readonly replace: boolean;
  setReplace(on: boolean): void;
}

/** The find and replace bar over the editor (see findPanel.ts). */
export function FindBar({ view, store }: { view: EditorView; store: FindBarStore }) {
  const version = useSyncExternalStore(store.subscribe, store.version);
  const query = getSearchQuery(view.state);
  const findRef = useRef<HTMLInputElement>(null);

  // React draws the bar after CodeMirror tries to focus it, so it takes focus itself.
  useEffect(() => {
    findRef.current?.focus();
    findRef.current?.select();
  }, []);

  const set = (changes: Partial<ConstructorParameters<typeof SearchQuery>[0]>) =>
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query.search,
          replace: query.replace,
          caseSensitive: query.caseSensitive,
          regexp: query.regexp,
          wholeWord: query.wholeWord,
          ...changes,
        }),
      ),
    });

  const { count, current } = useMemo(() => {
    void version;
    if (!query.search || !query.valid) return { count: 0, current: -1 };
    const { from, to } = view.state.selection.main;
    const cursor = query.getCursor(view.state);
    let n = 0;
    let at = -1;
    for (let next = cursor.next(); !next.done && n < MAX_COUNTED; next = cursor.next()) {
      if (next.value.from === from && next.value.to === to) at = n;
      n++;
    }
    return { count: n, current: at };
  }, [query, view, version]);

  const close = () => {
    closeSearchPanel(view);
    view.focus();
  };
  const showReplace = store.replace;
  const toggleReplace = () => {
    store.setReplace(!store.replace);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, field: 'find' | 'replace') => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && field === 'find' && e.altKey) {
      e.preventDefault();
      selectMatches(view);
      view.focus();
    } else if (e.key === 'Enter' && field === 'find') {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
    } else if (e.key === 'Enter' && field === 'replace') {
      e.preventDefault();
      if (mod && e.altKey) replaceAll(view);
      else replaceNext(view);
    } else if (e.altKey && !mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      set({ caseSensitive: !query.caseSensitive });
    } else if (e.altKey && !mod && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      set({ wholeWord: !query.wholeWord });
    } else if (e.altKey && !mod && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      set({ regexp: !query.regexp });
    } else {
      return;
    }
    e.stopPropagation();
  };

  const invalid = !!query.search && !query.valid;
  const status = !query.search
    ? ''
    : invalid
      ? 'Invalid pattern'
      : count === 0
        ? 'No results'
        : `${current >= 0 ? `${(current + 1).toLocaleString()} of ` : ''}${count >= MAX_COUNTED ? `${MAX_COUNTED.toLocaleString()}+` : count.toLocaleString()}${current >= 0 ? '' : ' found'}`;

  return (
    <div className="flex gap-1 bg-background/60 px-2 py-1.5 backdrop-blur-sm" role="search">
      <IconButton
        label={showReplace ? 'Hide replace' : 'Show replace (Ctrl+H)'}
        small
        className="mt-0.5"
        onClick={toggleReplace}
      >
        <ChevronRight className={cn('size-4 transition-transform motion-reduce:transition-none', showReplace && 'rotate-90')} />
      </IconButton>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1">
          <FieldBox className="min-w-32 max-w-md flex-1" invalid={invalid}>
            <input
              ref={findRef}
              main-field="true"
              value={query.search}
              onChange={(e) => set({ search: e.target.value })}
              onKeyDown={(e) => onKeyDown(e, 'find')}
              placeholder="Find"
              aria-label="Find"
              aria-invalid={invalid}
              spellCheck={false}
              className={fieldInputClass}
            />
            <OptionToggle label="Match Case (Alt+C)" pressed={query.caseSensitive} onToggle={() => set({ caseSensitive: !query.caseSensitive })}>
              Aa
            </OptionToggle>
            <OptionToggle label="Match Whole Word (Alt+W)" pressed={query.wholeWord} onToggle={() => set({ wholeWord: !query.wholeWord })}>
              <span className="underline decoration-1 underline-offset-2">ab</span>
            </OptionToggle>
            <OptionToggle label="Use Regular Expression (Alt+R)" pressed={query.regexp} onToggle={() => set({ regexp: !query.regexp })}>
              .*
            </OptionToggle>
          </FieldBox>
          <span
            className={cn('w-24 shrink-0 truncate text-center text-xs tabular-nums text-muted-foreground', invalid && 'text-destructive')}
            aria-live="polite"
          >
            {status}
          </span>
          <IconButton label="Previous Match (Shift+Enter)" small disabled={count === 0} onClick={() => findPrevious(view)}>
            <ArrowUp className="size-4.5" strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Next Match (Enter)" small disabled={count === 0} onClick={() => findNext(view)}>
            <ArrowDown className="size-4.5" strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label="Select All Matches (Alt+Enter)"
            small
            disabled={count === 0}
            onClick={() => {
              selectMatches(view);
              view.focus();
            }}
          >
            <TextSelect className="size-4.5" strokeWidth={1.75} />
          </IconButton>
          <span className="flex-1" />
          <IconButton label="Close (Escape)" small onClick={close}>
            <X className="size-4.5" strokeWidth={1.75} />
          </IconButton>
        </div>
        {showReplace && (
          <div className="flex min-w-0 items-center gap-1">
            <FieldBox className="min-w-32 max-w-md flex-1">
              <input
                value={query.replace}
                onChange={(e) => set({ replace: e.target.value })}
                onKeyDown={(e) => onKeyDown(e, 'replace')}
                placeholder="Replace"
                aria-label="Replace"
                spellCheck={false}
                className={fieldInputClass}
              />
            </FieldBox>
            <TextButton onClick={() => replaceNext(view)} disabled={count === 0} title="Replace (Enter)">
              Replace
            </TextButton>
            <TextButton onClick={() => replaceAll(view)} disabled={count === 0} title="Replace All (Ctrl+Alt+Enter)">
              Replace All
            </TextButton>
          </div>
        )}
      </div>
    </div>
  );
}
