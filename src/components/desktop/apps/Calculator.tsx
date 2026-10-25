import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BookOpen, Calculator as CalculatorIcon, ChevronDown, Grid2x2, Keyboard, LineChart, ListOrdered, Settings2, Table2, Variable } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AppComponentProps } from '@/lib/apps';
import { cn } from '@/lib/utils';
import { BreakError, Cas } from './calculator/cas';
import { catalogEntry, HOME_MENUS, insertText } from './calculator/catalog';
import { CatalogDialog, MatrixDialog, ModeDialog, VarsDialog } from './calculator/Dialogs';
import { identifiers, parse, ParseError, unparen, type Node } from './calculator/expr';
import { Data } from './calculator/Data';
import { Graph } from './calculator/Graph';
import { Surface } from './calculator/Surface';
import { listValues } from './calculator/lists';
import { dataWindow } from './calculator/numeric';
import { Home, type EntryApi } from './calculator/Home';
import { Keypad } from './calculator/Keypad';
import { usePlotFunctions, plotNames, type GraphKind } from './calculator/plots';
import { definesFunction, tidy } from './calculator/present';
import { HISTORY_LIMIT, loadState, PLOT_COLORS, saveState, type CalculatorState, type HistoryEntry, type Mode } from './calculator/state';
import { Table } from './calculator/Table';
import { toGiac, TranslateError, type GiacContext } from './calculator/toGiac';
import { YEditor } from './calculator/YEditor';

type Screen = 'home' | 'graph' | 'table' | 'data';

/** How many recent answers a fresh giac session gets back, for ans(n). */
const RESTORED_ANSWERS = 30;

/** Solvers that are meant to give complex answers in REAL mode. */
const COMPLEX_FUNCTIONS = new Set(['csolve', 'czeros', 'cfactor', 'real', 'imag', 'conj', 'angle', 're', 'im', 'arg', 'abs']);

const GRAPH_LABELS: Record<GraphKind, string> = { function: 'FUNC', parametric: 'PAR', polar: 'POL', de: 'DE', surface: '3D' };
const GRAPH_ORDER: GraphKind[] = ['function', 'parametric', 'polar', 'de', 'surface'];

/** Whether an entry stores, defines or deletes something. */
function changesVariables(node: Node): boolean {
  const n = unparen(node);
  if (n.t === 'define' || n.t === 'cmd') return true;
  if (n.t === 'bin' && (n.op === '→' || n.op === ':=')) return true;
  if (n.t === 'call' && ['purge', 'delvar'].includes(n.f.toLowerCase())) return true;
  return false;
}

/** What a fresh giac session needs to pick up where the saved calculator left off. */
function sessionSetup(): string[] {
  const s = loadState();
  const answers = s.history.filter((h) => h.result !== undefined).slice(-RESTORED_ANSWERS);
  return [
    `angle_radian:=${s.mode.angle === 'rad' ? 1 : 0}`,
    ...Object.entries(s.vars).map(([name, value]) => `${name}:=(${value})`),
    ...answers.map((h) => `dinA${h.id}:=(${h.result})`),
  ];
}

/** Functions whose answer is a particular form, which simplifying would undo. */
const FORM_FUNCTIONS = new Set([
  'factor', 'ifactor', 'expand', 'propfrac', 'comdenom', 'partfrac', 'texpand', 'tcollect', 'cfactor', 'collect',
  'lnexpand', 'lncollect', 'taylor', 'series', 'exact', 'getnum', 'getdenom', 'string',
]);

/** Functions whose second argument (and deSolve's third) is a variable to work in. */
const VARIABLE_FUNCTIONS = new Set([
  'solve', 'csolve', 'zeros', 'czeros', 'nsolve', 'fsolve', 'd', 'diff', '∫', 'integrate', 'int',
  'limit', 'σ', 'sum', 'π', 'product', 'taylor', 'fmin', 'fmax', 'arclen', 'desolve', 'series',
  'nint', 'nderiv', 'avgrc', 'tangentline', 'factor', 'expand',
]);

/**
 * The classic TI-89 trap: solve(x^2=4,x) after 3→x. Names the stored
 * variable an entry wants to work in, so the error can say what to do.
 */
