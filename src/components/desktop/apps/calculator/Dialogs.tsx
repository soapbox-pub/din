import { useMemo, useState } from 'react';
import { Search, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DialogButton, Overlay } from '../files/Dialogs';
import { CATALOG, insertText, type CatalogEntry, type Category } from './catalog';
import { parse } from './expr';
import { tidy } from './present';
import { toLatex, type NumberFormat } from './latex';
import { TeX } from './TeX';
import type { Mode } from './state';

function DialogHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex rounded-lg bg-muted p-0.5" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === value}
            onClick={() => onChange(v)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              v === value ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The MODE screen. */
export function ModeDialog({ mode, onChange, onClose }: { mode: Mode; onChange: (mode: Mode) => void; onClose: () => void }) {
  const digitsValue = `${mode.digits.mode}:${mode.digits.digits}`;
  return (
    <Overlay label="Mode" onClose={onClose}>
      <DialogHeader title="Mode" onClose={onClose} />
      <div className="divide-y divide-border/40 px-4 py-2">
        <Choice label="Angle" value={mode.angle} options={[['rad', 'Radian'], ['deg', 'Degree']]} onChange={(angle) => onChange({ ...mode, angle })} />
        <Choice
          label="Exact/Approx"
          value={mode.exact}
          options={[['auto', 'Auto'], ['exact', 'Exact'], ['approx', 'Approx']]}
          onChange={(exact) => onChange({ ...mode, exact })}
        />
        <Choice
          label="Complex format"
          value={mode.complex}
          options={[['real', 'Real'], ['rectangular', 'a+bi']]}
          onChange={(complex) => onChange({ ...mode, complex })}
        />
        <div className="flex items-center justify-between gap-4 py-1.5">
          <label className="text-sm" htmlFor="calc-digits">
            Display digits
          </label>
          <select
            id="calc-digits"
            value={digitsValue}
            onChange={(e) => {
              const [m, d] = e.target.value.split(':');
              onChange({ ...mode, digits: { mode: m as 'float' | 'fix', digits: Number(d) } });
            }}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            {[6, 8, 10, 12].map((d) => (
              <option key={`f${d}`} value={`float:${d}`}>
                Float {d}
              </option>
            ))}
            {[0, 1, 2, 3, 4, 5, 6].map((d) => (
              <option key={`x${d}`} value={`fix:${d}`}>
                Fix {d}
              </option>
            ))}
          </select>
        </div>
        <p className="py-2 text-xs text-muted-foreground">
          Auto keeps answers exact (√2, π/4, 1/3) unless the entry has a decimal point. Ctrl+Enter or ≈ always gives a decimal.
        </p>
      </div>
      <div className="flex justify-end border-t border-border/60 px-4 py-3">
        <DialogButton variant="primary" onClick={onClose}>
          Done
        </DialogButton>
      </div>
    </Overlay>
  );
}

const CATEGORIES: (Category | 'All')[] = [
  'All',
  'Algebra',
  'Calculus',
  'Numbers',
  'Trigonometry',
  'Lists & Statistics',
  'Probability',
  'Matrices & Vectors',
  'Complex',
  'Units',
  'Other',
];

/** CATALOG: every function, what it does, and an example to try. */
export function CatalogDialog({ onInsert, onTry, onClose }: { onInsert: (text: string) => void; onTry: (example: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'All'>('All');
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CATALOG.filter(
      (e) =>
        (category === 'All' || e.category === category) &&
        (!q || e.name.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q)),
    );
  }, [query, category]);

  return (
    <Overlay label="Catalog" onClose={onClose} className="h-[min(640px,100%)] max-w-2xl">
      <DialogHeader title="Catalog" onClose={onClose} />
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search functions — “derivative”, “matrix”, “mean”…"
            aria-label="Search the catalog"
            className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm outline-none focus:border-ring"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && entries[0]) {
                onInsert(insertText(entries[0]));
                onClose();
              }
            }}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={c === category}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                c === category ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto">
        {entries.map((entry) => (
          <CatalogRow
            key={entry.name}
            entry={entry}
            onInsert={() => {
              onInsert(insertText(entry));
              onClose();
            }}
            onTry={
              entry.example
                ? () => {
                    onTry(entry.example!);
                    onClose();
                  }
                : undefined
            }
          />
        ))}
        {entries.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">Nothing matches.</li>}
      </ul>
    </Overlay>
  );
}

