import { useMemo, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parse } from './expr';
import { evaluateNumber } from './compile';
import { TeX } from './TeX';
import { plotNames, type CompiledPlot, type GraphKind } from './plots';
import { PLOT_COLORS, type GraphWindow, type Plot } from './state';
import { formatNumberText, toLatex } from './latex';

const KIND_LABELS: Record<GraphKind, [string, string]> = {
  function: ['y(x)', 'Functions'],
  parametric: ['Param', 'Parametric'],
  polar: ['Polar', 'Polar'],
  de: ['y′', 'Differential equations (slope fields)'],
  surface: ['3D', '3D surfaces'],
};

const PLACEHOLDERS: Record<GraphKind, string> = {
  function: 'in terms of x',
  parametric: 'in terms of t',
  polar: 'in terms of θ',
  de: 'in terms of x and y',
  surface: 'in terms of x and y',
};

/** The Y= editor and the Window settings, beside the graph. */
export function YEditor({
  kind,
  plots,
  compiled,
  window,
  degrees,
  userFunctions,
  onKind,
  onPlots,
  onWindow,
  onFocusField,
}: {
  kind: GraphKind;
  plots: Plot[];
  compiled: CompiledPlot[];
  window: GraphWindow;
  degrees: boolean;
  userFunctions: ReadonlySet<string>;
  onKind: (kind: GraphKind) => void;
  onPlots: (plots: Plot[]) => void;
  onWindow: (window: GraphWindow) => void;
  onFocusField: (insert: (text: string) => void) => void;
}) {
  const [windowOpen, setWindowOpen] = useState(false);
  const errors = useMemo(() => new Map(compiled.map((c) => [c.id, c.error])), [compiled]);

  const update = (id: number, change: Partial<Plot>) => onPlots(plots.map((p) => (p.id === id ? { ...p, ...change } : p)));

  const add = () => {
    const id = Math.max(0, ...plots.map((p) => p.id)) + 1;
    const color = PLOT_COLORS[plots.length % PLOT_COLORS.length];
    onPlots([...plots, { id, exprs: kind === 'parametric' || kind === 'de' ? ['', ''] : [''], enabled: true, color }]);
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 p-2" role="radiogroup" aria-label="Graph type">
        {(Object.keys(KIND_LABELS) as GraphKind[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={k === kind}
            title={KIND_LABELS[k][1]}
            aria-label={KIND_LABELS[k][1]}
            onClick={() => onKind(k)}
            className={cn(
              'flex-1 rounded-md px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              k === kind ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
            )}
          >
            {KIND_LABELS[k][0]}
          </button>
        ))}
      </div>

      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {plots.map((plot, index) => {
          const names = plotNames(kind, index);
          const error = errors.get(plot.id);
          return (
            <li key={plot.id} className="group rounded-lg border border-border/50 bg-background p-1.5 shadow-xs">
              {plot.exprs.map((expr, i) => (
                <PlotField
                  key={i}
                  fieldId={names[i] ?? `${names[0]}-ic`}
                  name={kind === 'de' && i === 1 ? 'y(x₀)' : names[i]}
                  placeholder={kind === 'de' && i === 1 ? 'x₀, y₀ (optional)' : PLACEHOLDERS[kind]}
                  value={expr}
                  color={plot.color}
                  enabled={plot.enabled}
                  showToggle={i === 0}
                  userFunctions={userFunctions}
                  onToggle={() => update(plot.id, { enabled: !plot.enabled })}
                  onChange={(value) => update(plot.id, { exprs: plot.exprs.map((e, j) => (j === i ? value : e)) })}
                  onFocusField={onFocusField}
                />
              ))}
              {error && plot.exprs.some((e) => e.trim()) && (
                <p className="px-1 pt-1 text-xs text-destructive">{error}</p>
              )}
              {plots.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove ${names[0]}`}
                  onClick={() => onPlots(plots.filter((p) => p.id !== plot.id))}
                  className="float-right -mt-0.5 hidden rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground group-hover:block focus-visible:block"
                >
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={add}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border py-1.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" aria-hidden /> Add
          </button>
        </li>
      </ol>

      <div className="shrink-0 border-t border-border/60">
        <button
          type="button"
          onClick={() => setWindowOpen((o) => !o)}
          aria-expanded={windowOpen}
          className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          Window
          <ChevronDown className={cn('size-3.5 motion-safe:transition-transform', windowOpen && 'rotate-180')} aria-hidden />
        </button>
        {windowOpen && <WindowFields kind={kind} window={window} degrees={degrees} onWindow={onWindow} />}
      </div>
    </div>
  );
}

function PlotField({
  fieldId,
  name,
  placeholder,
  value,
  color,
  enabled,
  showToggle,
  userFunctions,
  onToggle,
  onChange,
  onFocusField,
}: {
  fieldId: string;
  name: string;
  placeholder: string;
  value: string;
  color: string;
  enabled: boolean;
  showToggle: boolean;
  userFunctions: ReadonlySet<string>;
  onToggle: () => void;
  onChange: (value: string) => void;
  onFocusField: (insert: (text: string) => void) => void;
}) {
  const [focused, setFocused] = useState(false);
  const tex = useMemo(() => {
    if (!value.trim() || focused) return null;
    try {
      return toLatex(parse(value, { userFunctions }));
    } catch {
      return null;
    }
  }, [value, focused, userFunctions]);

  return (
    <div className="flex items-center gap-1.5">
      {showToggle ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={enabled}
          aria-label={`Graph ${name}`}
          onClick={onToggle}
          className="grid size-5 shrink-0 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className="size-3.5 rounded-full border-2"
            style={{ borderColor: color, backgroundColor: enabled ? color : 'transparent' }}
          />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <label className="w-10 shrink-0 font-mono text-xs text-muted-foreground" htmlFor={`plot-${fieldId}`}>
        {name}=
      </label>
      <div className="relative min-w-0 flex-1">
        <input
          id={`plot-${fieldId}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => {
            setFocused(true);
            const el = e.currentTarget;
            onFocusField((text) => {
              const start = el.selectionStart ?? el.value.length;
              const end = el.selectionEnd ?? el.value.length;
              const next = el.value.slice(0, start) + text + el.value.slice(end);
              onChange(next);
              requestAnimationFrame(() => {
                el.focus();
                el.setSelectionRange(start + text.length, start + text.length);
              });
            });
          }}
          onBlur={() => setFocused(false)}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          className={cn(
            'h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 font-mono text-sm outline-none placeholder:text-muted-foreground/50 hover:border-border focus:border-ring focus:bg-background',
            tex && 'text-transparent caret-foreground',
          )}
        />
        {tex && (
          <span className="pointer-events-none absolute inset-y-0 left-1.5 right-0 flex items-center overflow-hidden whitespace-nowrap text-sm">
            <TeX tex={tex} />
          </span>
        )}
      </div>
    </div>
  );
}

function WindowFields({
  kind,
  window,
  degrees,
  onWindow,
}: {
  kind: GraphKind;
  window: GraphWindow;
  degrees: boolean;
  onWindow: (window: GraphWindow) => void;
}) {
  const fields: (keyof GraphWindow)[] = ['xmin', 'xmax', 'xscl', 'ymin', 'ymax', 'yscl'];
  if (kind === 'parametric') fields.push('tmin', 'tmax', 'tstep');
  if (kind === 'polar') fields.push('θmin', 'θmax', 'θstep');
  return (
    <div className="grid grid-cols-3 gap-x-2 gap-y-1.5 px-3 pb-3">
      {fields.map((field) => (
        <NumberField key={`${field}:${window[field]}`} label={field} value={window[field]} onCommit={(v) => onWindow({ ...window, [field]: v })} />
      ))}
      {kind === 'polar' && degrees && <p className="col-span-3 text-[0.7rem] text-muted-foreground">θ in degrees</p>}
    </div>
  );
}

/** A number box that accepts expressions like 2π or -π/2. */
export function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(() => formatNumberText(value, { mode: 'float', digits: 8 }));
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    const parsed = evaluateNumber(text);
    if (parsed === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <label className="flex flex-col gap-0.5 text-[0.7rem] text-muted-foreground">
      {label}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        aria-invalid={invalid}
        spellCheck={false}
        className="h-7 rounded-md border border-input bg-background px-1.5 font-mono text-xs text-foreground outline-none focus:border-ring aria-[invalid=true]:border-destructive"
      />
    </label>
  );
}
