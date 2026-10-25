import { useEffect, useState } from 'react';
import { parse, ParseError, type Node } from './expr';
import { compile, CompileError } from './compile';
import { toGiac, TranslateError, type GiacContext } from './toGiac';
import type { Cas } from './cas';
import type { Plot } from './state';

export type GraphKind = 'function' | 'parametric' | 'polar';

/** The independent variable of each graph type, as on a TI-89. */
export const GRAPH_VARIABLE: Record<GraphKind, string> = { function: 'x', parametric: 't', polar: 'θ' };

/** What each plot's expressions are called: y1, xt1 and yt1, r1. */
export function plotNames(kind: GraphKind, index: number): string[] {
  const n = index + 1;
  if (kind === 'parametric') return [`xt${n}`, `yt${n}`];
  if (kind === 'polar') return [`r${n}`];
  return [`y${n}`];
}

/** The graph variable, renamed so a value stored in x doesn't leak in. */
const FREE = 'dinvx';

export interface CompiledPlot {
  id: number;
  index: number;
  color: string;
  /** Fast evaluators, one per expression; null where only giac can evaluate it. */
  fns: (((v: number) => number) | null)[];
  /** giac code for each expression, in terms of `dinvx`, for sampling and exact answers. */
  giac: string[];
  error?: string;
}

function rename(node: Node, from: string, to: string): Node {
  switch (node.t) {
    case 'id':
      return node.name === from ? { t: 'id', name: to } : node;
    case 'call':
      return { ...node, args: node.args.map((a) => rename(a, from, to)) };
    case 'bin':
      return { ...node, a: rename(node.a, from, to), b: rename(node.b, from, to) };
    case 'neg':
    case 'not':
    case 'post':
    case 'paren':
      return { ...node, a: rename(node.a, from, to) };
    case 'list':
      return { ...node, items: node.items.map((a) => rename(a, from, to)) };
    case 'index':
      return { ...node, a: rename(node.a, from, to), idx: node.idx.map((a) => rename(a, from, to)) };
    default:
      return node;
  }
}

/**
 * Turn the Y= editor's expressions into functions the graph and table can
 * call thousands of times. Giac simplifies each one first (so y2=d(y1(x),x)
 * or a user's f(x) work), and the plots are also defined in giac as y1(x)…
 * for use on the home screen.
 */
export function usePlotFunctions({
  cas,
  kind,
  plots,
  degrees,
  ctx,
  userFunctions,
  revision,
}: {
  cas: Cas | null;
  kind: GraphKind;
  plots: Plot[];
  degrees: boolean;
  ctx: GiacContext;
  userFunctions: ReadonlySet<string>;
  /** Changes when the session's variables change, so plots that use them refresh. */
  revision: number;
}): CompiledPlot[] {
  const [compiled, setCompiled] = useState<CompiledPlot[]>([]);
  const variable = GRAPH_VARIABLE[kind];
  const key = JSON.stringify(plots.map((p) => [p.id, p.exprs, p.enabled, p.color]));

  useEffect(() => {
    if (!cas) return;
    let cancelled = false;
    const allNames = new Set([...userFunctions, ...plots.flatMap((_, i) => plotNames(kind, i))]);

    type Work = { plot: Plot; index: number; codes: string[]; error?: string };
    const work: Work[] = [];
    const defs: string[] = [];
    plots.forEach((plot, index) => {
      const names = plotNames(kind, index);
      if (plot.exprs.every((e) => !e.trim())) {
        defs.push(...names.map((name) => `purge(${name})`));
        return;
      }
      try {
        const codes = plot.exprs.map((expr, i) => {
          if (!expr.trim()) throw new TranslateError(`${names[i]} is empty`);
          const ast = parse(expr, { userFunctions: allNames });
          defs.push(`${names[i]}(${variable}):=(${toGiac(ast, ctx)})`);
          return toGiac(rename(ast, variable, FREE), ctx);
        });
        work.push({ plot, index, codes });
      } catch (error) {
        const message = error instanceof ParseError || error instanceof TranslateError ? error.message : 'Syntax error';
        work.push({ plot, index, codes: [], error: message });
      }
    });

    const commands = [...defs, ...work.flatMap((w) => w.codes.map((code) => `string(${code})`))];
    cas
      .run(commands)
      .then((results) => {
        if (cancelled) return;
        let r = defs.length;
        const out: CompiledPlot[] = work.map((w) => {
          if (w.error) return { id: w.plot.id, index: w.index, color: w.plot.color, fns: [], giac: [], error: w.error };
          const fns: CompiledPlot['fns'] = [];
          const giac: string[] = [];
          let error: string | undefined;
          for (const code of w.codes) {
            const result = results[r++];
            if ('error' in result) {
              error = result.error;
              fns.push(null);
              giac.push(code);
              continue;
            }
            giac.push(result.out);
            try {
              const fn = compile(parse(result.out, { giac: true }), { variables: [FREE], degrees });
              fns.push((v) => fn({ [FREE]: v }));
            } catch (e) {
              if (!(e instanceof CompileError) && !(e instanceof ParseError)) throw e;
              fns.push(null);
            }
          }
          return { id: w.plot.id, index: w.index, color: w.plot.color, fns, giac, error };
        });
        setCompiled(out);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `key` stands for `plots`; ctx and userFunctions change with `revision`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cas, kind, key, degrees, revision]);

  return compiled;
}
