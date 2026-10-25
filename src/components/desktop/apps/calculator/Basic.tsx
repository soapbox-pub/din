import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Delete, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { compile } from './compile';
import { parse } from './expr';
import { formatNumberText } from './latex';
import { TAPE_LIMIT, type BasicState, type CalculatorView } from './state';

/**
 * The basic calculator: digits, the four operations, percent and a tape,
 * like the one on a phone. It works in plain numbers in the window itself,
 * so it never starts the advanced calculator's giac worker.
 */

/** A key's effect on the entry. */
type Key = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | '+' | '-' | '*' | '/' | '(' | ')' | '%' | 'neg' | 'back' | 'clear';

interface Entry {
  /** What's typed, in the entry line's language: 12*(3+4)%. */
  expr: string;
  /** The expression is the answer = just gave: a digit starts over, an operator continues. */
  answer: boolean;
  error?: string;
}

const EMPTY: Entry = { expr: '', answer: false };
const OPERATORS = '+-*/';
const FORMAT = { mode: 'float', digits: 12 } as const;

/** The number being typed at the end of an expression ('' if none). */
function trailingNumber(expr: string): string {
  return /(?:\d[\d.]*|\.[\d.]*)(?:ᴇ-?\d*)?$/.exec(expr)?.[0] ?? '';
}

function press(entry: Entry, key: Key): Entry {
  const expr = entry.answer && /^[\d.]$|^\($/.test(key) ? '' : entry.expr;
  const last = expr.at(-1) ?? '';
  const next = (text: string): Entry => ({ expr: text, answer: false });
  /** After ) or %, a number or ( means multiply. */
  const times = last === ')' || last === '%' ? '*' : '';

  if (/^\d$/.test(key)) {
    if (trailingNumber(expr) === '0') return next(expr.slice(0, -1) + key);
    return next(expr + times + key);
  }
  switch (key) {
    case '.': {
      const num = trailingNumber(expr);
      if (num.includes('.') || num.includes('ᴇ')) return entry;
      return next(expr + times + (num ? '.' : '0.'));
    }
    case '+':
    case '-':
    case '*':
    case '/': {
      if (expr === '' || last === '(') return key === '-' ? next(expr + '-') : entry;
      if (OPERATORS.includes(last)) {
        // A minus after × or ÷ is a negative number: 5×−3.
        if (key === '-' && (last === '*' || last === '/')) return next(expr + key);
        const base = expr.replace(/[+\-*/]+$/, '');
        if (base === '' || base.endsWith('(')) return key === '-' ? next(base + '-') : next(base);
        return next(base + key);
      }
      return next(expr + key);
    }
    case '(':
      return next(expr + (/[\d.)%]/.test(last) ? '*(' : '('));
    case ')': {
      const open = (expr.match(/\(/g) ?? []).length - (expr.match(/\)/g) ?? []).length;
      if (open <= 0 || last === '(' || OPERATORS.includes(last)) return entry;
      return next(expr + ')');
    }
    case '%':
      return /[\d.)]/.test(last) ? next(expr + '%') : entry;
    case 'neg': {
      const percent = expr.endsWith('%') ? 1 : 0;
      const num = trailingNumber(expr.slice(0, expr.length - percent));
      // Where the last number starts, or the next one will.
      const at = expr.length - percent - num.length;
      // A minus that's a sign (at the start, or after an operator or "(") comes off.
      if (expr[at - 1] === '-' && (at === 1 || /[+\-*/(]/.test(expr[at - 2]))) {
        return { ...entry, expr: expr.slice(0, at - 1) + expr.slice(at) };
      }
      if (!num && last !== '' && !OPERATORS.includes(last) && last !== '(') return entry;
      return { ...entry, expr: expr.slice(0, at) + '-' + expr.slice(at) };
    }
    case 'back':
      return next(entry.expr.slice(0, -1));
    case 'clear':
      return EMPTY;
  }
  return entry;
}

