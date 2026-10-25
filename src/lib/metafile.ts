/**
 * Windows metafiles (WMF, MS-WMF, and EMF, MS-EMF) played onto a 2D canvas:
 * the clip art and drawings old Office documents are full of. Covers what
 * those use: pens, brushes, fonts, lines, polygons, rectangles, ellipses,
 * arcs, paths, text, clipping rectangles, world transforms and bitmaps (with
 * the raster operations clip art masks itself with). EMF+ records are
 * skipped; files that have them carry EMF records too.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Pen {
  kind: 'pen';
  color: string;
  width: number;
  none: boolean;
  dash: number[];
}
interface Brush {
  kind: 'brush';
  color: string;
  none: boolean;
}
interface Font {
  kind: 'font';
  height: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  face: string;
  escapement: number;
}
type Obj = Pen | Brush | Font | { kind: 'other' };

interface State {
  pen: Pen;
  brush: Brush;
  font: Font;
  textColor: string;
  bkColor: string;
  bkOpaque: boolean;
  textAlign: number;
  fillRule: CanvasFillRule;
  winOrg: [number, number];
  winExt: [number, number];
  vpOrg: [number, number];
  vpExt: [number, number];
  mapMode: number;
  world: [number, number, number, number, number, number];
  cur: [number, number];
}

const BLACK_PEN: Pen = { kind: 'pen', color: '#000', width: 0, none: false, dash: [] };
const NULL_PEN: Pen = { kind: 'pen', color: '#000', width: 0, none: true, dash: [] };
const WHITE_BRUSH: Brush = { kind: 'brush', color: '#fff', none: false };
const NULL_BRUSH: Brush = { kind: 'brush', color: '#fff', none: true };
const DEFAULT_FONT: Font = { kind: 'font', height: 12, weight: 400, italic: false, underline: false, face: 'Arial', escapement: 0 };

/** Stock objects, as EMF selects them by handle 0x80000000 + n. */
const STOCK: Record<number, Obj> = {
  0: WHITE_BRUSH,
  1: { kind: 'brush', color: '#c0c0c0', none: false },
  2: { kind: 'brush', color: '#808080', none: false },
  3: { kind: 'brush', color: '#404040', none: false },
  4: { kind: 'brush', color: '#000', none: false },
  5: NULL_BRUSH,
  6: { kind: 'pen', color: '#fff', width: 0, none: false, dash: [] },
  7: BLACK_PEN,
  8: NULL_PEN,
  10: DEFAULT_FONT,
  11: DEFAULT_FONT,
  12: DEFAULT_FONT,
  13: DEFAULT_FONT,
  14: DEFAULT_FONT,
  16: DEFAULT_FONT,
  17: DEFAULT_FONT,
};

const color = (c: number) => `rgb(${c & 0xff},${(c >> 8) & 0xff},${(c >> 16) & 0xff})`;

export interface MetafileInfo {
  kind: 'wmf' | 'emf';
  /** Its own idea of its size, in points, when it has one. */
  width: number | null;
  height: number | null;
}

export function metafileInfo(b: Uint8Array): MetafileInfo | null {
  if (b.length < 40) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(0, true) === 1 && v.getUint32(40, true) === 0x464d4520) {
    // EMF: the frame, in hundredths of a millimeter.
    const w = v.getInt32(32, true) - v.getInt32(24, true);
    const h = v.getInt32(36, true) - v.getInt32(28, true);
    return { kind: 'emf', width: w > 0 ? (w / 2540) * 72 : null, height: h > 0 ? (h / 2540) * 72 : null };
  }
  if (v.getUint32(0, true) === 0x9ac6cdd7) {
    const inch = v.getUint16(14, true) || 1440;
    const w = v.getInt16(10, true) - v.getInt16(6, true);
    const h = v.getInt16(12, true) - v.getInt16(8, true);
    return { kind: 'wmf', width: (Math.abs(w) / inch) * 72, height: (Math.abs(h) / inch) * 72 };
  }
  const t = v.getUint16(0, true);
  if ((t === 1 || t === 2) && v.getUint16(2, true) === 9) return { kind: 'wmf', width: null, height: null };
  return null;
}

/** Plays a metafile into a `w` x `h` pixel area of a canvas, stretched to fill it. */
export function drawMetafile(c: Ctx, b: Uint8Array, w: number, h: number) {
  const info = metafileInfo(b);
  if (!info) throw new Error('It isn’t a Windows metafile.');
  const p = new Player(c, b, w, h);
  if (info.kind === 'emf') p.emf();
  else p.wmf();
}

class Player {
  private v: DataView;
  private st: State;
  private stack: State[] = [];
  private objs: (Obj | null)[] = [];
  /** Logical bounds mapped onto the canvas. */
  private frame = { x: 0, y: 0, w: 1, h: 1 };
  private path: Path2D | null = null;
  private saves = 0;

