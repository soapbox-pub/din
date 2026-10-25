import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatNumberText, type NumberFormat } from './latex';
import type { CompiledPlot } from './plots';
import type { GraphWindow } from './state';

const N = 56;

interface View {
  yaw: number;
  pitch: number;
  zoom: number;
}

const HOME: View = { yaw: -0.75, pitch: 0.55, zoom: 1 };

/** Height colors, low to high: blue, cyan, green, yellow, red. */
function heightColor(t: number, shade: number): string {
  const stops = [
    [37, 99, 235],
    [6, 182, 212],
    [22, 163, 74],
    [234, 179, 8],
    [220, 38, 38],
  ];
  const u = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(u), stops.length - 2);
  const f = u - i;
  const c = stops[i].map((v, k) => Math.round((v + (stops[i + 1][k] - v) * f) * shade));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function hexShade(hex: string, shade: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * shade));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** The TI-89's 3D graphs: z = f(x, y) as a shaded surface you can turn. */
export function Surface({
  compiled,
  enabledIds,
  window: range,
  format,
  onWindow,
}: {
  compiled: CompiledPlot[];
  enabledIds: Set<number>;
  window: GraphWindow;
  format: NumberFormat;
  onWindow: (window: GraphWindow) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>(HOME);
  const drag = useRef<{ x: number; y: number; start: View } | null>(null);

  const surfaces = useMemo(() => compiled.filter((c) => enabledIds.has(c.id) && c.fn2), [compiled, enabledIds]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Sample each surface on the window's x–y grid; z range from what's there.
  const grids = useMemo(() => {
    const out = surfaces.map((s) => {
      const z: number[][] = [];
      for (let i = 0; i <= N; i++) {
        const row: number[] = [];
        const x = range.xmin + (i / N) * (range.xmax - range.xmin);
        for (let j = 0; j <= N; j++) {
          const y = range.ymin + (j / N) * (range.ymax - range.ymin);
          const v = s.fn2!(x, y);
          row.push(Number.isFinite(v) ? v : NaN);
        }
        z.push(row);
      }
      return { plot: s, z };
    });
    const values = out.flatMap((g) => g.z.flat()).filter(Number.isFinite).sort((a, b) => a - b);
    const lo = values[Math.floor(values.length * 0.01)] ?? -1;
    const hi = values[Math.ceil(values.length * 0.99) - 1] ?? 1;
    return { surfaces: out, zmin: lo === hi ? lo - 1 : lo, zmax: lo === hi ? hi + 1 : hi };
  }, [surfaces, range.xmin, range.xmax, range.ymin, range.ymax]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    const frame = requestAnimationFrame(() => {
      const dpr = globalThis.devicePixelRatio || 1;
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
      const g = canvas.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size.w, size.h);
      const fg = getComputedStyle(canvas).color;
      const { zmin, zmax } = grids;
      const scale = Math.min(size.w, size.h) * 0.33 * view.zoom;
      const cx = size.w / 2;
      const cy = size.h / 2 + size.h * 0.04;
      const cosY = Math.cos(view.yaw);
      const sinY = Math.sin(view.yaw);
      const cosP = Math.cos(view.pitch);
      const sinP = Math.sin(view.pitch);
      /** Cube coordinates (each in [-1, 1]) to screen x, y and depth. */
      const project = (X: number, Y: number, Z: number) => {
        const rx = X * cosY - Y * sinY;
        const ry = X * sinY + Y * cosY;
        const depth = ry * cosP - Z * sinP;
        const up = ry * sinP + Z * cosP;
        return { x: cx + rx * scale, y: cy - up * scale, depth };
      };
      const cube = (i: number, j: number, z: number) => [(i / N) * 2 - 1, (j / N) * 2 - 1, ((z - zmin) / (zmax - zmin)) * 1.4 - 0.7] as const;

      // The box's back edges first, so the surface draws over them.
      g.strokeStyle = fg;
      g.globalAlpha = 0.25;
      g.lineWidth = 1;
      const corners = [-1, 1].flatMap((X) => [-1, 1].flatMap((Y) => [-0.7, 0.7].map((Z) => project(X, Y, Z))));
      const edges = [
        [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      g.beginPath();
      for (const [a, b] of edges) {
        g.moveTo(corners[a].x, corners[a].y);
        g.lineTo(corners[b].x, corners[b].y);
      }
      g.stroke();
      g.globalAlpha = 1;

      const quads: { pts: { x: number; y: number }[]; depth: number; fill: string }[] = [];
      grids.surfaces.forEach(({ plot, z }, s) => {
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            const zs = [z[i][j], z[i + 1][j], z[i + 1][j + 1], z[i][j + 1]];
            if (zs.some((v) => !Number.isFinite(v) || v < zmin - (zmax - zmin) || v > zmax + (zmax - zmin))) continue;
            const ij = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
            const p3 = ij.map(([a, b], k) => cube(a, b, Math.min(Math.max(zs[k], zmin), zmax)));
            const pts = p3.map((p) => project(p[0], p[1], p[2]));
            // Light from above and in front: the normal's tilt sets the shade.
            const ux = p3[1][0] - p3[0][0];
            const uz = p3[1][2] - p3[0][2];
            const vy = p3[3][1] - p3[0][1];
            const vz = p3[3][2] - p3[0][2];
            const nx = -uz * vy;
            const ny = -ux * vz;
            const nz = ux * vy;
            const shade = 0.55 + 0.45 * Math.abs(nz) / Math.hypot(nx, ny, nz);
            const t = (zs.reduce((a, b) => a + b, 0) / 4 - zmin) / (zmax - zmin);
            const fill = s === 0 ? heightColor(t, shade) : hexShade(plot.color, shade);
            quads.push({ pts, depth: pts.reduce((a, p) => a + p.depth, 0) / 4, fill });
          }
        }
      });
      quads.sort((a, b) => b.depth - a.depth);
      g.lineWidth = 0.5;
      g.strokeStyle = 'rgba(0,0,0,0.18)';
      for (const q of quads) {
        g.beginPath();
        g.moveTo(q.pts[0].x, q.pts[0].y);
        for (let k = 1; k < 4; k++) g.lineTo(q.pts[k].x, q.pts[k].y);
        g.closePath();
        g.fillStyle = q.fill;
        g.fill();
        g.stroke();
      }

      // Axis names at the ends of the box's front edges.
      g.fillStyle = fg;
      g.globalAlpha = 0.8;
      g.font = 'italic 13px ui-serif, Georgia, serif';
      const label = (text: string, X: number, Y: number, Z: number) => {
        const p = project(X, Y, Z);
        g.fillText(text, p.x, p.y);
      };
      label('x', 1.18, -1, -0.7);
      label('y', -1, 1.18, -0.7);
      label('z', -1, -1, 0.85);
      g.globalAlpha = 1;
    });
    return () => cancelAnimationFrame(frame);
  }, [grids, size, view]);

  const zoomRange = (factor: number) => {
    const cx = (range.xmin + range.xmax) / 2;
    const cy = (range.ymin + range.ymax) / 2;
    onWindow({
      ...range,
      xmin: cx - ((range.xmax - range.xmin) / 2) * factor,
      xmax: cx + ((range.xmax - range.xmin) / 2) * factor,
      ymin: cy - ((range.ymax - range.ymin) / 2) * factor,
      ymax: cy + ((range.ymax - range.ymin) / 2) * factor,
    });
  };

  const fmt = (v: number) => formatNumberText(v, format);
  const button = 'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-foreground/80 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <button type="button" className={button} onClick={() => zoomRange(0.5)}>
          <ZoomIn className="size-3.5" aria-hidden /> Zoom In
        </button>
        <button type="button" className={button} onClick={() => zoomRange(2)}>
          <ZoomOut className="size-3.5" aria-hidden /> Zoom Out
        </button>
        <button type="button" className={button} onClick={() => setView(HOME)}>
          <RotateCcw className="size-3.5" aria-hidden /> Reset view
        </button>
        {surfaces.length > 0 && (
          <span className="ml-auto truncate font-mono text-xs tabular-nums text-muted-foreground">
            z from {fmt(grids.zmin)} to {fmt(grids.zmax)}
          </span>
        )}
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label="3D graph. Drag to turn it, scroll to zoom, arrow keys to turn."
          className={cn('absolute inset-0 touch-none text-foreground outline-none', 'cursor-grab active:cursor-grabbing')}
          style={{ width: size.w, height: size.h }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, start: view };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || !e.buttons) return;
            setView({
              ...d.start,
              yaw: d.start.yaw - (e.clientX - d.x) * 0.01,
              pitch: Math.min(Math.max(d.start.pitch + (e.clientY - d.y) * 0.01, -1.5), 1.5),
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onWheel={(e) => setView((v) => ({ ...v, zoom: Math.min(Math.max(v.zoom * Math.exp(-e.deltaY * 0.0015), 0.3), 4) }))}
          onKeyDown={(e) => {
            const turns: Record<string, Partial<View>> = {
              ArrowLeft: { yaw: view.yaw + 0.1 },
              ArrowRight: { yaw: view.yaw - 0.1 },
              ArrowUp: { pitch: Math.min(view.pitch + 0.1, 1.5) },
              ArrowDown: { pitch: Math.max(view.pitch - 0.1, -1.5) },
            };
            if (turns[e.key]) {
              e.preventDefault();
              setView({ ...view, ...turns[e.key] });
            }
          }}
        />
        {surfaces.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-6 text-center text-sm text-muted-foreground">
            Enter z in terms of x and y on the left to graph a surface.
          </div>
        )}
      </div>
      <div className="flex min-h-9 shrink-0 items-center border-t border-border/60 px-3 text-xs text-muted-foreground">
        Drag to turn · scroll to zoom · x from {fmt(range.xmin)} to {fmt(range.xmax)}, y from {fmt(range.ymin)} to {fmt(range.ymax)}
      </div>
    </div>
  );
}
