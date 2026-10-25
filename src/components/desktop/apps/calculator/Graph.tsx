import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Grid3x3, Loader2, Sigma, X, ZoomIn } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { parse } from './expr';
import { formatNumberText, toLatex, type NumberFormat } from './latex';
import { tidy } from './present';
import { toGiac, type GiacContext } from './toGiac';
import { TeX } from './TeX';
import { evaluateNumber } from './compile';
import { dataWindow, derivative, extremum, findZero, inflection, integrate, niceStep, type Fn } from './numeric';
import { plotNames, type CompiledPlot, type GraphKind } from './plots';
import { STANDARD_WINDOW, type GraphWindow } from './state';
import type { Cas } from './cas';

type MathToolId = 'value' | 'zero' | 'min' | 'max' | 'intersection' | 'derivative' | 'integral' | 'inflection' | 'tangent' | 'arc';

const MATH_TOOLS: { id: MathToolId; label: string; steps: string[] }[] = [
  { id: 'value', label: 'Value', steps: ['x'] },
  { id: 'zero', label: 'Zero', steps: ['Lower bound', 'Upper bound'] },
  { id: 'min', label: 'Minimum', steps: ['Lower bound', 'Upper bound'] },
  { id: 'max', label: 'Maximum', steps: ['Lower bound', 'Upper bound'] },
  { id: 'intersection', label: 'Intersection', steps: ['Lower bound', 'Upper bound'] },
  { id: 'derivative', label: 'dy/dx', steps: ['x'] },
  { id: 'integral', label: '∫f(x)dx', steps: ['Lower limit', 'Upper limit'] },
  { id: 'inflection', label: 'Inflection', steps: ['Lower bound', 'Upper bound'] },
  { id: 'tangent', label: 'Tangent', steps: ['x'] },
  { id: 'arc', label: 'Arc length', steps: ['From', 'To'] },
];

/** A point the user picked: its value, and its exact text when typed. */
interface PickedPoint {
  x: number;
  text: string;
}

interface ActiveTool {
  id: MathToolId;
  curve: number;
  curve2: number;
  picks: PickedPoint[];
}

interface Mark {
  x: number;
  y: number;
  color: string;
}

interface Result {
  title: string;
  tex?: string;
  text: string;
  marks: Mark[];
  shade?: { curve: number; a: number; b: number };
  line?: { slope: number; x: number; y: number };
}

interface Size {
  w: number;
  h: number;
}

/** A drawable curve: an index into `compiled` with its evaluator. */
interface Curve {
  plot: CompiledPlot;
  name: string;
  f: Fn | null;
}

function curvesOf(kind: GraphKind, compiled: CompiledPlot[], enabled: Set<number>): Curve[] {
  return compiled
    .filter((c) => !c.error && enabled.has(c.id) && c.fns.length > 0)
    .map((c) => ({ plot: c, name: plotNames(kind, c.index).join(','), f: c.fns[0] }));
}

