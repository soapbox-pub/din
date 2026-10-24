import type { Rect } from './model';
import type { Point } from './selection';

/** What the screen shows of the document: zoom, and where its top-left corner sits (CSS px). */
export interface View {
  zoom: number;
  x: number;
  y: number;
}

/** A box being free-transformed: its middle, size and turn, in document pixels. */
export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

export type Overlay =
  | { kind: 'marquee'; rect: Rect; ellipse: boolean }
  | { kind: 'lasso'; points: Point[]; cursor: Point | null }
  | { kind: 'crop'; rect: Rect }
  | { kind: 'transform'; box: Box }
  | { kind: 'line'; a: Point; b: Point };

export interface Scene {
  docW: number;
  docH: number;
  composite: HTMLCanvasElement;
  view: View;
  overlay: Overlay | null;
  ants: Path2D | null;
  antsBounds: Rect | null;
  antsPhase: number;
  cursor: { x: number; y: number; r: number } | null;
  cloneSource: Point | null;
}

export const ZOOMS = [1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32];

export function zoomStep(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOMS.find((s) => s > z * 1.001) ?? ZOOMS[ZOOMS.length - 1];
  return [...ZOOMS].reverse().find((s) => s < z / 1.001) ?? ZOOMS[0];
}

export function boxCorners(b: Box): Point[] {
  const cos = Math.cos(b.angle);
  const sin = Math.sin(b.angle);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const x = (sx * b.w) / 2;
    const y = (sy * b.h) / 2;
    return { x: b.cx + x * cos - y * sin, y: b.cy + x * sin + y * cos };
  });
}

/** Handle positions, in local signs: corners then edge middles. */
export const HANDLES: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export function handlePoint(b: Box, [hx, hy]: [number, number]): Point {
  const cos = Math.cos(b.angle);
  const sin = Math.sin(b.angle);
  const x = (hx * b.w) / 2;
  const y = (hy * b.h) / 2;
  return { x: b.cx + x * cos - y * sin, y: b.cy + x * sin + y * cos };
}

export function rectHandles(r: Rect): Point[] {
  const box: Box = { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, angle: 0 };
  return HANDLES.map((h) => handlePoint(box, h));
}

let checker: CanvasPattern | null = null;
function checkerPattern(c: CanvasRenderingContext2D): CanvasPattern {
  if (checker) return checker;
  const tile = document.createElement('canvas');
  tile.width = 16;
  tile.height = 16;
  const t = tile.getContext('2d')!;
  t.fillStyle = '#ffffff';
  t.fillRect(0, 0, 16, 16);
  t.fillStyle = '#cccccc';
  t.fillRect(0, 0, 8, 8);
  t.fillRect(8, 8, 8, 8);
  checker = c.createPattern(tile, 'repeat')!;
  return checker;
}

function handle(c: CanvasRenderingContext2D, p: Point) {
  c.fillStyle = '#ffffff';
  c.strokeStyle = '#1b6ed6';
  c.lineWidth = 1;
  c.fillRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
  c.strokeRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
}