function storedVariable(node: Node, vars: Record<string, string>): string | undefined {
  const n = unparen(node);
  if (n.t !== 'call' || !VARIABLE_FUNCTIONS.has(n.f.toLowerCase())) return undefined;
  const candidates = n.f.toLowerCase() === 'desolve' ? n.args.slice(1, 3) : n.args.slice(1, 2);
  for (const arg of candidates) {
    const a = unparen(arg);
    const names = a.t === 'list' ? a.items.map(unparen) : [a.t === 'bin' && a.op === '=' ? unparen(a.a) : a];
    for (const name of names) if (name.t === 'id' && vars[name.name] !== undefined) return name.name;
  }
  return undefined;
}

/** Whether an entry has a decimal number in it (2.5, 1ᴇ3). */
function hasDecimal(node: Node): boolean {
  switch (node.t) {
    case 'num':
      return /[.e]/i.test(node.v);
    case 'call':
      return node.args.some(hasDecimal);
    case 'bin':
      return hasDecimal(node.a) || hasDecimal(node.b);
    case 'neg':
    case 'not':
    case 'post':
    case 'paren':
      return hasDecimal(node.a);
    case 'list':
      return node.items.some(hasDecimal);
    default:
      return false;
  }
}

function topFunction(node: Node): string | undefined {
  const n = unparen(node);
  if (n.t === 'call') return n.f.toLowerCase();
  if (n.t === 'bin' && (n.op === '|' || n.op === '→')) return topFunction(n.a);
  return undefined;
}

/**
 * Calculator - a graphing calculator with a computer algebra system, built
 * to stand in for a TI-89: the home screen's exact answers (solve, factor,
 * d, ∫, limit, Σ, deSolve, matrices, units), the Y= editor and graph with
 * its Zoom, Trace and Math tools, and the table. Giac does the algebra, in
 * a worker (see calculator/cas.ts); the entry line speaks TI-89.
 */