export function Graph({
  kind,
  compiled,
  enabledIds,
  window: view,
  grid,
  degrees,
  format,
  cas,
  ctx,
  points,
  onWindow,
  onGrid,
}: {
  kind: GraphKind;
  compiled: CompiledPlot[];
  enabledIds: Set<number>;
  window: GraphWindow;
  grid: boolean;
  degrees: boolean;
  format: NumberFormat;
  cas: Cas | null;
  ctx: GiacContext;
  /** The data editor's scatter plot. */
  points: { x: number; y: number }[];
  onWindow: (window: GraphWindow) => void;
  onGrid: (grid: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [tool, setTool] = useState<ActiveTool | null>(null);
  const [mode, setMode] = useState<'pan' | 'trace' | 'box'>('pan');
  const [trace, setTrace] = useState<{ curve: number; x: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [exact, setExact] = useState<string | null>(null);
  const [sampled, setSampled] = useState<Map<string, Float64Array>>(new Map());
  const [typed, setTyped] = useState('');
  const toolInputRef = useRef<HTMLInputElement>(null);

  const curves = useMemo(() => curvesOf(kind, compiled, enabledIds), [kind, compiled, enabledIds]);

  // Each step of a Math tool takes typing as well as a click.
  const toolStep = tool ? `${tool.id}:${tool.picks.length}` : null;
  useEffect(() => {
    if (toolStep) toolInputRef.current?.focus();
  }, [toolStep]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const toPx = useCallback((x: number) => ((x - view.xmin) / (view.xmax - view.xmin)) * size.w, [view, size.w]);
  const toPy = useCallback((y: number) => size.h - ((y - view.ymin) / (view.ymax - view.ymin)) * size.h, [view, size.h]);
  const fromPx = useCallback((px: number) => view.xmin + (px / size.w) * (view.xmax - view.xmin), [view, size.w]);
  const fromPy = useCallback((py: number) => view.ymin + ((size.h - py) / size.h) * (view.ymax - view.ymin), [view, size.h]);

  // Expressions compile.ts can't handle are sampled through giac, per window.
  const sampleKey = (plot: CompiledPlot) => `${plot.id}:${plot.giac[0]}:${view.xmin}:${view.xmax}:${size.w}`;
  useEffect(() => {
    if (!cas || kind !== 'function' || size.w === 0) return;
    const missing = curves.filter((c) => !c.f && c.plot.giac[0] && !sampled.has(sampleKey(c.plot)));
    if (missing.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const n = Math.min(Math.max(Math.floor(size.w / 3), 60), 400);
      const xs = Array.from({ length: n + 1 }, (_, i) => view.xmin + (i / n) * (view.xmax - view.xmin));
      for (const c of missing) {
        try {
          const values = await cas.sample(c.plot.giac[0], 'dinvx', xs);
          if (cancelled) return;
          setSampled((prev) => new Map(prev).set(sampleKey(c.plot), Float64Array.from(values)));
        } catch {
          return;
        }
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cas, kind, curves, view.xmin, view.xmax, size.w, sampled]);

  /** f for a curve, from its compiled form or the sampled table (linear between samples). */
  const evaluator = useCallback(
    (curve: Curve | undefined): Fn | null => {
      if (!curve) return null;
      if (curve.f) return curve.f;
      const table = sampled.get(sampleKey(curve.plot));
      if (!table) return null;
      const n = table.length - 1;
      return (x: number) => {
        const u = ((x - view.xmin) / (view.xmax - view.xmin)) * n;
        const i = Math.floor(u);
        if (i < 0 || i >= n) return i === n ? table[n] : NaN;
        return table[i] + (table[i + 1] - table[i]) * (u - i);
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sampled, view.xmin, view.xmax, size.w],
  );

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const frame = requestAnimationFrame(() => {
      const dpr = globalThis.devicePixelRatio || 1;
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
      const g = canvas.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const style = getComputedStyle(canvas);
      const fg = style.color;
      g.clearRect(0, 0, size.w, size.h);

      drawAxes(g, { view, size, grid, fg, toPx, toPy });

      if (result?.shade) {
        const c = curves[result.shade.curve];
        const f = evaluator(c);
        if (c && f) {
          const { a, b } = result.shade;
          g.beginPath();
          g.moveTo(toPx(a), toPy(0));
          const steps = Math.max(2, Math.ceil(Math.abs(toPx(b) - toPx(a))));
          for (let i = 0; i <= steps; i++) {
            const x = a + ((b - a) * i) / steps;
            const y = f(x);
            g.lineTo(toPx(x), clampPy(toPy(Number.isFinite(y) ? y : 0), size.h));
          }
          g.lineTo(toPx(b), toPy(0));
          g.closePath();
          g.fillStyle = c.plot.color;
          g.globalAlpha = 0.22;
          g.fill();
          g.globalAlpha = 1;
        }
      }

      for (let i = 0; i < curves.length; i++) {
        const c = curves[i];
        g.strokeStyle = c.plot.color;
        g.lineWidth = trace?.curve === i || tool?.curve === i ? 2.75 : 2;
        g.lineJoin = 'round';
        if (kind === 'function') {
          const f = evaluator(c);
          if (f) drawFunction(g, f, { size, fromPx, toPy });
        } else if (c.plot.fns.every(Boolean)) {
          drawCurve(g, kind, c.plot, { view, degrees, toPx, toPy, h: size.h });
        }
      }

      for (const p of points) {
        const px = toPx(p.x);
        const py = toPy(p.y);
        g.fillStyle = fg;
        g.globalAlpha = 0.85;
        g.fillRect(px - 3, py - 3, 6, 6);
        g.globalAlpha = 1;
      }

      if (result?.line) {
        const { slope, x, y } = result.line;
        g.strokeStyle = fg;
        g.globalAlpha = 0.7;
        g.setLineDash([6, 4]);
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(0, toPy(y + slope * (fromPx(0) - x)));
        g.lineTo(size.w, toPy(y + slope * (fromPx(size.w) - x)));
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
      }

      for (const mark of result?.marks ?? []) drawPoint(g, toPx(mark.x), toPy(mark.y), mark.color, fg);

      for (const pick of tool?.picks ?? []) {
        g.strokeStyle = fg;
        g.globalAlpha = 0.5;
        g.setLineDash([4, 4]);
        g.beginPath();
        g.moveTo(toPx(pick.x), 0);
        g.lineTo(toPx(pick.x), size.h);
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
      }

      if (trace && curves[trace.curve]) {
        const c = curves[trace.curve];
        const point = tracePoint(kind, c, trace.x, evaluator(c), degrees);
        if (point) {
          g.strokeStyle = fg;
          g.globalAlpha = 0.35;
          g.beginPath();
          g.moveTo(toPx(point.x), 0);
          g.lineTo(toPx(point.x), size.h);
          g.moveTo(0, toPy(point.y));
          g.lineTo(size.w, toPy(point.y));
          g.stroke();
          g.globalAlpha = 1;
          drawPoint(g, toPx(point.x), toPy(point.y), c.plot.color, fg);
        }
      }

      if (box) {
        g.strokeStyle = fg;
        g.setLineDash([5, 3]);
        g.lineWidth = 1;
        g.strokeRect(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
        g.setLineDash([]);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [size, view, grid, curves, points, kind, degrees, trace, tool, result, box, evaluator, toPx, toPy, fromPx]);

  const zoom = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const x = cx ?? (view.xmin + view.xmax) / 2;
      const y = cy ?? (view.ymin + view.ymax) / 2;
      onWindow({
        ...view,
        xmin: x - (x - view.xmin) * factor,
        xmax: x + (view.xmax - x) * factor,
        ymin: y - (y - view.ymin) * factor,
        ymax: y + (view.ymax - y) * factor,
      });
    },
    [view, onWindow],
  );

  const zoomPreset = (preset: 'standard' | 'trig' | 'square' | 'in' | 'out' | 'fit' | 'integer' | 'decimal' | 'data') => {
    const aspect = size.h > 0 ? size.w / size.h : 1;
    switch (preset) {
      case 'standard':
        onWindow({
          ...STANDARD_WINDOW,
          tmax: degrees ? 360 : STANDARD_WINDOW.tmax,
          tstep: degrees ? 7.5 : STANDARD_WINDOW.tstep,
          θmax: degrees ? 360 : STANDARD_WINDOW.θmax,
          θstep: degrees ? 7.5 : STANDARD_WINDOW.θstep,
        });
        break;
      case 'trig': {
        const half = degrees ? 360 : 2 * Math.PI;
        onWindow({ ...view, xmin: -half, xmax: half, xscl: degrees ? 90 : Math.PI / 2, ymin: -4, ymax: 4, yscl: 0.5 });
        break;
      }
      case 'square': {
        const cy = (view.ymin + view.ymax) / 2;
        const half = (view.xmax - view.xmin) / aspect / 2;
        onWindow({ ...view, ymin: cy - half, ymax: cy + half });
        break;
      }
      case 'in':
        zoom(0.5);
        break;
      case 'out':
        zoom(2);
        break;
      case 'integer':
      case 'decimal': {
        const unit = preset === 'integer' ? 1 : 0.1;
        const cx = Math.round((view.xmin + view.xmax) / 2);
        const cy = Math.round((view.ymin + view.ymax) / 2);
        const hx = ((size.w / 2) * unit) / 10;
        const hy = ((size.h / 2) * unit) / 10;
        onWindow({ ...view, xmin: cx - hx, xmax: cx + hx, ymin: cy - hy, ymax: cy + hy, xscl: unit * 10, yscl: unit * 10 });
        break;
      }
      case 'data':
        if (points.length) onWindow({ ...view, ...dataWindow(points) });
        break;
      case 'fit': {
        const values: number[] = points.map((p) => p.y);
        for (const c of curves) {
          if (kind === 'function') {
            const f = evaluator(c);
            if (!f) continue;
            for (let i = 0; i <= 200; i++) {
              const y = f(view.xmin + (i / 200) * (view.xmax - view.xmin));
              if (Number.isFinite(y)) values.push(y);
            }
          } else {
            for (const p of samplePath(kind, c.plot, view, degrees, 400)) if (Number.isFinite(p.y)) values.push(p.y);
          }
        }
        if (values.length === 0) return;
        values.sort((a, b) => a - b);
        const lo = values[Math.floor(values.length * 0.02)];
        const hi = values[Math.ceil(values.length * 0.98) - 1];
        const pad = (hi - lo || 2) * 0.08;
        onWindow({ ...view, ymin: lo - pad, ymax: hi + pad, yscl: niceStep((hi - lo || 2) / 8) });
        break;
      }
    }
  };

  // Pointer: pan, box zoom, trace, and picking points for the Math tools.
  const drag = useRef<{ px: number; py: number; start: GraphWindow; moved: boolean } | null>(null);

  const pick = (x: number, text?: string) => {
    if (!tool) return;
    const picks = [...tool.picks, { x, text: text ?? numberText(x) }];
    const spec = MATH_TOOLS.find((t) => t.id === tool.id)!;
    setTyped('');
    if (picks.length < spec.steps.length) {
      setTool({ ...tool, picks });
      return;
    }
    setTool(null);
    void runTool({ ...tool, picks });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    e.currentTarget.focus();
    if (tool) {
      pick(fromPx(px));
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (mode === 'box') {
      setBox({ x0: px, y0: py, x1: px, y1: py });
      return;
    }
    if (mode === 'trace') {
      setTrace((t) => ({ curve: nearestCurve(px, py) ?? t?.curve ?? 0, x: traceParam(fromPx(px)) }));
      return;
    }
    drag.current = { px, py, start: view, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setHover({ x: fromPx(px), y: fromPy(py) });
    if (box && e.buttons) {
      setBox({ ...box, x1: px, y1: py });
      return;
    }
    if (mode === 'trace' && e.buttons && trace) {
      setTrace({ ...trace, x: traceParam(fromPx(px)) });
      return;
    }
    const d = drag.current;
    if (!d || !e.buttons) return;
    const dx = ((px - d.px) / size.w) * (d.start.xmax - d.start.xmin);
    const dy = ((py - d.py) / size.h) * (d.start.ymax - d.start.ymin);
    if (Math.abs(px - d.px) + Math.abs(py - d.py) > 2) d.moved = true;
    onWindow({ ...d.start, xmin: d.start.xmin - dx, xmax: d.start.xmax - dx, ymin: d.start.ymin + dy, ymax: d.start.ymax + dy });
  };

  const onPointerUp = () => {
    drag.current = null;
    if (box) {
      const w = Math.abs(box.x1 - box.x0);
      const h = Math.abs(box.y1 - box.y0);
      if (w > 6 && h > 6) {
        const xs = [fromPx(box.x0), fromPx(box.x1)].sort((a, b) => a - b);
        const ys = [fromPy(box.y0), fromPy(box.y1)].sort((a, b) => a - b);
        onWindow({ ...view, xmin: xs[0], xmax: xs[1], ymin: ys[0], ymax: ys[1] });
      }
      setBox(null);
      setMode('pan');
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const factor = Math.exp(e.deltaY * 0.0015);
    zoom(factor, fromPx(e.clientX - rect.left), fromPy(e.clientY - rect.top));
  };

  // The canvas only gets wheel events passively through React; block page scroll here.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const block = (e: WheelEvent) => e.preventDefault();
    canvas.addEventListener('wheel', block, { passive: false });
    return () => canvas.removeEventListener('wheel', block);
  }, []);

  /** The parameter trace moves along: x for functions, t or θ otherwise. */
  const traceParam = (x: number) => {
    if (kind === 'function') return x;
    const lo = kind === 'parametric' ? view.tmin : view.θmin;
    return trace?.x ?? lo;
  };

  const nearestCurve = (px: number, py: number): number | undefined => {
    if (kind !== 'function') return undefined;
    let best: number | undefined;
    let bestDist = 24;
    curves.forEach((c, i) => {
      const f = evaluator(c);
      if (!f) return;
      const y = f(fromPx(px));
      const dist = Math.abs(toPy(y) - py);
      if (Number.isFinite(dist) && dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const stepX = (view.xmax - view.xmin) / Math.max(size.w, 1);
    if (e.key === 'Escape') {
      setTool(null);
      setBox(null);
      setMode('pan');
      setTrace(null);
      return;
    }
    if (e.key === '+' || e.key === '=') {
      zoom(0.5);
      return;
    }
    if (e.key === '-') {
      zoom(2);
      return;
    }
    if (trace && curves.length) {
      const step = kind === 'function' ? stepX * (e.shiftKey ? 10 : 1) : (kind === 'parametric' ? view.tstep : view.θstep) * (e.shiftKey ? 10 : 1);
      if (e.key === 'ArrowLeft') setTrace({ ...trace, x: trace.x - step });
      else if (e.key === 'ArrowRight') setTrace({ ...trace, x: trace.x + step });
      else if (e.key === 'ArrowUp') setTrace({ ...trace, curve: (trace.curve + curves.length - 1) % curves.length });
      else if (e.key === 'ArrowDown') setTrace({ ...trace, curve: (trace.curve + 1) % curves.length });
      else if (e.key === 'Enter' && tool) pick(trace.x);
      else return;
      e.preventDefault();
      return;
    }
    const panX = (view.xmax - view.xmin) / 10;
    const panY = (view.ymax - view.ymin) / 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-panX, 0], ArrowRight: [panX, 0], ArrowUp: [0, panY], ArrowDown: [0, -panY] };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      onWindow({ ...view, xmin: view.xmin + move[0], xmax: view.xmax + move[0], ymin: view.ymin + move[1], ymax: view.ymax + move[1] });
    }
  };

  const numberText = (x: number) => {
    // Clicks give decimals; keep them short.
    const scale = (view.xmax - view.xmin) / Math.max(size.w, 1);
    const digits = Math.max(0, Math.ceil(-Math.log10(scale)) + 1);
    return String(Number(x.toFixed(Math.min(digits, 12))));
  };

  const startTool = (id: MathToolId) => {
    setResult(null);
    setExact(null);
    setMode('pan');
    const curve = Math.min(trace?.curve ?? 0, Math.max(curves.length - 1, 0));
    setTool({ id, curve, curve2: curves.length > 1 ? (curve + 1) % curves.length : curve, picks: [] });
    setTyped('');
  };

  const fmt = (v: number) => formatNumberText(v, format);

  async function runTool(t: ActiveTool) {
    const c = curves[t.curve];
    const f = evaluator(c);
    if (!c || !f) {
      setResult({ title: 'Nothing to analyze', text: 'Graph a function first.', marks: [] });
      return;
    }
    const [a, b] = t.picks.map((p) => p.x);
    const lo = Math.min(a, b ?? a);
    const hi = Math.max(a, b ?? a);
    const color = c.plot.color;
    const code = c.plot.giac[0];
    const exactOf = async (giac: string) => {
      if (!cas || !code) return;
      try {
        const out = (await cas.run1(`string(${giac})`)).trim();
        if (out && !/^-?[\d.]+(e[+-]?\d+)?$/.test(out) && !/undef|integrate|diff/.test(out)) {
          setExact(toLatex(tidy(parse(out, { giac: true })), { format }));
        }
      } catch {
        // Only the decimal, then.
      }
    };
    const pickGiac = (p: PickedPoint) => {
      try {
        return toGiac(parse(p.text), ctx);
      } catch {
        return String(p.x);
      }
    };
    setExact(null);
    switch (t.id) {
      case 'value': {
        const y = f(a);
        setResult({ title: `${c.name}(${t.picks[0].text})`, text: `y = ${fmt(y)}`, marks: Number.isFinite(y) ? [{ x: a, y, color }] : [] });
        void exactOf(`subst(${code},dinvx=${pickGiac(t.picks[0])})`);
        break;
      }
      case 'zero': {
        const x = findZero(f, lo, hi);
        if (x === undefined) setResult({ title: 'Zero', text: 'No zero between those bounds.', marks: [] });
        else setResult({ title: 'Zero', text: `x = ${fmt(x)}`, marks: [{ x, y: 0, color }] });
        break;
      }
      case 'min':
      case 'max': {
        const x = extremum(f, lo, hi, t.id === 'max');
        if (x === undefined) setResult({ title: t.id === 'max' ? 'Maximum' : 'Minimum', text: 'None found.', marks: [] });
        else setResult({ title: t.id === 'max' ? 'Maximum' : 'Minimum', text: `x = ${fmt(x)}, y = ${fmt(f(x))}`, marks: [{ x, y: f(x), color }] });
        break;
      }
      case 'intersection': {
        const other = curves[t.curve2];
        const g2 = evaluator(other);
        if (!other || !g2 || other === c) {
          setResult({ title: 'Intersection', text: 'Choose two different curves.', marks: [] });
          break;
        }
        const x = findZero((v) => f(v) - g2(v), lo, hi);
        if (x === undefined) setResult({ title: 'Intersection', text: 'They don’t cross between those bounds.', marks: [] });
        else setResult({ title: 'Intersection', text: `x = ${fmt(x)}, y = ${fmt(f(x))}`, marks: [{ x, y: f(x), color }] });
        break;
      }
      case 'derivative': {
        const slope = derivative(f, a);
        setResult({ title: `dy/dx at x = ${t.picks[0].text}`, text: `dy/dx = ${fmt(slope)}`, marks: [{ x: a, y: f(a), color }] });
        void exactOf(`subst(diff(${code},dinvx),dinvx=${pickGiac(t.picks[0])})`);
        break;
      }
      case 'tangent': {
        const slope = derivative(f, a);
        const y = f(a);
        const intercept = y - slope * a;
        setResult({
          title: `Tangent at x = ${t.picks[0].text}`,
          text: `y = ${fmt(slope)}x ${intercept < 0 ? '−' : '+'} ${fmt(Math.abs(intercept))}`,
          marks: [{ x: a, y, color }],
          line: { slope, x: a, y },
        });
        void exactOf(`dintangent(${code},dinvx,${pickGiac(t.picks[0])})`);
        break;
      }
      case 'integral': {
        const [p0, p1] = t.picks;
        const value = integrate(f, a, b);
        setResult({ title: `∫ from ${p0.text} to ${p1.text}`, text: `∫f(x)dx = ${fmt(value)}`, marks: [], shade: { curve: t.curve, a, b } });
        void exactOf(`integrate(${code},dinvx,${pickGiac(p0)},${pickGiac(p1)})`);
        break;
      }
      case 'inflection': {
        const x = inflection(f, lo, hi);
        if (x === undefined) setResult({ title: 'Inflection', text: 'None between those bounds.', marks: [] });
        else setResult({ title: 'Inflection', text: `x = ${fmt(x)}, y = ${fmt(f(x))}`, marks: [{ x, y: f(x), color }] });
        break;
      }
      case 'arc': {
        const length = integrate((x) => Math.hypot(1, derivative(f, x)), lo, hi);
        setResult({ title: 'Arc length', text: `length = ${fmt(length)}`, marks: [{ x: lo, y: f(lo), color }, { x: hi, y: f(hi), color }] });
        break;
      }
    }
  }

  const traceInfo = useMemo(() => {
    if (!trace || !curves[trace.curve]) return null;
    const c = curves[trace.curve];
    const point = tracePoint(kind, c, trace.x, evaluator(c), degrees);
    if (!point) return null;
    const v = kind === 'function' ? '' : `${kind === 'parametric' ? 't' : 'θ'} = ${fmt(trace.x)}, `;
    return `${c.name}: ${v}x = ${fmt(point.x)}, y = ${fmt(point.y)}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, curves, kind, evaluator, degrees, format]);

  const spec = tool ? MATH_TOOLS.find((t) => t.id === tool.id)! : null;
  const loadingSamples = kind === 'function' && curves.some((c) => !c.f && c.plot.giac[0] && !sampled.has(sampleKey(c.plot)));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger className={toolbarButton()}>
            <ZoomIn className="size-3.5" aria-hidden /> Zoom
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => setMode('box')}>Box</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => zoomPreset('in')}>Zoom In</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => zoomPreset('out')}>Zoom Out</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => zoomPreset('standard')}>ZoomStd</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => zoomPreset('trig')}>ZoomTrig</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => zoomPreset('square')}>ZoomSqr</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => zoomPreset('fit')}>ZoomFit</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => zoomPreset('decimal')}>ZoomDec</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => zoomPreset('integer')}>ZoomInt</DropdownMenuItem>
            <DropdownMenuItem disabled={points.length === 0} onSelect={() => zoomPreset('data')}>
              ZoomData
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-pressed={mode === 'trace'}
          onClick={() => {
            const next = mode === 'trace' ? 'pan' : 'trace';
            setMode(next);
            if (next === 'trace' && curves.length) {
              const lo = kind === 'function' ? (view.xmin + view.xmax) / 2 : kind === 'parametric' ? view.tmin : view.θmin;
              setTrace((t) => t ?? { curve: 0, x: lo });
            } else {
              setTrace(null);
            }
            canvasRef.current?.focus();
          }}
          className={toolbarButton(mode === 'trace')}
        >
          <Crosshair className="size-3.5" aria-hidden /> Trace
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger className={toolbarButton()} disabled={kind !== 'function' || curves.length === 0}>
            <Sigma className="size-3.5" aria-hidden /> Math
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            onCloseAutoFocus={(e) => {
              // The menu traps focus while open; hand it to the tool's input as it closes.
              e.preventDefault();
              toolInputRef.current?.focus();
            }}
          >
            {MATH_TOOLS.map((t) => (
              <DropdownMenuItem
                key={t.id}
                disabled={t.id === 'intersection' && curves.length < 2}
                onSelect={() => startTool(t.id)}
              >
                {t.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" aria-pressed={grid} onClick={() => onGrid(!grid)} className={toolbarButton(grid)}>
          <Grid3x3 className="size-3.5" aria-hidden /> Grid
        </button>
        {loadingSamples && <Loader2 className="ml-1 size-3.5 text-muted-foreground motion-safe:animate-spin" aria-label="Graphing" />}
        <span className="ml-auto truncate font-mono text-xs tabular-nums text-muted-foreground">
          {hover && mode !== 'trace' ? `x = ${fmt(hover.x)}  y = ${fmt(hover.y)}` : ''}
        </span>
      </div>

      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label="Graph. Drag to move, scroll to zoom, arrow keys to pan or trace."
          className={cn(
            'absolute inset-0 size-full touch-none text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
            tool || mode === 'box' ? 'cursor-crosshair' : mode === 'trace' ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
          )}
          style={{ width: size.w, height: size.h }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
        />
        {curves.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-6 text-center text-sm text-muted-foreground">
            Enter a function on the left to graph it.
          </div>
        )}
      </div>

      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-1.5 text-sm" aria-live="polite">
        {tool && spec ? (
          <>
            <span className="font-medium">{spec.label}</span>
            {curves.length > 1 && (
              <CurveSelect curves={curves} value={tool.curve} onChange={(curve) => setTool({ ...tool, curve })} label="Curve" />
            )}
            {tool.id === 'intersection' && (
              <CurveSelect curves={curves} value={tool.curve2} onChange={(curve2) => setTool({ ...tool, curve2 })} label="and" />
            )}
            <span className="text-muted-foreground">
              {spec.steps[tool.picks.length]}: click the graph or type
            </span>
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const x = evaluateNumber(typed, degrees);
                if (x !== undefined) pick(x, typed.trim());
              }}
            >
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-label={spec.steps[tool.picks.length]}
                placeholder="x"
                ref={toolInputRef}
                className="h-7 w-24 rounded-md border border-input bg-background px-2 font-mono text-xs outline-none focus:border-ring"
              />
            </form>
            <button type="button" onClick={() => setTool(null)} className="ml-auto rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground">
              Cancel
            </button>
          </>
        ) : mode === 'trace' && traceInfo ? (
          <span className="font-mono text-xs tabular-nums">{traceInfo}</span>
        ) : result ? (
          <>
            <span className="font-medium">{result.title}</span>
            <span className="font-mono tabular-nums">{result.text}</span>
            {exact && (
              <span className="flex items-center gap-1 text-muted-foreground">
                exact: <TeX tex={exact} />
              </span>
            )}
            <button
              type="button"
              aria-label="Clear result"
              onClick={() => {
                setResult(null);
                setExact(null);
              }}
              className="ml-auto rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </>
        ) : mode === 'box' ? (
          <span className="text-muted-foreground">Drag a box to zoom into.</span>
        ) : (
          <span className="text-xs text-muted-foreground">Drag to move · scroll to zoom · Math finds zeros, extrema, intersections, slopes and areas</span>
        )}
      </div>
    </div>
  );
}

function toolbarButton(active = false) {
  return cn(
    'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40',
    active ? 'bg-primary/15 text-primary' : 'text-foreground/80 hover:bg-foreground/10 hover:text-foreground',
  );
}

function CurveSelect({ curves, value, onChange, label }: { curves: Curve[]; value: number; onChange: (i: number) => void; label: string }) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 rounded-md border border-input bg-background px-1 font-mono text-xs text-foreground"
      >
        {curves.map((c, i) => (
          <option key={c.plot.id} value={i}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

const clampPy = (py: number, h: number) => Math.max(-h * 4, Math.min(h * 5, py));

function drawFunction(
  g: CanvasRenderingContext2D,
  f: Fn,
  { size, fromPx, toPy }: { size: Size; fromPx: (px: number) => number; toPy: (y: number) => number },
) {
  const h = size.h;
  g.beginPath();
  let pen = false;
  let prev = NaN;
  for (let px = 0; px <= size.w; px += 0.5) {
    const y = f(fromPx(px));
    if (!Number.isFinite(y)) {
      pen = false;
      prev = NaN;
      continue;
    }
    const py = toPy(y);
    // A vertical jump from one edge past the other is an asymptote, not a line.
    if (pen && Number.isFinite(prev) && Math.abs(py - prev) > h && ((prev < 0 && py > h) || (prev > h && py < 0))) pen = false;
    if (pen) g.lineTo(px, clampPy(py, h));
    else g.moveTo(px, clampPy(py, h));
    pen = true;
    prev = py;
  }
  g.stroke();
}

function samplePath(kind: GraphKind, plot: CompiledPlot, view: GraphWindow, degrees: boolean, maxPoints = 6000) {
  const [lo, hi, step] = kind === 'parametric' ? [view.tmin, view.tmax, view.tstep] : [view.θmin, view.θmax, view.θstep];
  const n = Math.min(Math.max(Math.ceil((hi - lo) / Math.max(step, 1e-9)), 1), maxPoints);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const p = pathPoint(kind, plot, lo + ((hi - lo) * i) / n, degrees);
    points.push(p ?? { x: NaN, y: NaN });
  }
  return points;
}

function pathPoint(kind: GraphKind, plot: CompiledPlot, v: number, degrees: boolean): { x: number; y: number } | undefined {
  if (kind === 'parametric') {
    const [fx, fy] = plot.fns;
    if (!fx || !fy) return undefined;
    return { x: fx(v), y: fy(v) };
  }
  const fr = plot.fns[0];
  if (!fr) return undefined;
  const r = fr(v);
  const angle = degrees ? (v * Math.PI) / 180 : v;
  return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
}

function drawCurve(
  g: CanvasRenderingContext2D,
  kind: GraphKind,
  plot: CompiledPlot,
  { view, degrees, toPx, toPy, h }: { view: GraphWindow; degrees: boolean; toPx: (x: number) => number; toPy: (y: number) => number; h: number },
) {
  g.beginPath();
  let pen = false;
  for (const p of samplePath(kind, plot, view, degrees)) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      pen = false;
      continue;
    }
    const px = toPx(p.x);
    const py = clampPy(toPy(p.y), h);
    if (pen) g.lineTo(px, py);
    else g.moveTo(px, py);
    pen = true;
  }
  g.stroke();
}

function tracePoint(kind: GraphKind, curve: Curve, v: number, f: Fn | null, degrees: boolean): { x: number; y: number } | undefined {
  if (kind === 'function') {
    if (!f) return undefined;
    const y = f(v);
    return Number.isFinite(y) ? { x: v, y } : undefined;
  }
  const p = pathPoint(kind, curve.plot, v, degrees);
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : undefined;
}

function drawPoint(g: CanvasRenderingContext2D, px: number, py: number, color: string, ring: string) {
  g.beginPath();
  g.arc(px, py, 5, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = ring;
  g.stroke();
}

function drawAxes(
  g: CanvasRenderingContext2D,
  {
    view,
    size,
    grid,
    fg,
    toPx,
    toPy,
  }: { view: GraphWindow; size: Size; grid: boolean; fg: string; toPx: (x: number) => number; toPy: (y: number) => number },
) {
  const { w, h } = size;
  const ox = toPx(0);
  const oy = toPy(0);

  // Grid at the scale marks, when they aren't too dense to see.
  const xsclPx = (view.xscl / (view.xmax - view.xmin)) * w;
  const ysclPx = (view.yscl / (view.ymax - view.ymin)) * h;
  g.strokeStyle = fg;
  if (grid) {
    g.globalAlpha = 0.08;
    g.lineWidth = 1;
    g.beginPath();
    if (view.xscl > 0 && xsclPx >= 6) {
      for (let x = Math.ceil(view.xmin / view.xscl) * view.xscl; x <= view.xmax; x += view.xscl) {
        const px = Math.round(toPx(x)) + 0.5;
        g.moveTo(px, 0);
        g.lineTo(px, h);
      }
    }
    if (view.yscl > 0 && ysclPx >= 6) {
      for (let y = Math.ceil(view.ymin / view.yscl) * view.yscl; y <= view.ymax; y += view.yscl) {
        const py = Math.round(toPy(y)) + 0.5;
        g.moveTo(0, py);
        g.lineTo(w, py);
      }
    }
    g.stroke();
  }

  // Axes.
  g.globalAlpha = 0.55;
  g.lineWidth = 1;
  g.beginPath();
  if (oy >= 0 && oy <= h) {
    g.moveTo(0, Math.round(oy) + 0.5);
    g.lineTo(w, Math.round(oy) + 0.5);
  }
  if (ox >= 0 && ox <= w) {
    g.moveTo(Math.round(ox) + 0.5, 0);
    g.lineTo(Math.round(ox) + 0.5, h);
  }
  g.stroke();

  // Tick marks at xscl and yscl.
  g.beginPath();
  const axisY = Math.min(Math.max(oy, 0), h);
  const axisX = Math.min(Math.max(ox, 0), w);
  // Only on an axis that's on screen.
  if (view.xscl > 0 && xsclPx >= 4 && oy >= 0 && oy <= h) {
    for (let x = Math.ceil(view.xmin / view.xscl) * view.xscl; x <= view.xmax; x += view.xscl) {
      const px = Math.round(toPx(x)) + 0.5;
      g.moveTo(px, axisY - 3);
      g.lineTo(px, axisY + 3);
    }
  }
  if (view.yscl > 0 && ysclPx >= 4 && ox >= 0 && ox <= w) {
    for (let y = Math.ceil(view.ymin / view.yscl) * view.yscl; y <= view.ymax; y += view.yscl) {
      const py = Math.round(toPy(y)) + 0.5;
      g.moveTo(axisX - 3, py);
      g.lineTo(axisX + 3, py);
    }
  }
  g.stroke();

  // Numbers along the axes, at a readable spacing.
  g.globalAlpha = 0.7;
  g.fillStyle = fg;
  g.font = '11px ui-sans-serif, system-ui, sans-serif';
  const labelX = niceStep(((view.xmax - view.xmin) / w) * 90);
  const labelY = niceStep(((view.ymax - view.ymin) / h) * 60);
  const label = (v: number, step: number) => {
    const digits = Math.max(0, -Math.floor(Math.log10(step)));
    return Number(v.toFixed(Math.min(digits, 10))).toString();
  };
  g.textAlign = 'center';
  g.textBaseline = 'top';
  const ly = Math.min(Math.max(oy + 5, 2), h - 14);
  for (let x = Math.ceil(view.xmin / labelX) * labelX; x <= view.xmax; x += labelX) {
    if (Math.abs(x) < labelX / 2 || toPx(x) < 12 || toPx(x) > w - 12) continue;
    g.fillText(label(x, labelX), toPx(x), ly);
  }
  g.textAlign = ox > w - 40 ? 'right' : 'left';
  g.textBaseline = 'middle';
  const lx = ox > w - 40 ? Math.min(ox - 6, w - 2) : Math.max(ox + 6, 2);
  for (let y = Math.ceil(view.ymin / labelY) * labelY; y <= view.ymax; y += labelY) {
    if (Math.abs(y) < labelY / 2 || toPy(y) < 8 || toPy(y) > h - 8) continue;
    g.fillText(label(y, labelY), lx, toPy(y));
  }
  g.globalAlpha = 1;
}