/** Draw the viewport: the pasteboard, the picture on its checkerboard, then whatever's being done to it. */
export function drawScene(canvas: HTMLCanvasElement, s: Scene, cssW: number, cssH: number, dpr: number) {
  const W = Math.round(cssW * dpr);
  const H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const c = canvas.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#282828';
  c.fillRect(0, 0, cssW, cssH);
  const { zoom, x, y } = s.view;
  const dw = s.docW * zoom;
  const dh = s.docH * zoom;
  // A soft edge to lift the picture off the pasteboard.
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.5)';
  c.shadowBlur = 12;
  c.fillStyle = '#000';
  c.fillRect(x, y, dw, dh);
  c.restore();
  c.save();
  c.translate(Math.round(x), Math.round(y));
  c.fillStyle = checkerPattern(c);
  c.fillRect(0, 0, Math.round(dw), Math.round(dh));
  c.restore();
  c.save();
  // Zoomed in, pixels stay square, as in Photoshop.
  c.imageSmoothingEnabled = zoom < 1;
  c.imageSmoothingQuality = 'high';
  c.drawImage(s.composite, 0, 0, s.docW, s.docH, x, y, dw, dh);
  c.restore();

  const toScreen = (p: Point): Point => ({ x: x + p.x * zoom, y: y + p.y * zoom });

  if (s.ants) {
    c.save();
    c.translate(x, y);
    c.scale(zoom, zoom);
    c.lineWidth = 1 / zoom;
    c.strokeStyle = '#ffffff';
    c.setLineDash([]);
    c.stroke(s.ants);
    c.strokeStyle = '#000000';
    c.setLineDash([4 / zoom, 4 / zoom]);
    c.lineDashOffset = -s.antsPhase / zoom;
    c.stroke(s.ants);
    c.restore();
  } else if (s.antsBounds) {
    // Too intricate to trace at speed: show its bounds instead.
    const b = s.antsBounds;
    c.save();
    c.strokeStyle = '#000';
    c.setLineDash([4, 4]);
    c.lineDashOffset = -s.antsPhase;
    c.strokeRect(x + b.x * zoom + 0.5, y + b.y * zoom + 0.5, b.w * zoom, b.h * zoom);
    c.restore();
  }

  const o = s.overlay;
  if (o) {
    c.save();
    if (o.kind === 'marquee') {
      const r = o.rect;
      const a = toScreen({ x: r.x, y: r.y });
      c.beginPath();
      if (o.ellipse) c.ellipse(a.x + (r.w * zoom) / 2, a.y + (r.h * zoom) / 2, Math.abs(r.w * zoom) / 2, Math.abs(r.h * zoom) / 2, 0, 0, Math.PI * 2);
      else c.rect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(r.w * zoom), Math.round(r.h * zoom));
      c.strokeStyle = '#fff';
      c.stroke();
      c.strokeStyle = '#000';
      c.setLineDash([4, 4]);
      c.lineDashOffset = -s.antsPhase;
      c.stroke();
    } else if (o.kind === 'lasso') {
      if (o.points.length) {
        c.beginPath();
        const p0 = toScreen(o.points[0]);
        c.moveTo(p0.x, p0.y);
        for (const p of o.points.slice(1)) {
          const q = toScreen(p);
          c.lineTo(q.x, q.y);
        }
        if (o.cursor) {
          const q = toScreen(o.cursor);
          c.lineTo(q.x, q.y);
        }
        c.strokeStyle = '#fff';
        c.lineWidth = 1;
        c.stroke();
        c.strokeStyle = '#000';
        c.setLineDash([4, 4]);
        c.stroke();
      }
    } else if (o.kind === 'crop') {
      const r = o.rect;
      const a = toScreen({ x: r.x, y: r.y });
      const w = r.w * zoom;
      const h = r.h * zoom;
      // Shade what goes, outline what stays, thirds to compose by.
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.beginPath();
      c.rect(0, 0, cssW, cssH);
      c.rect(a.x, a.y, w, h);
      c.fill('evenodd');
      c.strokeStyle = 'rgba(255,255,255,0.4)';
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 1; i < 3; i++) {
        c.moveTo(a.x + (w * i) / 3, a.y);
        c.lineTo(a.x + (w * i) / 3, a.y + h);
        c.moveTo(a.x, a.y + (h * i) / 3);
        c.lineTo(a.x + w, a.y + (h * i) / 3);
      }
      c.stroke();
      c.strokeStyle = '#ffffff';
      c.strokeRect(a.x + 0.5, a.y + 0.5, w, h);
      for (const p of rectHandles(r)) handle(c, toScreen(p));
    } else if (o.kind === 'transform') {
      const corners = boxCorners(o.box).map(toScreen);
      c.beginPath();
      c.moveTo(corners[0].x, corners[0].y);
      for (const p of corners.slice(1)) c.lineTo(p.x, p.y);
      c.closePath();
      c.strokeStyle = '#1b6ed6';
      c.lineWidth = 1;
      c.stroke();
      for (const h of HANDLES) handle(c, toScreen(handlePoint(o.box, h)));
      const m = toScreen({ x: o.box.cx, y: o.box.cy });
      c.beginPath();
      c.arc(m.x, m.y, 4, 0, Math.PI * 2);
      c.strokeStyle = '#fff';
      c.stroke();
    } else if (o.kind === 'line') {
      const a = toScreen(o.a);
      const b = toScreen(o.b);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.strokeStyle = '#000';
      c.lineWidth = 3;
      c.stroke();
      c.strokeStyle = '#fff';
      c.lineWidth = 1;
      c.stroke();
      for (const p of [a, b]) {
        c.beginPath();
        c.arc(p.x, p.y, 3, 0, Math.PI * 2);
        c.fillStyle = '#fff';
        c.fill();
        c.stroke();
      }
    }
    c.restore();
  }

  if (s.cloneSource) {
    const p = toScreen(s.cloneSource);
    c.save();
    c.strokeStyle = '#fff';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(p.x - 6, p.y);
    c.lineTo(p.x + 6, p.y);
    c.moveTo(p.x, p.y - 6);
    c.lineTo(p.x, p.y + 6);
    c.stroke();
    c.restore();
  }

  if (s.cursor) {
    const p = toScreen(s.cursor);
    const r = Math.max(1, s.cursor.r * zoom);
    c.save();
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(0,0,0,0.8)';
    c.lineWidth = 1;
    c.stroke();
    c.beginPath();
    c.arc(p.x, p.y, r + 1, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,255,255,0.8)';
    c.stroke();
    c.restore();
  }
}
