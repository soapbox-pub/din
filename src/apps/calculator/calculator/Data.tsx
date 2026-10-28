import { useMemo, useRef, useState } from 'react';
import { LineChart } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parse } from './expr';
import { formatNumberText, toLatex, type NumberFormat } from './latex';
import { MODELS, oneVar, regress, type Model } from './stats';
import { runTest, TESTS, type Alternative, type TestId } from './tests';
import { evaluateNumber } from './compile';
import { TeX } from './TeX';
import { LIST_NAMES, listItems, listValues, type ScatterSettings } from './lists';

/**
 * The TI-89's Data/Matrix editor and its statistics: lists L1–L6 in
 * columns, 1-Var Stats and the regressions, with the fitted curve and a
 * scatter plot sent to the graph.
 */
export function Data({
  vars,
  format,
  scatter,
  onStore,
  onScatter,
  onGraphEquation,
}: {
  vars: Record<string, string>;
  format: NumberFormat;
  scatter: ScatterSettings;
  onStore: (name: string, items: string[]) => void;
  onScatter: (scatter: ScatterSettings) => void;
  onGraphEquation: (equation: string) => void;
}) {
  const columns = useMemo(() => LIST_NAMES.map((name) => listItems(vars[name])), [vars]);
  const rows = Math.max(12, ...columns.map((c) => c.length + 1));
  const grid = useRef<HTMLDivElement>(null);

  const focusCell = (col: number, row: number) => {
    grid.current?.querySelector<HTMLInputElement>(`[data-cell="${col}:${row}"]`)?.focus();
  };

  const commit = (col: number, row: number, text: string) => {
    const items = [...columns[col]];
    const value = text.trim();
    if (value === (items[row] ?? '')) return;
    if (value) {
      while (items.length < row) items.push('0');
      items[row] = value;
    } else if (row < items.length) {
      items.splice(row, 1);
    }
    onStore(LIST_NAMES[col], items);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div ref={grid} className="min-h-0 min-w-0 flex-1 overflow-auto">
        <table className="w-full max-w-5xl border-separate border-spacing-0 font-mono text-sm">
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur">
            <tr>
              <th className="w-10 border-b border-r border-border/60 px-2 py-1.5 text-xs font-normal text-muted-foreground" />
              {LIST_NAMES.map((name) => (
                <th key={name} scope="col" className="min-w-28 border-b border-r border-border/60 px-2 py-1.5 text-left font-semibold">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, row) => (
              <tr key={row}>
                <th scope="row" className="border-b border-r border-border/40 px-2 text-right text-xs font-normal text-muted-foreground">
                  {row + 1}
                </th>
                {columns.map((items, col) => (
                  <td key={LIST_NAMES[col]} className="border-b border-r border-border/40 p-0">
                    <Cell
                      key={`${items[row] ?? ''}`}
                      id={`${col}:${row}`}
                      value={items[row] ?? ''}
                      label={`${LIST_NAMES[col]} row ${row + 1}`}
                      onCommit={(text) => commit(col, row, text)}
                      onMove={(dc, dr) => focusCell(Math.min(Math.max(col + dc, 0), LIST_NAMES.length - 1), Math.max(row + dr, 0))}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <StatsPanel vars={vars} format={format} scatter={scatter} onScatter={onScatter} onGraphEquation={onGraphEquation} />
    </div>
  );
}

function Cell({
  id,
  value,
  label,
  onCommit,
  onMove,
}: {
  id: string;
  value: string;
  label: string;
  onCommit: (text: string) => void;
  onMove: (dc: number, dr: number) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <input
      data-cell={id}
      value={text}
      aria-label={label}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          onCommit(text);
          onMove(0, 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          onCommit(text);
          onMove(0, -1);
        } else if (e.key === 'Escape') {
          setText(value);
        }
      }}
      className="h-7 w-full min-w-28 bg-transparent px-2 text-right outline-none focus:bg-primary/10 focus:ring-2 focus:ring-inset focus:ring-ring"
    />
  );
}

function ListSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-24 rounded-md border border-input bg-background px-2 font-mono text-sm">
        {LIST_NAMES.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
    </label>
  );
}

function StatsPanel({
  vars,
  format,
  scatter,
  onScatter,
  onGraphEquation,
}: {
  vars: Record<string, string>;
  format: NumberFormat;
  scatter: ScatterSettings;
  onScatter: (scatter: ScatterSettings) => void;
  onGraphEquation: (equation: string) => void;
}) {
  const [kind, setKind] = useState<'one' | 'two' | 'tests'>('one');
  const [list, setList] = useState('L1');
  const [model, setModel] = useState<Model>('linear');
  const fmt = (v: number) => formatNumberText(v, format);

  const one = useMemo(() => {
    const values = listValues(vars[list]);
    if (values.length === 0) return `${list} is empty.`;
    if (values.some(Number.isNaN)) return `${list} has something that isn’t a number.`;
    return oneVar(values);
  }, [vars, list]);

  const fit = useMemo(() => {
    const xs = listValues(vars[scatter.x]);
    const ys = listValues(vars[scatter.y]);
    if (xs.length === 0 || ys.length === 0) return `Enter data in ${scatter.x} and ${scatter.y}.`;
    if (xs.some(Number.isNaN) || ys.some(Number.isNaN)) return 'Every entry needs to be a number.';
    return regress(model, xs, ys);
  }, [vars, scatter.x, scatter.y, model]);

  const equationTex = useMemo(() => {
    if (typeof fit === 'string') return null;
    try {
      return `y=${toLatex(parse(fit.equation), { format })}`;
    } catch {
      return null;
    }
  }, [fit, format]);

  return (
    <div className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border/60 bg-muted/20 p-3">
      <div className="flex rounded-lg bg-muted p-0.5" role="radiogroup" aria-label="Statistics">
        {(
          [
            ['one', '1-Var'],
            ['two', 'Regression'],
            ['tests', 'Tests'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={kind === id}
            onClick={() => setKind(id)}
            className={cn(
              'flex-1 rounded-md px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              kind === id ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {kind === 'tests' ? (
        <TestsPanel vars={vars} format={format} />
      ) : kind === 'one' ? (
        <>
          <ListSelect label="List" value={list} onChange={setList} />
          {typeof one === 'string' ? (
            <p className="text-sm text-muted-foreground">{one}</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-background p-3 font-mono text-sm tabular-nums">
              {(
                [
                  ['x̄', one.mean],
                  ['Σx', one.sum],
                  ['Σx²', one.sumSq],
                  ['Sx', one.sx],
                  ['σx', one.σx],
                  ['n', one.n],
                  ['minX', one.min],
                  ['Q1', one.q1],
                  ['Med', one.median],
                  ['Q3', one.q3],
                  ['maxX', one.max],
                ] as const
              ).map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd className="text-right">{fmt(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      ) : (
        <>
          <ListSelect label="X list" value={scatter.x} onChange={(x) => onScatter({ ...scatter, x })} />
          <ListSelect label="Y list" value={scatter.y} onChange={(y) => onScatter({ ...scatter, y })} />
          <label className="flex items-center justify-between gap-2 text-sm">
            Model
            <select value={model} onChange={(e) => setModel(e.target.value as Model)} className="h-8 w-36 rounded-md border border-input bg-background px-2 text-sm">
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <p className="font-mono text-xs text-muted-foreground">{MODELS.find((m) => m.id === model)?.form}</p>
          {typeof fit === 'string' ? (
            <p className="text-sm text-muted-foreground">{fit}</p>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background p-3">
              {equationTex && <TeX tex={equationTex} className="overflow-x-auto overflow-y-hidden text-base" />}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm tabular-nums">
                {fit.coefficients.map(([name, value]) => (
                  <div key={name} className="contents">
                    <dt className="text-muted-foreground">{name}</dt>
                    <dd className="text-right">{fmt(value)}</dd>
                  </div>
                ))}
                {fit.r !== undefined && (
                  <>
                    <dt className="text-muted-foreground">r</dt>
                    <dd className="text-right">{fmt(fit.r)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">R²</dt>
                <dd className="text-right">{fmt(fit.r2)}</dd>
              </dl>
              <button
                type="button"
                onClick={() => onGraphEquation(fit.equation)}
                className="mt-1 flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <LineChart className="size-3.5" aria-hidden /> Graph with the data
              </button>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={scatter.enabled} onChange={(e) => onScatter({ ...scatter, enabled: e.target.checked })} className="size-4 accent-primary" />
            Scatter plot of {scatter.x}, {scatter.y} on the graph
          </label>
        </>
      )}
      <p className="mt-auto text-xs text-muted-foreground">
        The lists are variables too: try <span className="font-mono">mean(L1)</span> or <span className="font-mono">{'{1,2,3}→L1'}</span> on the home screen.
      </p>
    </div>
  );
}

function TestsPanel({ vars, format }: { vars: Record<string, string>; format: NumberFormat }) {
  const [test, setTest] = useState<TestId>('ttest');
  const [input, setInput] = useState<'stats' | 'data'>('stats');
  const [lists, setLists] = useState<[string, string]>(['L1', 'L2']);
  const [values, setValues] = useState<Record<string, string>>({});
  const [alt, setAlt] = useState<Alternative>('≠');
  const [level, setLevel] = useState('0.95');
  const spec = TESTS.find((t) => t.id === test)!;
  const usesData = spec.fields.some((f) => f.data);
  const fromData = usesData && input === 'data';
  const fmt = (v: number) => formatNumberText(v, format);

  const result = useMemo(() => {
    const v: Record<string, number> = {};
    for (const f of spec.fields) v[f.key] = evaluateNumber(values[f.key] ?? '') ?? NaN;
    if (fromData) {
      // x̄, Sx and n from the lists, like the TI-89's Data input.
      const groups = test === 'tsamp2' ? [[lists[0], '1'], [lists[1], '2']] : [[lists[0], '']];
      for (const [name, suffix] of groups) {
        const data = listValues(vars[name]);
        if (data.length === 0 || data.some(Number.isNaN)) return `${name} needs numbers in it.`;
        const stats = oneVar(data);
        v[`mean${suffix}`] = stats.mean;
        v[`sx${suffix}`] = stats.sx;
        v[`n${suffix}`] = stats.n;
      }
    }
    const confidence = evaluateNumber(level) ?? NaN;
    if (!(confidence > 0 && confidence < 1)) return 'The confidence level is between 0 and 1, like 0.95.';
    return runTest(test, v, alt, confidence);
  }, [spec, values, fromData, test, lists, vars, alt, level]);

  const parameter = test === 'prop1' ? 'p' : test === 'prop2' ? 'p1' : test === 'tsamp2' ? 'μ1' : 'μ';
  const against = test === 'prop1' ? 'p₀' : test === 'prop2' ? 'p2' : test === 'tsamp2' ? 'μ2' : 'μ₀';
  const field = 'h-8 w-24 rounded-md border border-input bg-background px-2 text-right font-mono text-sm outline-none focus:border-ring';

  return (
    <>
      <select value={test} onChange={(e) => setTest(e.target.value as TestId)} aria-label="Test" className="h-8 rounded-md border border-input bg-background px-2 text-sm">
        {TESTS.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      {usesData && (
        <div className="flex rounded-lg bg-muted p-0.5 text-xs" role="radiogroup" aria-label="Input">
          {([['stats', 'Summary stats'], ['data', 'From lists']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={input === id}
              onClick={() => setInput(id)}
              className={cn('flex-1 rounded-md px-2 py-1 font-medium', input === id ? 'bg-background shadow-xs' : 'text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {fromData && (
        <>
          <ListSelect label={test === 'tsamp2' ? 'List 1' : 'List'} value={lists[0]} onChange={(l) => setLists([l, lists[1]])} />
          {test === 'tsamp2' && <ListSelect label="List 2" value={lists[1]} onChange={(l) => setLists([lists[0], l])} />}
        </>
      )}
      {spec.fields
        .filter((f) => !(fromData && f.data))
        .map((f) => (
          <label key={f.key} className="flex items-center justify-between gap-2 text-sm">
            {f.label}
            <input value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} spellCheck={false} className={field} />
          </label>
        ))}
      <label className="flex items-center justify-between gap-2 text-sm">
        Alternative
        <select value={alt} onChange={(e) => setAlt(e.target.value as Alternative)} className="h-8 w-24 rounded-md border border-input bg-background px-2 font-mono text-sm">
          {(['≠', '<', '>'] as const).map((a) => (
            <option key={a} value={a}>
              {parameter} {a} {against}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2 text-sm">
        C-Level
        <input value={level} onChange={(e) => setLevel(e.target.value)} spellCheck={false} className={field} />
      </label>
      {typeof result === 'string' ? (
        <p className="text-sm text-muted-foreground">{result}</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-background p-3 font-mono text-sm tabular-nums">
          {result.rows.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="text-right">{fmt(value)}</dd>
            </div>
          ))}
          <dt className="text-muted-foreground">Interval</dt>
          <dd className="text-right">
            ({fmt(result.interval[0])}, {fmt(result.interval[1])})
          </dd>
        </dl>
      )}
    </>
  );
}
