import { ctx2d, makeCanvas, opaqueBounds, type Rect } from './model';

/**
 * A selection is a document-sized mask: white, with alpha saying how
 * selected each pixel is. Rectangles, ellipses, lassos and the magic wand
 * all make one; Shift adds to the current selection, Alt takes away, and
 * both together intersect, as in Photoshop.
 */
export interface Selection {
  mask: HTMLCanvasElement;
  bounds: Rect;
}

export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

export type Point = { x: number; y: number };

function finish(mask: HTMLCanvasElement): Selection | null {
  const bounds = opaqueBounds(mask);
  return bounds ? { mask, bounds } : null;
}

export function shapeMask(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const mask = makeCanvas(w, h);
  const c = ctx2d(mask);
  c.fillStyle = '#fff';
  draw(c);
  return mask;
}

export function rectMask(w: number, h: number, r: Rect, ellipse: boolean): HTMLCanvasElement {
  return shapeMask(w, h, (c) => {
    if (ellipse) {
      c.beginPath();
      c.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2);
      c.fill();
    } else {
      c.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
    }
  });
}

export function polygonMask(w: number, h: number, pts: Point[]): HTMLCanvasElement {
  return shapeMask(w, h, (c) => {
    if (pts.length < 3) return;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) c.lineTo(p.x, p.y);
    c.closePath();
    c.fill();
  });
}

/** Combine a new shape with the current selection. */
export function combine(current: Selection | null, shape: HTMLCanvasElement, mode: SelectMode): Selection | null {
  if (mode === 'replace') return finish(shape);
  if (!current) return mode === 'add' ? finish(shape) : null;
  const mask = makeCanvas(shape.width, shape.height);
  const c = ctx2d(mask);
  c.drawImage(current.mask, 0, 0);
  c.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
  c.drawImage(shape, 0, 0);
  return finish(mask);
}

export function selectAll(w: number, h: number): Selection {
  return { mask: rectMask(w, h, { x: 0, y: 0, w, h }, false), bounds: { x: 0, y: 0, w, h } };
}

export function invert(sel: Selection | null, w: number, h: number): Selection | null {
  if (!sel) return selectAll(w, h);
  const mask = shapeMask(w, h, (c) => {
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-out';
    c.drawImage(sel.mask, 0, 0);
  });
  return finish(mask);
}

/** Select a layer's pixels (Ctrl+click its thumbnail): `img` is doc-sized. */
export function fromAlpha(img: HTMLCanvasElement): Selection | null {
  const mask = shapeMask(img.width, img.height, (c) => {
    c.drawImage(img, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillRect(0, 0, img.width, img.height);
  });
  return finish(mask);
}

export function feather(sel: Selection, radius: number): Selection | null {
  const { width: w, height: h } = sel.mask;
  const mask = makeCanvas(w, h);
  const c = ctx2d(mask);
  c.filter = `blur(${radius / 2}px)`;
  c.drawImage(sel.mask, 0, 0);
  return finish(mask);
}

function dilate(src: HTMLCanvasElement, r: number): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  const c = ctx2d(out);
  c.drawImage(src, 0, 0);
  for (let ring = 1; ring <= Math.ceil(r); ring++) {
    const rr = Math.min(r, ring);
    const steps = Math.max(8, Math.ceil(rr * 4));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      c.drawImage(src, Math.round(Math.cos(a) * rr), Math.round(Math.sin(a) * rr));
    }
  }
  return out;
}

export function expand(sel: Selection, r: number): Selection | null {
  return finish(dilate(sel.mask, r));
}

export function contract(sel: Selection, r: number): Selection | null {
  const { width: w, height: h } = sel.mask;
  const inv = invert(sel, w, h);
  if (!inv) return sel;
  const grown = dilate(inv.mask, r);
  return finish(
    shapeMask(w, h, (c) => {
      c.drawImage(sel.mask, 0, 0);
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(grown, 0, 0);
    }),
  );
}

