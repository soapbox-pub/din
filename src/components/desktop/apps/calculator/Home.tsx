import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowDownToLine, Copy, CornerDownLeft, Loader2, Trash2, Undo2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parse, ParseError, tryParse } from './expr';
import { texText, toLatex, type NumberFormat } from './latex';
import { resultLatex, shapeResult, tidy } from './present';
import { toText } from './text';
import { TeX } from './TeX';
import { completions, enclosingCall } from './entryHelp';
import { insertText } from './catalog';
import type { HistoryEntry } from './state';

/** What the keypad and menus can do to the entry line. */
export interface EntryApi {
  insert: (text: string) => void;
  key: (action: 'enter' | 'approx' | 'backspace' | 'clear' | 'left' | 'right') => void;
  focus: () => void;
}

/** Operators that, typed first on an empty line, continue from the last answer. */
const CONTINUES_ANSWER = new Set(['+', '*', '/', '^', '→', '×', '÷']);

/** Typed sequences the entry line turns into their symbol. */
const SYMBOLS: [string, string][] = [
  ['->', '→'],
  ['<=', '≤'],
  ['>=', '≥'],
  ['!=', '≠'],
];

export function Home({
  history,
  format,
  busy,
  userFunctions,
  apiRef,
  onSubmit,
  onBreak,
  onRemove,
  onFocusEntry,
}: {
  history: HistoryEntry[];
  format: NumberFormat;
  busy: boolean;
  userFunctions: ReadonlySet<string>;
  apiRef: RefObject<EntryApi | null>;
  onSubmit: (input: string, approx: boolean) => void;
  onBreak: () => void;
  onRemove: (id: number) => void;
  onFocusEntry: () => void;
}) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recallIndex = useRef<number | null>(null);
  const pendingCaret = useRef<number | null>(null);

  // Keep the newest entry in view, like the TI-89's home screen.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, busy]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  const replace = useCallback((next: string, nextCaret: number) => {
    pendingCaret.current = nextCaret;
    setText(next);
    recallIndex.current = null;
  }, []);

  const insert = useCallback(
    (snippet: string) => {
      const el = inputRef.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? text.length;
      let piece = snippet;
      if (text.length === 0 && CONTINUES_ANSWER.has(snippet) && history.some((h) => h.result !== undefined)) {
        piece = `ans(1)${snippet}`;
      }
      replace(text.slice(0, start) + piece + text.slice(end), start + piece.length);
      el?.focus();
    },
    [text, history, replace],
  );

  const submit = useCallback(
    (approx: boolean) => {
      if (busy) return;
      let input = text.trim();
      // ENTER on an empty line runs the last entry again.
      if (!input) {
        const last = history[history.length - 1];
        if (!last) return;
        input = last.input;
      }
      // An entry that starts with an operator continues from the last answer.
      if (/^[+*/^→×÷]/.test(input) && history.some((h) => h.result !== undefined)) input = `ans(1)${input}`;
      onSubmit(input, approx);
      replace('', 0);
    },
    [busy, text, history, onSubmit, replace],
  );

  const recall = useCallback(
    (direction: -1 | 1) => {
      const inputs = history.map((h) => h.input);
      if (inputs.length === 0) return;
      let index = recallIndex.current ?? inputs.length;
      index = Math.min(Math.max(index + direction, 0), inputs.length);
      const next = index === inputs.length ? '' : inputs[index];
      pendingCaret.current = next.length;
      setText(next);
      recallIndex.current = index;
    },
    [history],
  );

  useEffect(() => {
    apiRef.current = {
      insert,
      focus: () => inputRef.current?.focus(),
      key: (action) => {
        const el = inputRef.current;
        const start = el?.selectionStart ?? text.length;
        const end = el?.selectionEnd ?? text.length;
        switch (action) {
          case 'enter':
            submit(false);
            break;
          case 'approx':
            submit(true);
            break;
          case 'clear':
            if (text) replace('', 0);
            else if (busy) onBreak();
            break;
          case 'backspace':
            if (start !== end) replace(text.slice(0, start) + text.slice(end), start);
            else if (start > 0) replace(text.slice(0, start - 1) + text.slice(start), start - 1);
            break;
          case 'left':
            replace(text, Math.max(start - 1, 0));
            break;
          case 'right':
            replace(text, Math.min(end + 1, text.length));
            break;
        }
        el?.focus();
      },
    };
  }, [apiRef, insert, submit, replace, text, busy, onBreak]);

  const preview = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { tex: toLatex(parse(text, { userFunctions })) };
    } catch (error) {
      return { error: error instanceof ParseError ? error.message : 'Syntax error' };
    }
  }, [text, userFunctions]);

  const hint = useMemo(() => enclosingCall(text, caret), [text, caret]);
  const suggestions = useMemo(() => completions(text, caret), [text, caret]);

  const complete = (name: string) => {
    if (!suggestions) return;
    const entry = suggestions.entries.find((e) => e.name === name);
    if (!entry) return;
    const start = caret - suggestions.word.length;
    const piece = insertText(entry);
    replace(text.slice(0, start) + piece + text.slice(caret), start + piece.length);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(e.ctrlKey || e.shiftKey || e.metaKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (busy) onBreak();
      else replace('', 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      recall(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      recall(1);
    } else if (e.key === 'Tab' && suggestions) {
      e.preventDefault();
      complete(suggestions.entries[0].name);
    } else if (e.key.length === 1 && text.length === 0 && CONTINUES_ANSWER.has(e.key) && !e.ctrlKey && !e.metaKey) {
      if (history.some((h) => h.result !== undefined)) {
        e.preventDefault();
        insert(e.key);
      }
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = e.target.value;
    let position = e.target.selectionStart ?? value.length;
    for (const [typed, symbol] of SYMBOLS) {
      const at = position - typed.length;
      if (at >= 0 && value.slice(at, position) === typed) {
        value = value.slice(0, at) + symbol + value.slice(position);
        position = at + symbol.length;
      }
    }
    replace(value, position);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        role="log"
        aria-label="History"
      >
        {history.length === 0 && !busy ? (
          <EmptyHome onTry={(example) => replace(example, example.length)} />
        ) : (
          <ol className="flex flex-col">
            {history.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                format={format}
                userFunctions={userFunctions}
                onUseInput={(input) => replace(input, input.length)}
                onInsert={insert}
                onApprox={(input) => onSubmit(input, true)}
                onRemove={() => onRemove(entry.id)}
              />
            ))}
          </ol>
        )}
        {busy && (
          <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
            <span>Working…</span>
            <button
              type="button"
              onClick={onBreak}
              className="ml-auto rounded-md px-2 py-1 text-xs font-medium text-foreground/80 hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Break <kbd className="ml-1 text-muted-foreground">Esc</kbd>
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/60 bg-muted/30">
        <div className="flex min-h-10 items-center gap-2 overflow-x-auto overflow-y-hidden px-4 pt-2 text-base" aria-live="off">
          {preview?.tex !== undefined && <TeX tex={preview.tex} className="text-[1.05rem]" />}
          {preview?.error && <span className="text-sm text-muted-foreground">{preview.error}</span>}
          {!preview && <span className="text-sm text-muted-foreground">Type an expression. Enter evaluates, Ctrl+Enter gives a decimal.</span>}
        </div>
        <div className="px-3 pb-3 pt-1">
          <div className="relative">
            {suggestions && (
              <div className="absolute bottom-full left-0 mb-1 flex flex-wrap gap-1" role="listbox" aria-label="Suggestions">
                {suggestions.entries.map((entry, i) => (
                  <button
                    key={entry.name}
                    type="button"
                    role="option"
                    aria-selected={i === 0}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => complete(entry.name)}
                    className={cn(
                      'rounded-md border border-border/60 bg-popover px-2 py-0.5 font-mono text-xs shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      i === 0 && 'border-primary/50',
                    )}
                  >
                    {entry.name}
                    {i === 0 && <span className="ml-1.5 text-muted-foreground">Tab</span>}
                  </button>
                ))}
              </div>
            )}
            <input
              ref={inputRef}
              value={text}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onFocus={onFocusEntry}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              aria-label="Entry line"
              placeholder="solve(x^2-5x+6=0, x)"
              className="h-11 w-full rounded-lg border border-input bg-background px-3 pr-11 font-mono text-[1.05rem] shadow-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={busy}
              aria-label="Evaluate"
              className="absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            >
              <CornerDownLeft className="size-4" aria-hidden />
            </button>
          </div>
          <div className="mt-1.5 min-h-5 truncate text-xs text-muted-foreground">
            {hint ? (
              <span>
                <span className="font-mono text-foreground/90">
                  {hint.entry.name}(
                  {hint.entry.args!.map((arg, i) => (
                    <span key={i}>
                      {i > 0 && ', '}
                      <span className={cn(i === hint.arg && 'font-semibold text-primary underline underline-offset-2')}>{arg}</span>
                    </span>
                  ))}
                  )
                </span>
                <span className="ml-2">{hint.entry.desc}</span>
              </span>
            ) : (
              <span>
                <kbd>↑</kbd>/<kbd>↓</kbd> recall · <kbd>Esc</kbd> clear · <kbd>-&gt;</kbd> stores (→) · <kbd>|</kbd> means “with”
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const EXAMPLES = [
  'solve(x^2-5x+6=0, x)',
  'factor(x^4-1)',
  '∫(x^2*sin(x), x)',
  'd(e^(x^2), x)',
  'limit(sin(x)/x, x, 0)',
  'Σ(1/k^2, k, 1, ∞)',
  "deSolve(y''+y=0, x, y)",
  'det([1,2;3,4])',
];

function EmptyHome({ onTry }: { onTry: (example: string) => void }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-10 text-center">
      <p className="text-sm text-muted-foreground">
        Exact answers, algebra, calculus and graphs, the way a TI-89 does them. Try one:
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onTry(example)}
            className="rounded-lg border border-border/60 bg-background px-3 py-1.5 font-mono text-xs shadow-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Whether giac's decimal adds anything to the exact answer. */
function showsDecimal(entry: HistoryEntry): boolean {
  if (!entry.decimal || !entry.result) return false;
  if (/^-?\d+$/.test(entry.result) && entry.result.length <= 12) return false;
  return true;
}

const HistoryRow = memo(function HistoryRow({
  entry,
  format,
  userFunctions,
  onUseInput,
  onInsert,
  onApprox,
  onRemove,
}: {
  entry: HistoryEntry;
  format: NumberFormat;
  userFunctions: ReadonlySet<string>;
  onUseInput: (input: string) => void;
  onInsert: (text: string) => void;
  onApprox: (input: string) => void;
  onRemove: () => void;
}) {
  const parsed = useMemo(() => tryParse(entry.input, { userFunctions }), [entry.input, userFunctions]);
  const inputTex = useMemo(() => (parsed ? toLatex(parsed) : `\\texttt{${texText(entry.input)}}`), [parsed, entry.input]);
  const resultTex = useMemo(() => {
    if (entry.done) return '\\text{Done}';
    if (entry.result === undefined) return undefined;
    return resultLatex(entry.result, parsed, format);
  }, [entry.done, entry.result, parsed, format]);
  /** The answer as entry-line text, for inserting and copying. */
  const resultText = useMemo(() => {
    if (entry.result === undefined || entry.done) return undefined;
    try {
      return toText(shapeResult(tidy(parse(entry.result, { giac: true })), parsed));
    } catch {
      return entry.result;
    }
  }, [entry.result, entry.done, parsed]);

  const decimal = showsDecimal(entry) ? entry.decimal : undefined;
  const decimalTex = useMemo(() => {
    if (!decimal) return undefined;
    try {
      return toLatex(parse(decimal, { giac: true }), { format });
    } catch {
      return undefined;
    }
  }, [decimal, format]);

  return (
    <li className="group relative border-b border-border/40 px-4 py-2.5 hover:bg-foreground/[0.025]">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <button
          type="button"
          onClick={() => onUseInput(entry.input)}
          title="Edit this entry"
          className="max-w-full overflow-x-auto overflow-y-hidden rounded-md px-1 py-1 text-left text-[1.05rem] hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TeX tex={inputTex} label={entry.input} />
          {entry.approx && <span className="ml-2 align-middle text-xs text-muted-foreground">≈</span>}
        </button>
        <div className="ml-auto flex max-w-full flex-col items-end">
          {entry.error ? (
            <p className="text-sm font-medium text-destructive" role="alert">
              Error: {entry.error}
            </p>
          ) : resultTex !== undefined ? (
            <button
              type="button"
              onClick={() => resultText && onInsert(resultText)}
              title="Insert this answer into the entry line"
              className="max-w-full overflow-x-auto overflow-y-hidden rounded-md px-1 py-1 text-right text-[1.15rem] hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <TeX tex={resultTex} label={resultText} />
            </button>
          ) : null}
          {decimalTex && (
            <span className="px-1 text-sm text-muted-foreground">
              ≈ <TeX tex={decimalTex} />
            </span>
          )}
          {entry.notes?.map((note, i) => (
            <span key={i} className="max-w-md px-1 text-right text-xs text-muted-foreground">
              {note}
            </span>
          ))}
        </div>
      </div>
      <div className="pointer-events-none absolute right-2 top-1 flex gap-0.5 rounded-md border border-border/60 bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <RowAction label="Edit entry" onClick={() => onUseInput(entry.input)}>
          <Undo2 className="size-3.5" aria-hidden />
        </RowAction>
        {resultText && (
          <RowAction label="Insert answer" onClick={() => onInsert(resultText)}>
            <ArrowDownToLine className="size-3.5" aria-hidden />
          </RowAction>
        )}
        {resultText && (
          <RowAction label="Copy answer" onClick={() => void navigator.clipboard?.writeText(resultText)}>
            <Copy className="size-3.5" aria-hidden />
          </RowAction>
        )}
        {!entry.approx && !entry.error && !entry.done && (
          <RowAction label="Approximate (≈)" onClick={() => onApprox(entry.input)}>
            <span className="text-xs font-semibold leading-none">≈</span>
          </RowAction>
        )}
        <RowAction label="Remove" onClick={onRemove}>
          {entry.error ? <X className="size-3.5" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
        </RowAction>
      </div>
    </li>
  );
});

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}