export function Calculator(_props: AppComponentProps) {
  const [state, setState] = useState<CalculatorState>(loadState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [screen, setScreen] = useState<Screen>('home');
  const [dialog, setDialog] = useState<'mode' | 'catalog' | 'vars' | 'matrix' | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // The worker starts on first use, so StrictMode's extra render costs nothing.
  const [cas] = useState(() => new Cas(sessionSetup));
  const [revision, setRevision] = useState(0);
  const entryApi = useRef<EntryApi | null>(null);
  /** Where the keypad and catalog type: the entry line, or the Y= field last focused. */
  const inserter = useRef<((text: string) => void) | null>(null);

  // Save, a moment after the last change (panning the graph changes it a lot).
  useEffect(() => {
    const timer = setTimeout(() => saveState(state), 400);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => () => saveState(stateRef.current), []);

  useEffect(() => () => cas.dispose(), [cas]);

  /** Stop the running command. The new session restores from what's saved, so save now. */
  const breakNow = useCallback(() => {
    saveState(stateRef.current);
    cas.break();
  }, [cas]);

  const busy = useSyncExternalStore(
    useCallback((listener: () => void) => cas.subscribe(listener), [cas]),
    () => cas.busy,
  );

  const userFunctions = useMemo(() => {
    const names = new Set<string>();
    for (const [name, value] of Object.entries(state.vars)) if (value.includes('->')) names.add(name);
    for (const kind of GRAPH_ORDER) {
      state.plots[kind].forEach((_, i) => plotNames(kind, i).forEach((n) => names.add(n)));
    }
    return names;
  }, [state.vars, state.plots]);

  const ctx: GiacContext = useMemo(
    () => ({
      angle: state.mode.angle,
      isList: (name) => /^\[(?!\[)/.test(state.vars[name] ?? ''),
      ans: (k) => {
        const answered = state.history.filter((h) => h.result !== undefined);
        const entry = answered[answered.length - k];
        return entry ? `dinA${entry.id}` : undefined;
      },
      entry: (k) => {
        const entry = state.history[state.history.length - k];
        try {
          return entry ? parse(entry.input, { userFunctions }) : undefined;
        } catch {
          return undefined;
        }
      },
    }),
    [state.mode.angle, state.history, state.vars, userFunctions],
  );

  const kind = state.mode.graph;
  const plots = state.plots[kind];
  const compiled = usePlotFunctions({
    cas,
    kind,
    plots,
    degrees: state.mode.angle === 'deg',
    ctx,
    userFunctions,
    revision,
  });
  const scatterPoints = useMemo(() => {
    if (!state.scatter.enabled) return [];
    const xs = listValues(state.vars[state.scatter.x]);
    const ys = listValues(state.vars[state.scatter.y]);
    return xs.map((x, i) => ({ x, y: ys[i] })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }, [state.scatter, state.vars]);
  const enabledIds = useMemo(() => new Set(plots.filter((p) => p.enabled).map((p) => p.id)), [plots]);

  const update = useCallback((change: Partial<CalculatorState> | ((s: CalculatorState) => Partial<CalculatorState>)) => {
    setState((s) => ({ ...s, ...(typeof change === 'function' ? change(s) : change) }));
  }, []);

  const refreshVariables = useCallback(async () => {
    try {
      const vars = await cas.variables();
      update({ vars });
      setRevision((r) => r + 1);
    } catch {
      // Keep the last known list.
    }
  }, [cas, update]);

  const addEntry = useCallback(
    (entry: HistoryEntry) => {
      update((s) => {
        const history = [...s.history, entry];
        const dropped = history.length > HISTORY_LIMIT ? history.splice(0, history.length - HISTORY_LIMIT) : [];
        if (dropped.length) void cas.run([`purge(${dropped.map((h) => `dinA${h.id}`).join(',')})`]).catch(() => {});
        return { history };
      });
    },
    [cas, update],
  );

  const evaluate = useCallback(
    async (input: string, approx: boolean) => {
      const s = stateRef.current;
      const id = s.nextId;
      update({ nextId: id + 1 });
      const fail = (error: string) => addEntry({ id, input, approx, error });

      let ast: Node;
      try {
        ast = parse(input, { userFunctions });
      } catch (error) {
        fail(error instanceof ParseError ? error.message : 'Syntax error');
        return;
      }

      if (ast.t === 'cmd' && ast.name === 'clrhome') {
        const ids = s.history.map((h) => `dinA${h.id}`);
        update({ history: [] });
        if (ids.length) void cas.run([`purge(${ids.join(',')})`]).catch(() => {});
        return;
      }
      if (ast.t === 'cmd' && ast.name === 'newprob') {
        const letters = Object.keys(s.vars).filter((name) => name.length === 1);
        if (letters.length) await cas.run([`purge(${letters.join(',')})`]).catch(() => {});
        await refreshVariables();
        addEntry({ id, input, approx, done: true });
        return;
      }

      const stored = storedVariable(ast, s.vars);
      if (stored) {
        fail(`${stored} has a value stored in it (${s.vars[stored]}). Clear it with DelVar ${stored}, or NewProb to clear a–z.`);
        return;
      }

      let code: string;
      try {
        code = toGiac(ast, ctx);
      } catch (error) {
        fail(error instanceof TranslateError ? error.message : 'Can’t do that');
        return;
      }
      const assigns = changesVariables(ast);
      if (s.mode.exact === 'exact' && !assigns && !approx) code = `exact(${code})`;
      // AUTO, like a TI-89: an entry with a decimal point gets a decimal answer.
      const useApprox = approx || s.mode.exact === 'approx' || (s.mode.exact === 'auto' && !assigns && hasDecimal(ast));

      let result;
      try {
        result = await cas.evaluate(code, `dinA${id}`, useApprox, !FORM_FUNCTIONS.has(topFunction(ast) ?? ''));
      } catch (error) {
        fail(error instanceof BreakError ? 'Break' : error instanceof Error ? error.message : 'Error');
        if (error instanceof BreakError) setRevision((r) => r + 1);
        return;
      }
      if (result.error || result.exact === undefined) {
        fail(result.error ?? 'Error');
        return;
      }

      // REAL mode, like a TI-89: √(-4) is an error unless you asked for complex numbers.
      if (s.mode.complex === 'real' && !COMPLEX_FUNCTIONS.has(topFunction(ast) ?? '') && !identifiers(ast).has('i')) {
        try {
          if (identifiers(tidy(parse(result.exact, { giac: true }))).has('i')) {
            fail('Non-real result. Use cSolve, or set Complex format to a+bi in Mode.');
            return;
          }
        } catch {
          // Unparseable output: show it as it is.
        }
      }

      addEntry({
        id,
        input,
        approx: useApprox,
        result: result.exact,
        decimal: result.decimal,
        notes: result.messages.length ? result.messages.slice(0, 2) : undefined,
        done: definesFunction(ast) || undefined,
      });
      if (assigns) await refreshVariables();
    },
    [cas, ctx, userFunctions, update, addEntry, refreshVariables],
  );

  const setMode = (mode: Mode) => {
    const previous = stateRef.current.mode;
    let window = stateRef.current.window;
    if (mode.angle !== previous.angle) {
      void cas.run([`angle_radian:=${mode.angle === 'rad' ? 1 : 0}`]).catch(() => {});
      // θ and t windows are in the angle unit.
      const k = mode.angle === 'deg' ? 180 / Math.PI : Math.PI / 180;
      window = { ...window, θmin: window.θmin * k, θmax: window.θmax * k, θstep: window.θstep * k, tmin: window.tmin, tmax: window.tmax };
    }
    update({ mode, window });
  };

  const insert = useCallback((text: string) => {
    if (inserter.current) inserter.current(text);
    else entryApi.current?.insert(text);
  }, []);

  const insertFromMenu = (name: string) => {
    const entry = catalogEntry(name);
    if (!entry) return;
    if (screen !== 'home') setScreen('home');
    inserter.current = null;
    requestAnimationFrame(() => entryApi.current?.insert(insertText(entry)));
  };

  const storeList = async (name: string, items: string[]) => {
    let code = `purge(${name})`;
    if (items.length) {
      try {
        code = `${name}:=[${items.map((item) => toGiac(parse(item, { userFunctions }), ctx)).join(',')}]`;
      } catch {
        return;
      }
    }
    await cas.run([code]).catch(() => {});
    await refreshVariables();
  };

  /** A regression from the data editor: into the first free y=, graphed over the data. */
  const graphEquation = (equation: string) => {
    const s = stateRef.current;
    const functions = s.plots.function;
    const free = functions.findIndex((p) => !p.exprs[0].trim());
    const next = free === -1
      ? [...functions, { id: Math.max(0, ...functions.map((p) => p.id)) + 1, exprs: [equation], enabled: true, color: PLOT_COLORS[functions.length % PLOT_COLORS.length] }]
      : functions.map((p, i) => (i === free ? { ...p, exprs: [equation], enabled: true } : p));
    const xs = listValues(s.vars[s.scatter.x]);
    const ys = listValues(s.vars[s.scatter.y]);
    const points = xs.map((x, i) => ({ x, y: ys[i] })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    update({
      plots: { ...s.plots, function: next },
      mode: { ...s.mode, graph: 'function' },
      scatter: { ...s.scatter, enabled: true },
      window: points.length ? { ...s.window, ...dataWindow(points) } : s.window,
    });
    setScreen('graph');
  };

  const deleteVars = async (names: string[]) => {
    if (names.length === 0) return;
    await cas.run([`purge(${names.join(',')})`]).catch(() => {});
    await refreshVariables();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const fkey = /^F([1-6])$/.exec(e.key);
    if (fkey && screen === 'home' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setOpenMenu(e.key);
    }
  };

  const { mode } = state;
  const answered = state.history.length;

  return (
    <div className="@container flex size-full min-h-0 flex-col bg-background text-foreground" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 bg-muted/40 px-2 py-1.5">
        <div className="flex shrink-0 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Screen">
          {(
            [
              ['home', 'Home', CalculatorIcon],
              ['graph', 'Graph', LineChart],
              ['table', 'Table', Table2],
              ['data', 'Data', ListOrdered],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={screen === id}
              onClick={() => {
                setScreen(id);
                inserter.current = null;
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                screen === id ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {screen === 'home' && (
          <div className="ml-1 flex shrink-0 items-center">
            <DropdownMenu open={openMenu === 'F1'} onOpenChange={(open) => setOpenMenu(open ? 'F1' : null)}>
              <MenuTrigger fkey="F1" label="Tools" />
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => setDialog('matrix')}>New matrix…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog('catalog')}>Catalog…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog('vars')}>Variables…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void evaluate('NewProb', false)}>
                  NewProb <DropdownMenuShortcut>clears a–z</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void evaluate('ClrHome', false)}>Clear home</DropdownMenuItem>
                {busy && <DropdownMenuItem onSelect={() => breakNow()}>Break</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
            {HOME_MENUS.map((menu) => (
              <DropdownMenu key={menu.key} open={openMenu === menu.key} onOpenChange={(open) => setOpenMenu(open ? menu.key : null)}>
                <MenuTrigger fkey={menu.key} label={menu.label} />
                <DropdownMenuContent align="start" className="max-h-96">
                  {menu.items.map((name, i) => {
                    if (name === null) return <DropdownMenuSeparator key={`sep${i}`} />;
                    const entry = catalogEntry(name);
                    return (
                      <DropdownMenuItem key={name} onSelect={() => insertFromMenu(name)} className="flex-col items-start gap-0">
                        <span className="font-mono text-sm">
                          {name}
                          {entry?.args && <span className="text-muted-foreground">({entry.args.join(', ')})</span>}
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton label="Catalog" onClick={() => setDialog('catalog')}>
            <BookOpen className="size-4" aria-hidden />
          </IconButton>
          <IconButton label="Variables" onClick={() => setDialog('vars')}>
            <Variable className="size-4" aria-hidden />
          </IconButton>
          <IconButton label="New matrix" onClick={() => setDialog('matrix')}>
            <Grid2x2 className="size-4" aria-hidden />
          </IconButton>
          <IconButton label="Mode" onClick={() => setDialog('mode')}>
            <Settings2 className="size-4" aria-hidden />
          </IconButton>
          <IconButton label={state.keypad ? 'Hide keypad' : 'Show keypad'} pressed={state.keypad} onClick={() => update((s) => ({ keypad: !s.keypad }))}>
            <Keyboard className="size-4" aria-hidden />
          </IconButton>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1">
          {screen === 'home' && (
            <Home
              history={state.history}
              format={mode.digits}
              busy={busy}
              userFunctions={userFunctions}
              apiRef={entryApi}
              onSubmit={(input, approx) => void evaluate(input, approx)}
              onBreak={() => breakNow()}
              onRemove={(id) => update((s) => ({ history: s.history.filter((h) => h.id !== id) }))}
              onFocusEntry={() => {
                inserter.current = null;
              }}
            />
          )}
          {screen === 'graph' && (
            <>
              <div className="flex w-60 shrink-0 flex-col border-r border-border/60 bg-muted/20 @4xl:w-72">
                <YEditor
                  kind={kind}
                  plots={plots}
                  compiled={compiled}
                  window={state.window}
                  degrees={mode.angle === 'deg'}
                  userFunctions={userFunctions}
                  onKind={(graph) => setMode({ ...mode, graph })}
                  onPlots={(next) => update((s) => ({ plots: { ...s.plots, [kind]: next } }))}
                  onWindow={(window) => update({ window })}
                  onFocusField={(fn) => {
                    inserter.current = fn;
                  }}
                />
              </div>
              {kind === 'surface' ? (
                <Surface compiled={compiled} enabledIds={enabledIds} window={state.window} format={mode.digits} onWindow={(window) => update({ window })} />
              ) : (
                <Graph
                  kind={kind}
                  compiled={compiled}
                  enabledIds={enabledIds}
                  window={state.window}
                  grid={state.grid}
                  degrees={mode.angle === 'deg'}
                  format={mode.digits}
                  cas={cas}
                  ctx={ctx}
                  points={scatterPoints}
                  onWindow={(window) => update({ window })}
                  onGrid={(grid) => update({ grid })}
                />
              )}
            </>
          )}
          {screen === 'data' && (
            <Data
              vars={state.vars}
              format={mode.digits}
              scatter={state.scatter}
              onStore={(name, items) => void storeList(name, items)}
              onScatter={(scatter) => update({ scatter })}
              onGraphEquation={graphEquation}
            />
          )}
          {screen === 'table' && (
            <Table
              kind={kind}
              compiled={compiled}
              enabledIds={enabledIds}
              start={state.table.start}
              step={state.table.step}
              format={mode.digits}
              onSettings={(table) => update({ table })}
            />
          )}
        </div>
        {state.keypad && screen === 'home' && (
          <div className="hidden w-72 shrink-0 overflow-y-auto border-l border-border/60 bg-muted/30 @3xl:block">
            <Keypad
              onInsert={insert}
              onKey={(action) => {
                if (screen !== 'home') {
                  setScreen('home');
                  return;
                }
                entryApi.current?.key(action);
              }}
            />
          </div>
        )}
        {dialog === 'mode' && <ModeDialog mode={mode} onChange={setMode} onClose={() => setDialog(null)} />}
        {dialog === 'catalog' && (
          <CatalogDialog
            onInsert={(text) => {
              if (screen === 'table') setScreen('home');
              requestAnimationFrame(() => insert(text));
            }}
            onTry={(example) => {
              setScreen('home');
              void evaluate(example, false);
            }}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === 'vars' && (
          <VarsDialog
            vars={state.vars}
            format={mode.digits}
            onInsert={(name) => {
              insert(name);
              setDialog(null);
            }}
            onDelete={(names) => void deleteVars(names)}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === 'matrix' && (
          <MatrixDialog
            onInsert={(text) => {
              if (screen === 'table') setScreen('home');
              requestAnimationFrame(() => insert(text));
            }}
            onClose={() => setDialog(null)}
          />
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-border/60 bg-muted/40 px-2 font-mono text-[0.7rem] tracking-wide text-muted-foreground">
        <StatusToggle
          label={mode.angle === 'rad' ? 'RAD' : 'DEG'}
          title="Angle mode"
          onClick={() => setMode({ ...mode, angle: mode.angle === 'rad' ? 'deg' : 'rad' })}
        />
        <StatusToggle
          label={mode.exact.toUpperCase()}
          title="Exact/Approx mode"
          onClick={() => setMode({ ...mode, exact: mode.exact === 'auto' ? 'exact' : mode.exact === 'exact' ? 'approx' : 'auto' })}
        />
        <StatusToggle
          label={GRAPH_LABELS[mode.graph]}
          title="Graph type"
          onClick={() => setMode({ ...mode, graph: GRAPH_ORDER[(GRAPH_ORDER.indexOf(mode.graph) + 1) % GRAPH_ORDER.length] })}
        />
        <StatusToggle label={mode.complex === 'real' ? 'REAL' : 'a+bi'} title="Complex format" onClick={() => setMode({ ...mode, complex: mode.complex === 'real' ? 'rectangular' : 'real' })} />
        <StatusToggle label={`${mode.digits.mode.toUpperCase()} ${mode.digits.digits}`} title="Display digits" onClick={() => setDialog('mode')} />
        <span className="ml-auto flex items-center gap-2">
          {busy ? (
            <button type="button" onClick={() => breakNow()} className="rounded px-1.5 font-semibold text-foreground hover:bg-foreground/10" title="Stop (Esc)">
              BUSY · Break
            </button>
          ) : (
            <span>{answered}/{HISTORY_LIMIT}</span>
          )}
        </span>
      </div>
    </div>
  );
}

function MenuTrigger({ fkey, label }: { fkey: string; label: string }) {
  return (
    <DropdownMenuTrigger className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground/85 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/10">
      <span className="text-[0.65rem] font-semibold text-muted-foreground">{fkey}</span>
      {label}
      <ChevronDown className="size-3 opacity-60" aria-hidden />
    </DropdownMenuTrigger>
  );
}

function IconButton({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        'grid size-8 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function StatusToggle({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={title} className="rounded px-1.5 py-0.5 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {label}
    </button>
  );
}