/**
 * Magic wand: pixels like the one at (x, y), within `tolerance` (0-255) on
 * every channel, either touching it or anywhere.
 */
export function wand(src: ImageData, x: number, y: number, tolerance: number, contiguous: boolean): HTMLCanvasElement {
  const { width: w, height: h, data: d } = src;
  const mask = makeCanvas(w, h);
  const c = mask.getContext('2d', { willReadFrequently: true })!;
  const out = c.createImageData(w, h);
  const o = out.data;
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return mask;
  const i0 = (y * w + x) * 4;
  const r0 = d[i0];
  const g0 = d[i0 + 1];
  const b0 = d[i0 + 2];
  const a0 = d[i0 + 3];
  const like = (i: number) =>
    Math.abs(d[i + 3] - a0) <= tolerance &&
    (a0 === 0 && d[i + 3] === 0
      ? true
      : Math.abs(d[i] - r0) <= tolerance && Math.abs(d[i + 1] - g0) <= tolerance && Math.abs(d[i + 2] - b0) <= tolerance);
  const mark = (p: number) => {
    const i = p * 4;
    o[i] = o[i + 1] = o[i + 2] = o[i + 3] = 255;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (like(p * 4)) mark(p);
  } else {
    const seen = new Uint8Array(w * h);
    const stack = [y * w + x];
    seen[y * w + x] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      mark(p);
      const px = p % w;
      const py = (p - px) / w;
      const visit = (q: number) => {
        if (!seen[q]) {
          seen[q] = 1;
          if (like(q * 4)) stack.push(q);
        }
      };
      if (px > 0) visit(p - 1);
      if (px < w - 1) visit(p + 1);
      if (py > 0) visit(p - w);
      if (py < h - 1) visit(p + w);
    }
  }
  c.putImageData(out, 0, 0);
  return mask;
}

export function fromMask(mask: HTMLCanvasElement): Selection | null {
  return finish(mask);
}

/**
 * The marching ants: segments along the boundary between selected (alpha
 * at least half) and unselected pixels, in document pixels. Null when
 * there'd be too many to draw at interactive speed.
 */
const outlines = new WeakMap<HTMLCanvasElement, Path2D | null>();
const MAX_SEGMENTS = 250_000;

export function outline(sel: Selection): Path2D | null {
  if (outlines.has(sel.mask)) return outlines.get(sel.mask)!;
  const { width: w, height: h } = sel.mask;
  const b = sel.bounds;
  const x0 = Math.max(0, b.x - 1);
  const y0 = Math.max(0, b.y - 1);
  const x1 = Math.min(w, b.x + b.w + 1);
  const y1 = Math.min(h, b.y + b.h + 1);
  const bw = x1 - x0;
  const bh = y1 - y0;
  const d = sel.mask.getContext('2d', { willReadFrequently: true })!.getImageData(x0, y0, bw, bh).data;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < bw && y < bh && d[(y * bw + x) * 4 + 3] >= 128;
  const path = new Path2D();
  let segments = 0;
  // Horizontal edges, merged into runs.
  for (let y = 0; y <= bh; y++) {
    let start = -1;
    for (let x = 0; x <= bw; x++) {
      const edge = x < bw && on(x, y) !== on(x, y - 1);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        path.moveTo(x0 + start, y0 + y);
        path.lineTo(x0 + x, y0 + y);
        start = -1;
        segments++;
      }
    }
  }
  for (let x = 0; x <= bw; x++) {
    let start = -1;
    for (let y = 0; y <= bh; y++) {
      const edge = y < bh && on(x, y) !== on(x - 1, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        path.moveTo(x0 + x, y0 + start);
        path.lineTo(x0 + x, y0 + y);
        start = -1;
        segments++;
      }
    }
    if (segments > MAX_SEGMENTS) break;
  }
  const result = segments > MAX_SEGMENTS ? null : path;
  outlines.set(sel.mask, result);
  return result;
}