  constructor(
    private c: Ctx,
    private b: Uint8Array,
    private w: number,
    private h: number,
  ) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.st = {
      pen: BLACK_PEN,
      brush: WHITE_BRUSH,
      font: DEFAULT_FONT,
      textColor: '#000',
      bkColor: '#fff',
      bkOpaque: true,
      textAlign: 0,
      fillRule: 'evenodd',
      winOrg: [0, 0],
      winExt: [1, 1],
      vpOrg: [0, 0],
      vpExt: [1, 1],
      mapMode: 1,
      world: [1, 0, 0, 1, 0, 0],
      cur: [0, 0],
    };
  }

  // ---- Coordinates ---------------------------------------------------------------------------

  /** Logical to device: world transform, then window to viewport (for the scaling map modes). */
  private dev(x: number, y: number): [number, number] {
    const [a, bb, cc, d, e, f] = this.st.world;
    let px = a * x + cc * y + e;
    let py = bb * x + d * y + f;
    if (this.st.mapMode === 8 || this.st.mapMode === 7) {
      px = ((px - this.st.winOrg[0]) * this.st.vpExt[0]) / (this.st.winExt[0] || 1) + this.st.vpOrg[0];
      py = ((py - this.st.winOrg[1]) * this.st.vpExt[1]) / (this.st.winExt[1] || 1) + this.st.vpOrg[1];
    }
    return [px, py];
  }

  /** Device to canvas. */
  private pt(x: number, y: number): [number, number] {
    const [dx, dy] = this.dev(x, y);
    return [((dx - this.frame.x) * this.w) / this.frame.w, ((dy - this.frame.y) * this.h) / this.frame.h];
  }

  /** How long a logical length is on the canvas (for pen widths and font sizes). */
  private len(l: number, vertical = false): number {
    const [x0, y0] = this.pt(0, 0);
    const [x1, y1] = vertical ? this.pt(0, l) : this.pt(l, 0);
    return Math.hypot(x1 - x0, y1 - y0);
  }

  // ---- Drawing ------------------------------------------------------------------------------

  private poly(points: [number, number][], close: boolean, into?: Path2D): Path2D {
    const p = into ?? new Path2D();
    points.forEach(([x, y], i) => {
      const [cx, cy] = this.pt(x, y);
      if (i === 0) p.moveTo(cx, cy);
      else p.lineTo(cx, cy);
    });
    if (close && points.length) p.closePath();
    return p;
  }

  private fillStroke(p: Path2D, fill: boolean, stroke = true) {
    const c = this.c;
    if (fill && !this.st.brush.none) {
      c.fillStyle = this.st.brush.color;
      c.fill(p, this.st.fillRule);
    }
    if (stroke) this.stroke(p);
  }

  private stroke(p: Path2D) {
    const pen = this.st.pen;
    if (pen.none) return;
    const c = this.c;
    c.strokeStyle = pen.color;
    c.lineWidth = Math.max(1, pen.width ? this.len(pen.width) : 1);
    c.setLineDash(pen.dash.map((d) => d * c.lineWidth));
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.stroke(p);
  }

  private rect(l: number, t: number, r: number, bt: number): Path2D {
    return this.poly([[l, t], [r, t], [r, bt], [l, bt]], true);
  }

  private ellipse(l: number, t: number, r: number, bt: number): Path2D {
    const p = new Path2D();
    const cx = (l + r) / 2;
    const cy = (t + bt) / 2;
    const rx = Math.abs(r - l) / 2;
    const ry = Math.abs(bt - t) / 2;
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const [x, y] = this.pt(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    p.closePath();
    return p;
  }

  private roundRect(l: number, t: number, r: number, bt: number, rw: number, rh: number): Path2D {
    const x0 = Math.min(l, r);
    const x1 = Math.max(l, r);
    const y0 = Math.min(t, bt);
    const y1 = Math.max(t, bt);
    const rx = Math.min(Math.abs(rw) / 2, (x1 - x0) / 2);
    const ry = Math.min(Math.abs(rh) / 2, (y1 - y0) / 2);
    const pts: [number, number][] = [];
    const arc = (cx: number, cy: number, a0: number) => {
      for (let i = 0; i <= 8; i++) {
        const a = a0 + (i / 8) * (Math.PI / 2);
        pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
      }
    };
    arc(x1 - rx, y0 + ry, -Math.PI / 2);
    arc(x1 - rx, y1 - ry, 0);
    arc(x0 + rx, y1 - ry, Math.PI / 2);
    arc(x0 + rx, y0 + ry, Math.PI);
    return this.poly(pts, true);
  }

  /** Arc, chord and pie: the ellipse in the box, from where the start radial meets it counterclockwise to the end radial. */
  private arc(l: number, t: number, r: number, bt: number, xs: number, ys: number, xe: number, ye: number, kind: 'arc' | 'chord' | 'pie'): Path2D {
    const cx = (l + r) / 2;
    const cy = (t + bt) / 2;
    const rx = Math.abs(r - l) / 2;
    const ry = Math.abs(bt - t) / 2;
    let a0 = Math.atan2((ys - cy) / (ry || 1), (xs - cx) / (rx || 1));
    const a1 = Math.atan2((ye - cy) / (ry || 1), (xe - cx) / (rx || 1));
    // Counterclockwise on screen, where y points down, is decreasing angle.
    if (a0 <= a1) a0 += Math.PI * 2;
    const pts: [number, number][] = [];
    const steps = Math.max(4, Math.ceil(((a0 - a1) / (Math.PI * 2)) * 48));
    for (let i = 0; i <= steps; i++) {
      const a = a0 - ((a0 - a1) * i) / steps;
      pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    if (kind === 'pie') pts.push([cx, cy]);
    return this.poly(pts, kind !== 'arc');
  }

  private text(x: number, y: number, s: string, dx: number[] | null) {
    if (!s) return;
    const c = this.c;
    const f = this.st.font;
    const px = Math.max(1, this.len(Math.abs(f.height) || 12, true)) * (f.height > 0 ? 0.8 : 1);
    c.save();
    c.font = `${f.italic ? 'italic ' : ''}${f.weight >= 600 ? 'bold ' : ''}${px}px "${f.face.replace(/"/g, '')}", sans-serif`;
    const align = this.st.textAlign;
    const useCur = !!(align & 1);
    const [lx, ly] = useCur ? this.st.cur : [x, y];
    const [cx, cy] = this.pt(lx, ly);
    c.translate(cx, cy);
    if (f.escapement) c.rotate((-f.escapement / 10) * (Math.PI / 180));
    const h = align & 6;
    c.textAlign = h === 6 ? 'center' : h === 2 ? 'right' : 'left';
    const vert = align & 24;
    c.textBaseline = vert === 24 ? 'alphabetic' : vert === 8 ? 'bottom' : 'top';
    c.fillStyle = this.st.textColor;
    if (dx && dx.length >= s.length && c.textAlign === 'left') {
      let x0 = 0;
      for (let i = 0; i < s.length; i++) {
        c.fillText(s[i], x0, 0);
        x0 += this.len(dx[i]);
      }
    } else c.fillText(s, 0, 0);
    c.restore();
    if (useCur) this.st.cur = [lx + (dx ? dx.reduce((a, b) => a + b, 0) : 0), ly];
  }

  /** A DIB (BITMAPINFO followed by bits) as an image, or null for compressions not handled. */
  private dib(at: number, bitsAt?: number, end = this.b.length): ImageData | null {
    const v = this.v;
    if (at + 40 > end) return null;
    const hdr = v.getUint32(at, true);
    if (hdr === 12) return null;
    const w = v.getInt32(at + 4, true);
    const hRaw = v.getInt32(at + 8, true);
    const h = Math.abs(hRaw);
    const bpp = v.getUint16(at + 14, true);
    const comp = v.getUint32(at + 16, true);
    if (w <= 0 || h <= 0 || w * h > 40e6 || (comp !== 0 && comp !== 3)) return null;
    let colors = v.getUint32(at + 32, true);
    if (!colors && bpp <= 8) colors = 1 << bpp;
    const palAt = at + hdr + (comp === 3 && hdr === 40 ? 12 : 0);
    const pal: number[] = [];
    for (let i = 0; i < colors && palAt + i * 4 + 4 <= end; i++) pal.push(v.getUint32(palAt + i * 4, true));
    const data = bitsAt ?? palAt + colors * 4;
    const stride = Math.floor((w * bpp + 31) / 32) * 4;
    if (data + stride * h > end + stride) return null;
    const img = new ImageData(w, h);
    const px = img.data;
    for (let row = 0; row < h; row++) {
      const src = data + (hRaw > 0 ? h - 1 - row : row) * stride;
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let bl = 0;
        let a = 255;
        if (bpp === 24) {
          const o = src + x * 3;
          if (o + 3 > end) break;
          bl = this.b[o];
          g = this.b[o + 1];
          r = this.b[o + 2];
        } else if (bpp === 32) {
          const o = src + x * 4;
          if (o + 4 > end) break;
          bl = this.b[o];
          g = this.b[o + 1];
          r = this.b[o + 2];
        } else if (bpp === 16) {
          const o = src + x * 2;
          if (o + 2 > end) break;
          const val = v.getUint16(o, true);
          r = ((val >> 10) & 31) * 8;
          g = ((val >> 5) & 31) * 8;
          bl = (val & 31) * 8;
        } else if (bpp <= 8) {
          const bit = x * bpp;
          const o = src + (bit >> 3);
          if (o >= end) break;
          const idx = (this.b[o] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
          const c = pal[idx] ?? 0;
          bl = c & 0xff;
          g = (c >> 8) & 0xff;
          r = (c >> 16) & 0xff;
        } else a = 0;
        const d = (row * w + x) * 4;
        px[d] = r;
        px[d + 1] = g;
        px[d + 2] = bl;
        px[d + 3] = a;
      }
    }
    return img;
  }

  /** Draws a bitmap into a logical rectangle with a raster operation. */
  private blit(img: ImageData | null, x: number, y: number, w: number, h: number, sx: number, sy: number, sw: number, sh: number, rop: number) {
    const c = this.c;
    const [x0, y0] = this.pt(x, y);
    const [x1, y1] = this.pt(x + w, y + h);
    const op = rop >>> 16;
    if (!img) {
      // Raster operations with no source: fills.
      const fill = op === 0x00 ? '#000' : op === 0xff ? '#fff' : op === 0xf0 && !this.st.brush.none ? this.st.brush.color : null;
      if (fill) {
        c.fillStyle = fill;
        c.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      }
      return;
    }
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d')!.putImageData(img, 0, 0);
    c.save();
    // Masks: AND darkens where the mask is black, OR (or XOR) adds the picture in.
    c.globalCompositeOperation = op === 0x88 ? 'multiply' : op === 0xee || op === 0x66 ? 'lighter' : 'source-over';
    c.imageSmoothingEnabled = true;
    c.translate(x0, y0);
    c.scale(x1 < x0 ? -1 : 1, y1 < y0 ? -1 : 1);
    const sw2 = sw || img.width;
    const sh2 = sh || img.height;
    c.drawImage(canvas, sx, sy, sw2, sh2, 0, 0, Math.abs(x1 - x0), Math.abs(y1 - y0));
    c.restore();
  }

  private clipRect(l: number, t: number, r: number, bt: number) {
    this.c.clip(this.rect(l, t, r, bt));
  }

  private save() {
    this.stack.push({ ...this.st, cur: [...this.st.cur] as [number, number] });
    this.c.save();
    this.saves++;
  }

  private restore(n = -1) {
    const times = n < 0 ? -n : this.stack.length - n;
    for (let i = 0; i < times && this.stack.length; i++) {
      this.st = this.stack.pop()!;
      this.c.restore();
      this.saves--;
    }
  }

  private select(o: Obj | null | undefined) {
    if (!o) return;
    if (o.kind === 'pen') this.st.pen = o;
    else if (o.kind === 'brush') this.st.brush = o;
    else if (o.kind === 'font') this.st.font = o;
  }

  private addObj(o: Obj) {
    const i = this.objs.indexOf(null);
    if (i >= 0) this.objs[i] = o;
    else this.objs.push(o);
  }

  private finish() {
    while (this.saves > 0) {
      this.c.restore();
      this.saves--;
    }
  }

  // ---- WMF ----------------------------------------------------------------------------------

  wmf() {
    const v = this.v;
    let o = 0;
    let placeable: { l: number; t: number; r: number; b: number } | null = null;
    if (v.getUint32(0, true) === 0x9ac6cdd7) {
      placeable = { l: v.getInt16(6, true), t: v.getInt16(8, true), r: v.getInt16(10, true), b: v.getInt16(12, true) };
      o = 22;
    }
    const start = o + v.getUint16(o + 2, true) * 2;
    // Where the picture is: the placeable header's box, else the window the file sets.
    let org: [number, number] | null = null;
    let ext: [number, number] | null = null;
    for (let p = start; p + 6 <= this.b.length; ) {
      const size = v.getUint32(p, true) * 2;
      const fn = v.getUint16(p + 4, true);
      if (size < 6 || fn === 0) break;
      if (fn === 0x020b && !org) org = [v.getInt16(p + 8, true), v.getInt16(p + 6, true)];
      if (fn === 0x020c && !ext) ext = [v.getInt16(p + 8, true), v.getInt16(p + 6, true)];
      p += size;
    }
    if (placeable) this.frame = { x: placeable.l, y: placeable.t, w: placeable.r - placeable.l || 1, h: placeable.b - placeable.t || 1 };
    else if (ext) this.frame = { x: org?.[0] ?? 0, y: org?.[1] ?? 0, w: ext[0] || 1, h: ext[1] || 1 };
    this.st.mapMode = 1;
    for (let p = start; p + 6 <= this.b.length; ) {
      const size = v.getUint32(p, true) * 2;
      const fn = v.getUint16(p + 4, true);
      if (size < 6 || fn === 0) break;
      try {
        this.wmfRecord(fn, p + 6, p + size);
      } catch {
        // A broken record: skip it.
      }
      p += size;
    }
    this.finish();
  }

  private wmfRecord(fn: number, a: number, end: number) {
    const v = this.v;
    const s16 = (i: number) => v.getInt16(a + i * 2, true);
    const u16 = (i: number) => v.getUint16(a + i * 2, true);
    const pts = (at: number, count: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 0; i < count && at + i * 4 + 4 <= end; i++) out.push([v.getInt16(at + i * 4, true), v.getInt16(at + i * 4 + 2, true)]);
      return out;
    };
    switch (fn) {
      case 0x020b: // SetWindowOrg
        this.st.winOrg = [s16(1), s16(0)];
        if (!this.frameFromPlaceable()) this.frame = { ...this.frame, x: s16(1), y: s16(0) };
        break;
      case 0x020c: // SetWindowExt
        this.st.winExt = [s16(1), s16(0)];
        if (!this.frameFromPlaceable()) this.frame = { ...this.frame, w: s16(1) || 1, h: s16(0) || 1 };
        break;
      case 0x0103: // SetMapMode: the window is what the picture fills either way.
        break;
      case 0x0102:
        this.st.bkOpaque = u16(0) === 2;
        break;
      case 0x0201:
        this.st.bkColor = color(v.getUint32(a, true));
        break;
      case 0x0209:
        this.st.textColor = color(v.getUint32(a, true));
        break;
      case 0x012e:
        this.st.textAlign = u16(0);
        break;
      case 0x0106:
        this.st.fillRule = u16(0) === 2 ? 'nonzero' : 'evenodd';
        break;
      case 0x02fa: {
        const style = u16(0) & 0xf;
        this.addObj({ kind: 'pen', color: color(v.getUint32(a + 6, true)), width: s16(1), none: style === 5, dash: DASHES[style] ?? [] });
        break;
      }
      case 0x02fc: {
        const style = u16(0);
        this.addObj({ kind: 'brush', color: color(v.getUint32(a + 2, true)), none: style === 1 });
        break;
      }
      case 0x02fb: {
        let face = '';
        for (let i = 18; i < 50 && a + i < end; i++) {
          const ch = this.b[a + i];
          if (!ch) break;
          face += String.fromCharCode(ch);
        }
        this.addObj({ kind: 'font', height: s16(0), weight: s16(4), italic: !!this.b[a + 10], underline: !!this.b[a + 11], face: face || 'Arial', escapement: s16(2) });
        break;
      }
      case 0x00f7:
      case 0x01f9:
      case 0x0142:
      case 0x06ff:
        this.addObj({ kind: 'other' });
        break;
      case 0x012d:
        this.select(this.objs[u16(0)]);
        break;
      case 0x01f0:
        if (u16(0) < this.objs.length) this.objs[u16(0)] = null;
        break;
      case 0x0214:
        this.st.cur = [s16(1), s16(0)];
        break;
      case 0x0213: {
        const p = this.poly([this.st.cur, [s16(1), s16(0)]], false);
        this.stroke(p);
        this.st.cur = [s16(1), s16(0)];
        break;
      }
      case 0x0324:
        this.fillStroke(this.poly(pts(a + 2, u16(0)), true), true);
        break;
      case 0x0325:
        this.stroke(this.poly(pts(a + 2, u16(0)), false));
        break;
      case 0x0538: {
        const n = u16(0);
        const path = new Path2D();
        let at = a + 2 + n * 2;
        for (let i = 0; i < n; i++) {
          const count = u16(1 + i);
          this.poly(pts(at, count), true, path);
          at += count * 4;
        }
        this.fillStroke(path, true);
        break;
      }
      case 0x041b:
        this.fillStroke(this.rect(s16(3), s16(2), s16(1), s16(0)), true);
        break;
      case 0x061c:
        this.fillStroke(this.roundRect(s16(5), s16(4), s16(3), s16(2), s16(1), s16(0)), true);
        break;
      case 0x0418:
        this.fillStroke(this.ellipse(s16(3), s16(2), s16(1), s16(0)), true);
        break;
      case 0x0817:
        this.stroke(this.arc(s16(7), s16(6), s16(5), s16(4), s16(3), s16(2), s16(1), s16(0), 'arc'));
        break;
      case 0x081a:
        this.fillStroke(this.arc(s16(7), s16(6), s16(5), s16(4), s16(3), s16(2), s16(1), s16(0), 'pie'), true);
        break;
      case 0x0830:
        this.fillStroke(this.arc(s16(7), s16(6), s16(5), s16(4), s16(3), s16(2), s16(1), s16(0), 'chord'), true);
        break;
      case 0x0521: {
        const n = u16(0);
        const str = latin1(this.b, a + 2, n);
        const at = a + 2 + n + (n & 1);
        this.text(v.getInt16(at + 2, true), v.getInt16(at, true), str, null);
        break;
      }
      case 0x0a32: {
        const y = s16(0);
        const x = s16(1);
        const n = u16(2);
        const opts = u16(3);
        let at = a + 8;
        if (opts & 0x6) at += 8;
        const str = latin1(this.b, at, n);
        at += n + (n & 1);
        const dx: number[] = [];
        for (let i = 0; i < n && at + i * 2 + 2 <= end; i++) dx.push(v.getInt16(at + i * 2, true));
        this.text(x, y, str, dx.length === n ? dx : null);
        break;
      }
      case 0x0f43: {
        const rop = v.getUint32(a, true);
        this.blit(this.dib(a + 22, undefined, end), s16(10), s16(9), s16(8), s16(7), s16(6), s16(5), s16(4), s16(3), rop);
        break;
      }
      case 0x0b41: {
        const rop = v.getUint32(a, true);
        const hasBits = end - a > 22;
        this.blit(hasBits ? this.dib(a + 20, undefined, end) : null, s16(9), s16(8), s16(7), s16(6), s16(5), s16(4), s16(3), s16(2), rop);
        break;
      }
      case 0x0940: {
        const rop = v.getUint32(a, true);
        const hasBits = end - a > 18;
        this.blit(hasBits ? this.dib(a + 16, undefined, end) : null, s16(7), s16(6), s16(5), s16(4), s16(3), s16(2), 0, 0, rop);
        break;
      }
      case 0x061d: {
        // PatBlt
        const rop = v.getUint32(a, true);
        this.blit(null, s16(5), s16(4), s16(3), s16(2), 0, 0, 0, 0, rop);
        break;
      }
      case 0x001e:
        this.save();
        break;
      case 0x0127:
        this.restore(s16(0));
        break;
      case 0x0416:
        this.clipRect(s16(3), s16(2), s16(1), s16(0));
        break;
    }
  }

  private frameFromPlaceable() {
    return this.v.getUint32(0, true) === 0x9ac6cdd7;
  }

  // ---- EMF ----------------------------------------------------------------------------------

  emf() {
    const v = this.v;
    const l = v.getInt32(8, true);
    const t = v.getInt32(12, true);
    const r = v.getInt32(16, true);
    const bt = v.getInt32(20, true);
    this.frame = { x: l, y: t, w: r - l + 1 || 1, h: bt - t + 1 || 1 };
    this.st.mapMode = 1;
    for (let p = 0; p + 8 <= this.b.length; ) {
      const type = v.getUint32(p, true);
      const size = v.getUint32(p + 4, true);
      if (size < 8 || p + size > this.b.length) break;
      if (type === 14) break;
      try {
        this.emfRecord(type, p, p + size);
      } catch {
        // A broken record: skip it.
      }
      p += size;
    }
    this.finish();
  }

  private emfRecord(type: number, r: number, end: number) {
    const v = this.v;
    const a = r + 8;
    const i32 = (i: number) => v.getInt32(a + i * 4, true);
    const u32 = (i: number) => v.getUint32(a + i * 4, true);
    const pts32 = (at: number, count: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 0; i < count && at + i * 8 + 8 <= end; i++) out.push([v.getInt32(at + i * 8, true), v.getInt32(at + i * 8 + 4, true)]);
      return out;
    };
    const pts16 = (at: number, count: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 0; i < count && at + i * 4 + 4 <= end; i++) out.push([v.getInt16(at + i * 4, true), v.getInt16(at + i * 4 + 2, true)]);
      return out;
    };
    const target = () => this.path ?? new Path2D();
    const draw = (p: Path2D, fill: boolean) => {
      if (!this.path) this.fillStroke(p, fill);
    };
    switch (type) {
      case 9:
        this.st.winExt = [i32(0), i32(1)];
        break;
      case 10:
        this.st.winOrg = [i32(0), i32(1)];
        break;
      case 11:
        this.st.vpExt = [i32(0), i32(1)];
        break;
      case 12:
        this.st.vpOrg = [i32(0), i32(1)];
        break;
      case 17:
        this.st.mapMode = u32(0);
        break;
      case 18:
        this.st.bkOpaque = u32(0) === 2;
        break;
      case 19:
        this.st.fillRule = u32(0) === 2 ? 'nonzero' : 'evenodd';
        break;
      case 22:
        this.st.textAlign = u32(0);
        break;
      case 24:
        this.st.textColor = color(u32(0));
        break;
      case 25:
        this.st.bkColor = color(u32(0));
        break;
      case 27:
        this.st.cur = [i32(0), i32(1)];
        if (this.path) this.poly([this.st.cur], false, this.path);
        break;
      case 54: {
        const to: [number, number] = [i32(0), i32(1)];
        if (this.path) {
          const [x, y] = this.pt(...to);
          this.path.lineTo(x, y);
        } else this.stroke(this.poly([this.st.cur, to], false));
        this.st.cur = to;
        break;
      }
      case 33:
        this.save();
        break;
      case 34:
        this.restore(i32(0));
        break;
      case 35:
        this.st.world = [v.getFloat32(a, true), v.getFloat32(a + 4, true), v.getFloat32(a + 8, true), v.getFloat32(a + 12, true), v.getFloat32(a + 16, true), v.getFloat32(a + 20, true)];
        break;
      case 36: {
        const m: [number, number, number, number, number, number] = [v.getFloat32(a, true), v.getFloat32(a + 4, true), v.getFloat32(a + 8, true), v.getFloat32(a + 12, true), v.getFloat32(a + 16, true), v.getFloat32(a + 20, true)];
        const mode = v.getUint32(a + 24, true);
        const w = this.st.world;
        const mul = (p: typeof m, q: typeof m): typeof m => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3], p[4] * q[0] + p[5] * q[2] + q[4], p[4] * q[1] + p[5] * q[3] + q[5]];
        if (mode === 1) this.st.world = [1, 0, 0, 1, 0, 0];
        else if (mode === 2) this.st.world = mul(m, w);
        else if (mode === 3) this.st.world = mul(w, m);
        else if (mode === 4) this.st.world = m;
        break;
      }
      case 37: {
        const h = u32(0);
        this.select(h & 0x80000000 ? STOCK[h & 0x7fffffff] : this.objs[h]);
        break;
      }
      case 40:
        if (u32(0) < this.objs.length) this.objs[u32(0)] = null;
        break;
      case 38: {
        const style = u32(1) & 0xf;
        this.objs[u32(0)] = { kind: 'pen', color: color(u32(4)), width: i32(2), none: style === 5, dash: DASHES[style] ?? [] };
        break;
      }
      case 95: {
        const style = u32(5) & 0xf;
        this.objs[u32(0)] = { kind: 'pen', color: color(u32(8)), width: u32(6), none: style === 5 || u32(7) === 1, dash: DASHES[style] ?? [] };
        break;
      }
      case 39:
        this.objs[u32(0)] = { kind: 'brush', color: color(u32(2)), none: u32(1) === 1 };
        break;
      case 93:
      case 94:
        // Pattern brushes: drawn as gray.
        this.objs[u32(0)] = { kind: 'brush', color: '#808080', none: false };
        break;
      case 82: {
        let face = '';
        for (let i = 0; i < 32; i++) {
          const ch = v.getUint16(a + 4 + 28 + i * 2, true);
          if (!ch) break;
          face += String.fromCharCode(ch);
        }
        this.objs[u32(0)] = { kind: 'font', height: i32(1), weight: i32(5), italic: !!this.b[a + 24], underline: !!this.b[a + 25], face: face || 'Arial', escapement: i32(3) };
        break;
      }
      case 42:
        draw(this.ellipse(i32(0), i32(1), i32(2), i32(3)), true);
        break;
      case 43:
        draw(this.rect(i32(0), i32(1), i32(2), i32(3)), true);
        break;
      case 44:
        draw(this.roundRect(i32(0), i32(1), i32(2), i32(3), i32(4), i32(5)), true);
        break;
      case 45:
        this.stroke(this.arc(i32(0), i32(1), i32(2), i32(3), i32(4), i32(5), i32(6), i32(7), 'arc'));
        break;
      case 46:
        draw(this.arc(i32(0), i32(1), i32(2), i32(3), i32(4), i32(5), i32(6), i32(7), 'chord'), true);
        break;
      case 47:
        draw(this.arc(i32(0), i32(1), i32(2), i32(3), i32(4), i32(5), i32(6), i32(7), 'pie'), true);
        break;
      case 3:
      case 86: {
        const list = type === 3 ? pts32(a + 20, u32(4)) : pts16(a + 20, u32(4));
        const p = this.poly(list, true, this.path ?? undefined);
        draw(p, true);
        break;
      }
      case 4:
      case 87: {
        const list = type === 4 ? pts32(a + 20, u32(4)) : pts16(a + 20, u32(4));
        const p = this.poly(list, false, this.path ?? undefined);
        if (!this.path) this.stroke(p);
        break;
      }
      case 6:
      case 89: {
        const list = type === 6 ? pts32(a + 20, u32(4)) : pts16(a + 20, u32(4));
        const p = target();
        for (const [x, y] of [this.st.cur, ...list]) {
          const [cx, cy] = this.pt(x, y);
          if (x === this.st.cur[0] && y === this.st.cur[1] && !this.path) p.moveTo(cx, cy);
          else p.lineTo(cx, cy);
        }
        if (list.length) this.st.cur = list[list.length - 1];
        if (!this.path) this.stroke(p);
        break;
      }
      case 2:
      case 85:
      case 5:
      case 88: {
        const to = type === 5 || type === 88;
        const list = type === 2 || type === 5 ? pts32(a + 20, u32(4)) : pts16(a + 20, u32(4));
        const p = target();
        let i = 0;
        if (!to && list.length) {
          const [x, y] = this.pt(...list[0]);
          p.moveTo(x, y);
          i = 1;
        } else if (!this.path) {
          const [x, y] = this.pt(...this.st.cur);
          p.moveTo(x, y);
        }
        for (; i + 2 < list.length; i += 3) {
          const c1 = this.pt(...list[i]);
          const c2 = this.pt(...list[i + 1]);
          const e = this.pt(...list[i + 2]);
          p.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], e[0], e[1]);
        }
        if (list.length) this.st.cur = list[list.length - 1];
        if (!this.path) this.stroke(p);
        break;
      }
      case 7:
      case 8:
      case 90:
      case 91: {
        const n = u32(4);
        const wide = type === 7 || type === 8;
        let at = a + 24 + n * 4;
        const p = target();
        for (let i = 0; i < n; i++) {
          const count = v.getUint32(a + 24 + i * 4, true);
          const list = wide ? pts32(at, count) : pts16(at, count);
          this.poly(list, type === 8 || type === 91, p);
          at += count * (wide ? 8 : 4);
        }
        if (!this.path) {
          if (type === 8 || type === 91) this.fillStroke(p, true);
          else this.stroke(p);
        }
        break;
      }
      case 59:
        this.path = new Path2D();
        break;
      case 60:
        break;
      case 61:
        this.path?.closePath();
        break;
      case 68:
        this.path = null;
        break;
      case 62:
      case 63:
      case 64: {
        const p = this.path;
        this.path = null;
        if (p) this.fillStroke(p, type !== 64, type !== 62);
        break;
      }
      case 67: {
        const p = this.path;
        this.path = null;
        if (p) this.c.clip(p, this.st.fillRule);
        break;
      }
      case 30:
        this.clipRect(i32(0), i32(1), i32(2), i32(3));
        break;
      case 84:
      case 83: {
        const wide = type === 84;
        const t = a + 28;
        const x = v.getInt32(t, true);
        const y = v.getInt32(t + 4, true);
        const n = v.getUint32(t + 8, true);
        const off = v.getUint32(t + 12, true);
        const opts = v.getUint32(t + 16, true);
        const offDx = v.getUint32(t + (opts & 0x100 ? 20 : 36), true);
        let s = '';
        for (let i = 0; i < n && r + off + i * (wide ? 2 : 1) < end; i++) s += String.fromCharCode(wide ? v.getUint16(r + off + i * 2, true) : this.b[r + off + i]);
        const dx: number[] = [];
        if (offDx) for (let i = 0; i < n && r + offDx + i * 4 + 4 <= end; i++) dx.push(v.getInt32(r + offDx + i * 4, true));
        this.text(x, y, s, dx.length === n ? dx : null);
        break;
      }
      case 81: {
        // StretchDIBits
        const offBmi = u32(10);
        const offBits = u32(12);
        const img = offBmi ? this.dib(r + offBmi, r + offBits, end) : null;
        this.blit(img, i32(4), i32(5), i32(16), i32(17), i32(6), i32(7), i32(8), i32(9), u32(15));
        break;
      }
      case 80: {
        // SetDIBitsToDevice
        const offBmi = u32(10);
        const offBits = u32(12);
        const img = offBmi ? this.dib(r + offBmi, r + offBits, end) : null;
        this.blit(img, i32(4), i32(5), i32(8), i32(9), i32(6), i32(7), i32(8), i32(9), 0xcc0020);
        break;
      }
      case 76:
      case 77: {
        // BitBlt, StretchBlt
        const offBmi = u32(19);
        const img = offBmi ? this.dib(r + offBmi, r + u32(21), end) : null;
        this.blit(img, i32(4), i32(5), i32(6), i32(7), i32(9), i32(10), type === 77 ? i32(23) : 0, type === 77 ? i32(24) : 0, u32(8));
        break;
      }
    }
  }
}

const DASHES: Record<number, number[]> = { 1: [4, 2], 2: [1, 2], 3: [4, 2, 1, 2], 4: [4, 2, 1, 2, 1, 2] };

function latin1(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
}