/** The expression ready to work out: trailing operators dropped, parentheses closed. */
function complete(expr: string): string {
  const text = expr.replace(/[+\-*/(]+$/, '');
  const open = (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length;
  return text + ')'.repeat(Math.max(open, 0));
}

function calculate(expr: string): number | undefined {
  try {
    return compile(parse(expr.replace(/%/g, '/100')), { variables: [] })({});
  } catch {
    return undefined;
  }
}

/** An expression as the display shows it: 12,345 × −3. */
function pretty(expr: string): string {
  const grouped = expr.replace(/(^|[^\d.])(\d{4,})/g, (_, lead: string, digits: string) => lead + digits.replace(/\B(?=(\d{3})+$)/g, ','));
  let out = '';
  for (let i = 0; i < grouped.length; i++) {
    const ch = grouped[i];
    if (ch === '*') out += ' × ';
    else if (ch === '/') out += ' ÷ ';
    else if (ch === '+') out += ' + ';
    else if (ch === '-') out += i > 0 && /[\d.)%]/.test(grouped[i - 1]) ? ' − ' : '−';
    else if (ch === 'ᴇ') out += 'e';
    else out += ch;
  }
  return out;
}

/** What the keyboard's keys do. */
function keyFor(e: React.KeyboardEvent): Key | '=' | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const k = e.key;
  if (/^[\d.+\-*/()%]$/.test(k)) return k as Key;
  if (k === ',') return '.';
  if (k === 'x' || k === 'X') return '*';
  if (k === 'Enter' || k === '=') return '=';
  if (k === 'Backspace') return 'back';
  if (k === 'Escape' || k === 'Delete') return 'clear';
  if (k === 'F9') return 'neg';
  return undefined;
}

interface Button {
  key: Key | '=';
  label: React.ReactNode;
  name: string;
  tone: 'num' | 'fn' | 'op' | 'eq';
}

const BUTTONS: Button[] = [
  { key: 'clear', label: 'AC', name: 'Clear', tone: 'fn' },
  { key: 'back', label: <Delete className="size-6" aria-hidden />, name: 'Backspace', tone: 'fn' },
  { key: '%', label: '%', name: 'Percent', tone: 'fn' },
  { key: '/', label: '÷', name: 'Divide', tone: 'op' },
  { key: '7', label: '7', name: '7', tone: 'num' },
  { key: '8', label: '8', name: '8', tone: 'num' },
  { key: '9', label: '9', name: '9', tone: 'num' },
  { key: '*', label: '×', name: 'Multiply', tone: 'op' },
  { key: '4', label: '4', name: '4', tone: 'num' },
  { key: '5', label: '5', name: '5', tone: 'num' },
  { key: '6', label: '6', name: '6', tone: 'num' },
  { key: '-', label: '−', name: 'Minus', tone: 'op' },
  { key: '1', label: '1', name: '1', tone: 'num' },
  { key: '2', label: '2', name: '2', tone: 'num' },
  { key: '3', label: '3', name: '3', tone: 'num' },
  { key: '+', label: '+', name: 'Plus', tone: 'op' },
  { key: 'neg', label: '±', name: 'Change sign', tone: 'num' },
  { key: '0', label: '0', name: '0', tone: 'num' },
  { key: '.', label: '.', name: 'Decimal point', tone: 'num' },
  { key: '=', label: '=', name: 'Equals', tone: 'eq' },
];

const TONES: Record<Button['tone'], string> = {
  num: 'border border-border/60 bg-card text-2xl hover:bg-accent',
  fn: 'bg-muted text-xl hover:bg-foreground/10',
  op: 'bg-foreground/10 text-3xl hover:bg-foreground/15',
  eq: 'bg-primary text-3xl text-primary-foreground hover:bg-primary/90',
};