function CatalogRow({ entry, onInsert, onTry }: { entry: CatalogEntry; onInsert: () => void; onTry?: () => void }) {
  return (
    <li className="flex items-start gap-3 px-4 py-2.5 hover:bg-foreground/[0.03]">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm">
          <span className="font-semibold">{entry.name}</span>
          {entry.args && <span className="text-muted-foreground">({entry.args.join(', ')})</span>}
        </p>
        <p className="text-xs text-muted-foreground">{entry.desc}</p>
        {entry.example && <p className="mt-0.5 font-mono text-xs text-foreground/70">{entry.example}</p>}
      </div>
      <div className="flex shrink-0 gap-1">
        {onTry && (
          <DialogButton onClick={onTry} className="h-7 text-xs">
            Try
          </DialogButton>
        )}
        <DialogButton variant="primary" onClick={onInsert} className="h-7 text-xs">
          Insert
        </DialogButton>
      </div>
    </li>
  );
}

/** VAR-LINK: the variables and functions stored in this session. */
export function VarsDialog({
  vars,
  format,
  onInsert,
  onDelete,
  onClose,
}: {
  vars: Record<string, string>;
  format: NumberFormat;
  onInsert: (name: string) => void;
  onDelete: (names: string[]) => void;
  onClose: () => void;
}) {
  const names = Object.keys(vars).sort((a, b) => a.localeCompare(b));
  return (
    <Overlay label="Variables" onClose={onClose} className="max-w-lg">
      <DialogHeader title="Variables" onClose={onClose} />
      {names.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-muted-foreground">
          Nothing stored yet. Store with → (5→a) or Define f(x)=…
        </p>
      ) : (
        <ul className="max-h-96 divide-y divide-border/40 overflow-y-auto">
          {names.map((name) => (
            <li key={name} className="flex items-center gap-3 px-4 py-2">
              <button type="button" onClick={() => onInsert(name)} className="min-w-0 flex-1 text-left" title="Insert the name">
                <span className="font-mono text-sm font-semibold">{name}</span>
                <span className="ml-3 text-sm">
                  <VarValue text={vars[name]} format={format} />
                </span>
              </button>
              <button
                type="button"
                aria-label={`Delete ${name}`}
                onClick={() => onDelete([name])}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-between border-t border-border/60 px-4 py-3">
        <DialogButton variant="destructive" disabled={names.length === 0} onClick={() => onDelete(names)}>
          Delete all
        </DialogButton>
        <DialogButton variant="primary" onClick={onClose}>
          Done
        </DialogButton>
      </div>
    </Overlay>
  );
}

function VarValue({ text, format }: { text: string; format: NumberFormat }) {
  const tex = useMemo(() => {
    try {
      const node = tidy(parse(text, { giac: true }));
      // A list of numbers is a TI list: {1,2,3}.
      const shown = node.t === 'list' && node.kind === 'bracket' && !node.items.some((i) => i.t === 'list') ? { ...node, kind: 'brace' as const } : node;
      return toLatex(shown, { format });
    } catch {
      return null;
    }
  }, [text, format]);
  return tex ? <TeX tex={tex} /> : <span className="font-mono text-xs">{text}</span>;
}

/** A grid for typing a matrix, which goes into the entry line as [a,b;c,d]. */
export function MatrixDialog({ onInsert, onClose }: { onInsert: (text: string) => void; onClose: () => void }) {
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const [cells, setCells] = useState<string[][]>(() => Array.from({ length: 6 }, () => Array(6).fill('')));

  const text = `[${cells
    .slice(0, rows)
    .map((row) => row.slice(0, cols).map((c) => c.trim() || '0').join(','))
    .join(';')}]`;

  return (
    <Overlay label="Matrix" onClose={onClose} className="max-w-lg">
      <DialogHeader title="New matrix" onClose={onClose} />
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            Rows
            <select value={rows} onChange={(e) => setRows(Number(e.target.value))} className="h-8 rounded-md border border-input bg-background px-2">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            Columns
            <select value={cols} onChange={(e) => setCols(Number(e.target.value))} className="h-8 rounded-md border border-input bg-background px-2">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid gap-1.5 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${cols}, minmax(3.5rem, 1fr))` }}>
          {cells.slice(0, rows).map((row, i) =>
            row.slice(0, cols).map((cell, j) => (
              <input
                key={`${i}:${j}`}
                autoFocus={i === 0 && j === 0}
                value={cell}
                placeholder="0"
                aria-label={`Row ${i + 1}, column ${j + 1}`}
                onChange={(e) => setCells(cells.map((r, a) => (a === i ? r.map((c, b) => (b === j ? e.target.value : c)) : r)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onInsert(text);
                    onClose();
                  }
                }}
                className="h-9 rounded-md border border-input bg-background px-2 text-center font-mono text-sm outline-none focus:border-ring"
              />
            )),
          )}
        </div>
        <p className="font-mono text-xs text-muted-foreground">{text}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-border/60 px-4 py-3">
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton
          variant="primary"
          onClick={() => {
            onInsert(text);
            onClose();
          }}
        >
          Insert
        </DialogButton>
      </div>
    </Overlay>
  );
}