export function Basic({
  tape,
  onTape,
  onView,
}: {
  tape: BasicState['tape'];
  onTape: (tape: BasicState['tape']) => void;
  onView: (view: CalculatorView) => void;
}) {
  const [entry, setEntry] = useState<Entry>(EMPTY);
  const [flash, setFlash] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tapeRef = useRef<HTMLOListElement>(null);

  useEffect(() => rootRef.current?.focus(), []);

  useLayoutEffect(() => {
    const el = tapeRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tape.length]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 120);
    return () => clearTimeout(timer);
  }, [flash]);

  const preview = useMemo(() => {
    if (entry.answer || entry.error || !/\d[+\-*/%]/.test(entry.expr)) return undefined;
    const value = calculate(complete(entry.expr));
    return value !== undefined && Number.isFinite(value) ? formatNumberText(value, FORMAT) : undefined;
  }, [entry]);

  const equals = () => {
    const expr = complete(entry.expr);
    if (!expr || entry.answer) return;
    const value = calculate(expr);
    if (value === undefined) {
      setEntry({ ...entry, error: 'Can’t calculate that' });
    } else if (!Number.isFinite(value)) {
      setEntry({ ...entry, error: Number.isNaN(value) ? 'Not a number' : 'Can’t divide by zero' });
    } else {
      const result = formatNumberText(value, FORMAT);
      onTape([...tape, { expr, result }].slice(-TAPE_LIMIT));
      setEntry({ expr: result, answer: true });
    }
  };

  const hit = (key: Key | '=') => {
    if (key === '=') equals();
    else setEntry((e) => press({ ...e, error: undefined }, key));
  };

  /** The number on show, for copying. */
  const current = entry.answer ? entry.expr : (preview ?? complete(entry.expr));

  const paste = (text: string) => {
    const chars = text
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/[−–]/g, '-')
      .replace(/[\s,]/g, '')
      .replace(/[eE](?=-?\d)/g, 'ᴇ');
    if (!/^[\d.+\-*/()%ᴇ]+$/.test(chars)) return;
    setEntry((e) => {
      let next: Entry = { ...e, error: undefined };
      for (const ch of chars) {
        next = ch === 'ᴇ' ? { ...next, expr: next.expr + ch } : press(next, ch as Key);
      }
      return next;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // A focused button handles its own Enter and Space.
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c') {
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      if (current) void navigator.clipboard?.writeText(current.replace(/ᴇ/g, 'e'));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      void navigator.clipboard?.readText().then(paste, () => {});
      return;
    }
    const key = keyFor(e);
    if (!key) return;
    e.preventDefault();
    hit(key);
    setFlash(key);
  };

  const shown = pretty(entry.expr) || '0';
  const size = shown.length <= 9 ? 'text-5xl' : shown.length <= 14 ? 'text-4xl' : shown.length <= 20 ? 'text-3xl' : 'text-2xl';

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex size-full min-h-0 flex-col bg-background text-foreground outline-none"
    >
      <div className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center justify-between px-3 pt-2">
          <ViewSwitch view="basic" onChange={onView} />
          {tape.length > 0 && (
            <button
              type="button"
              onClick={() => onTape([])}
              aria-label="Clear history"
              title="Clear history"
              className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          )}
        </div>

        <ol ref={tapeRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-2" aria-label="History">
          {tape.map((item, i) => (
            <li key={i}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setEntry({ expr: item.result, answer: true })}
                title="Use this answer"
                className="flex w-full flex-col items-end rounded-lg px-2 py-1.5 text-right hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="max-w-full break-all text-sm text-muted-foreground">{pretty(item.expr)} =</span>
                <span className="max-w-full break-all text-lg tabular-nums">{pretty(item.result)}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="shrink-0 px-5 pb-3 pt-1 text-right">
          <output
            aria-label="Display"
            className={cn('block break-all font-light leading-tight tabular-nums', size, entry.error && 'text-muted-foreground')}
          >
            {shown}
          </output>
          <div className="mt-1 min-h-7 text-lg tabular-nums" aria-live="polite">
            {entry.error ? (
              <span className="font-medium text-destructive">{entry.error}</span>
            ) : preview !== undefined ? (
              <span className="text-muted-foreground">= {pretty(preview)}</span>
            ) : null}
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-4 gap-2 px-3 pb-3" role="group" aria-label="Keypad">
          {BUTTONS.map((button) => (
            <button
              key={button.key}
              type="button"
              aria-label={button.name}
              title={button.name}
              // Keep focus on the calculator, where the keyboard works.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => hit(button.key)}
              className={cn(
                'grid h-14 select-none place-items-center rounded-xl shadow-xs transition-colors active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                TONES[button.tone],
                flash === button.key && 'ring-2 ring-ring/60',
              )}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Switches between the basic calculator and the advanced (TI-89) one. */
export function ViewSwitch({ view, onChange }: { view: CalculatorView; onChange: (view: CalculatorView) => void }) {
  return (
    <div className="flex shrink-0 rounded-lg bg-muted p-0.5" role="radiogroup" aria-label="Calculator">
      {(
        [
          ['basic', 'Basic', 'Everyday arithmetic'],
          ['advanced', 'Advanced', 'Algebra, calculus, graphs, tables and statistics'],
        ] as const
      ).map(([id, label, title]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={view === id}
          title={title}
          onClick={() => onChange(id)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            view === id ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
