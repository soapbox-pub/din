import { defaultStroke, newId, newLayer, NONE, type Artboard, type Doc, type GroupItem, type Item, type Layer, type Node, type Paint, type PathItem, type Stroke, type SubPath, type TextItem } from './model';
import type { Color } from '@/shared/pdf/color';

/**
 * Illustrator files from before PDF compatibility (versions 3 to 8, and
 * the paths Photoshop exports): PostScript programs whose art is written
 * in Illustrator's own operators, published in the Adobe Illustrator File
 * Format Specification. Paths, compound paths, groups, clipping groups,
 * layers, colors (gray, CMYK, RGB and custom), strokes and point type are
 * read; gradients come in as their first color and placed images are left
 * out.
 */

type Tok = number | string | { name: string } | { str: string } | Tok[];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const stack: Tok[][] = [out];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '%') {
      // Comments matter only as section markers, which the caller finds by text.
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c <= ' ') {
      i++;
      continue;
    }
    if (c === '(') {
      let depth = 1;
      let s = '';
      i++;
      while (i < n && depth) {
        const ch = src[i++];
        if (ch === '\\') {
          const e = src[i++];
          if (e === 'n') s += '\n';
          else if (e === 'r') s += '\r';
          else if (e === 't') s += '\t';
          else if (/[0-7]/.test(e)) {
            let v = e;
            while (v.length < 3 && /[0-7]/.test(src[i])) v += src[i++];
            s += String.fromCharCode(parseInt(v, 8));
          } else s += e;
        } else if (ch === '(') {
          depth++;
          s += ch;
        } else if (ch === ')') {
          if (--depth) s += ch;
        } else s += ch;
      }
      stack[stack.length - 1].push({ str: s });
      continue;
    }
    if (c === '[') {
      const arr: Tok[] = [];
      stack[stack.length - 1].push(arr);
      stack.push(arr);
      i++;
      continue;
    }
    if (c === ']') {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (c === '{' || c === '}' || c === '<' || c === '>') {
      i++;
      continue;
    }
    let j = i;
    while (j < n && src[j] > ' ' && !'()[]{}<>%'.includes(src[j])) j++;
    const w = src.slice(i, j || i + 1);
    i = Math.max(j, i + 1);
    if (w[0] === '/') stack[stack.length - 1].push({ name: w.slice(1) });
    else {
      const v = Number(w);
      stack[stack.length - 1].push(Number.isFinite(v) && /^[-+.\d]/.test(w) ? v : w);
    }
  }
  return out;
}

const gray = (v: number): Color => ({ space: 'gray', c: [v] });

/** Read a PostScript-era .ai. Throws if it isn't one. */
export function readLegacyAi(bytes: Uint8Array): Doc {
  const text = new TextDecoder('latin1').decode(bytes);
  if (!text.startsWith('%!PS')) throw new Error('It isn’t an Illustrator file.');
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? m.slice(1).map(Number) : null;
  };
  // The page: ArtSize centered in the TemplateBox, else the bounding box.
  const bbox = num(/%%HiResBoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/) ?? num(/%%BoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/) ?? [0, 0, 612, 792];
  const art = num(/%AI5_ArtSize:\s*([-\d.]+)\s+([-\d.]+)/);
  const tmpl = num(/%AI3_TemplateBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
  let page = { x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3] };
  if (art && tmpl) {
    const cx = (tmpl[0] + tmpl[2]) / 2;
    const cy = (tmpl[1] + tmpl[3]) / 2;
    page = { x0: cx - art[0] / 2, y0: cy - art[1] / 2, x1: cx + art[0] / 2, y1: cy + art[1] / 2 };
  }
  const W = Math.max(1, page.x1 - page.x0);
  const H = Math.max(1, page.y1 - page.y0);
  const X = (x: number) => x - page.x0;
  const Y = (y: number) => page.y1 - y;

  // The art starts after the setup (or the prolog when there's no setup section).
  let start = text.indexOf('%%EndSetup');
  if (start < 0) start = text.indexOf('%%EndProlog');
  if (start < 0) start = 0;
  let end = text.indexOf('%%PageTrailer', start);
  if (end < 0) end = text.indexOf('%%Trailer', start);
  if (end < 0) end = text.length;
  const body = text.slice(start, end);

  const doc: Doc = {
    artboards: [{ id: newId(), name: 'Artboard 1', x: 0, y: 0, w: W, h: H } as Artboard],
    layers: [],
    res: { images: new Map(), fonts: new Map() },
    mode: /\bk\b|\bK\b/.test(body) && !/\bXa\b/.test(body) ? 'cmyk' : 'rgb',
    units: 'pt',
    notes: [],
  };
  let layer: Layer | null = null;
  const containers: { items: Item[]; group: GroupItem | null; kind: 'u' | 'q' | 'layer' | 'compound' }[] = [];
  const top = () => containers[containers.length - 1];
  const ensureLayer = () => {
    if (!layer) {
      layer = newLayer('Layer 1', doc.layers.length);
      doc.layers.push(layer);
      containers.push({ items: layer.children, group: null, kind: 'layer' });
    }
  };

  let fill: Paint = { type: 'color', color: gray(0) };
  let stroke: Paint = { type: 'color', color: gray(0) };
  let width = 1;
  let cap: 0 | 1 | 2 = 0;
  let join: 0 | 1 | 2 = 0;
  let miter = 4;
  let dash: number[] = [];
  let evenOdd = false;
  let clipNext = false;
  let path: SubPath[] = [];
  let sub: SubPath | null = null;
  let compound: PathItem | null = null;
  let text0: { m: number[]; runs: string[]; font: string; size: number } | null = null;
  let warnedImage = false;
  let gradientNote = false;

  const node = (x: number, y: number): Node => ({ x: X(x), y: Y(y), ix: X(x), iy: Y(y), ox: X(x), oy: Y(y) });
  const strokeOf = (): Stroke => ({ ...defaultStroke(stroke, width), cap, join, miter, dash: [...dash] });
  const emit = (it: Item) => {
    ensureLayer();
    top().items.push(it);
  };
  const paint = (doFill: boolean, doStroke: boolean, close: boolean) => {
    if (close && sub) sub.closed = true;
    const paths = path.filter((s) => s.nodes.length > 0);
    path = [];
    sub = null;
    if (!paths.length) return;
    if (clipNext) {
      clipNext = false;
      // The clipping path of the clip group this path is in.
      const c = top();
      const clipPath: PathItem = { id: newId(), type: 'path', name: '', opacity: 1, blend: 'normal', paths, fill: NONE, stroke: defaultStroke(), evenOdd };
      if (c.kind === 'q' && c.group && !c.group.children.length && !c.items.length) c.items.push(clipPath);
      else if (c.kind === 'q' && c.group) c.items.unshift(clipPath);
      return;
    }
    if (compound) {
      compound.paths.push(...paths);
      if (doFill) compound.fill = fill;
      compound.stroke = doStroke ? strokeOf() : { ...strokeOf(), paint: NONE };
      return;
    }
    emit({ id: newId(), type: 'path', name: '', opacity: 1, blend: 'normal', paths, fill: doFill ? fill : NONE, stroke: doStroke ? strokeOf() : { ...strokeOf(), paint: NONE }, evenOdd });
  };

  const toks = tokenize(body);
  const ops: Tok[] = [];
  const nums = (k: number) => ops.splice(ops.length - k, k).map((t) => (typeof t === 'number' ? t : 0));
  const str = (t: Tok | undefined) => (t && typeof t === 'object' && 'str' in t ? t.str : '');
  for (const t of toks) {
    if (typeof t !== 'string') {
      ops.push(t);
      continue;
    }
    switch (t) {
      case 'm': {
        const [x, y] = nums(2);
        sub = { closed: false, nodes: [node(x, y)] };
        path.push(sub);
        break;
      }
      case 'l': case 'L': {
        const [x, y] = nums(2);
        if (!sub) path.push((sub = { closed: false, nodes: [] }));
        sub.nodes.push(node(x, y));
        break;
      }
      case 'c': case 'C': case 'v': case 'V': case 'y': case 'Y': {
        const k = t === 'c' || t === 'C' ? 6 : 4;
        const a = nums(k);
        if (!sub || !sub.nodes.length) break;
        const prev = sub.nodes[sub.nodes.length - 1];
        let c1: [number, number];
        let c2: [number, number];
        let e: [number, number];
        if (k === 6) {
          c1 = [X(a[0]), Y(a[1])];
          c2 = [X(a[2]), Y(a[3])];
          e = [X(a[4]), Y(a[5])];
        } else if (t === 'v' || t === 'V') {
          c1 = [prev.x, prev.y];
          c2 = [X(a[0]), Y(a[1])];
          e = [X(a[2]), Y(a[3])];
        } else {
          c1 = [X(a[0]), Y(a[1])];
          e = [X(a[2]), Y(a[3])];
          c2 = e;
        }
        prev.ox = c1[0];
        prev.oy = c1[1];
        sub.nodes.push({ x: e[0], y: e[1], ix: c2[0], iy: c2[1], ox: e[0], oy: e[1] });
        break;
      }
      case 'f': paint(true, false, true); break;
      case 'F': paint(true, false, false); break;
      case 's': paint(false, true, true); break;
      case 'S': paint(false, true, false); break;
      case 'b': paint(true, true, true); break;
      case 'B': paint(true, true, false); break;
      case 'n': paint(false, false, true); break;
      case 'N': paint(false, false, false); break;
      case 'h': case 'H':
        if (sub) sub.closed = true;
        break;
      case 'W': clipNext = true; break;
      case 'g': fill = { type: 'color', color: gray(nums(1)[0]) }; break;
      case 'G': stroke = { type: 'color', color: gray(nums(1)[0]) }; break;
      case 'k': fill = { type: 'color', color: { space: 'cmyk', c: nums(4) } }; break;
      case 'K': stroke = { type: 'color', color: { space: 'cmyk', c: nums(4) } }; break;
      case 'x': case 'X': {
        // c m y k (name) tint x
        const tint = nums(1)[0];
        ops.pop();
        const [c, m, y, k] = nums(4);
        const col: Color = { space: 'cmyk', c: [c * (1 - tint), m * (1 - tint), y * (1 - tint), k * (1 - tint)] };
        if (t === 'x') fill = { type: 'color', color: col };
        else stroke = { type: 'color', color: col };
        break;
      }
      case 'Xa': case 'XA': {
        const [r, g, b] = nums(3);
        const col: Color = { space: 'rgb', c: [r, g, b] };
        if (t === 'Xa') fill = { type: 'color', color: col };
        else stroke = { type: 'color', color: col };
        break;
      }
      case 'Xx': case 'XX': {
        // c m y k (name) tint 0 Xx, or r g b (name) tint 1 Xx
        const [tint, kind] = [ops.splice(ops.length - 2, 1)[0], ops.pop()].map((v) => (typeof v === 'number' ? v : 0));
        ops.pop();
        const comps = nums(kind === 1 ? 3 : 4).map((v) => (kind === 1 ? 1 - (1 - v) * (1 - tint) : v * (1 - tint)));
        const col: Color = kind === 1 ? { space: 'rgb', c: comps } : { space: 'cmyk', c: comps };
        if (t === 'Xx') fill = { type: 'color', color: col };
        else stroke = { type: 'color', color: col };
        break;
      }
      case 'w': width = nums(1)[0]; break;
      case 'j': join = Math.min(2, Math.max(0, nums(1)[0])) as 0 | 1 | 2; break;
      case 'J': cap = Math.min(2, Math.max(0, nums(1)[0])) as 0 | 1 | 2; break;
      case 'M': miter = nums(1)[0]; break;
      case 'd': {
        nums(1);
        const arr = ops.pop();
        dash = Array.isArray(arr) ? arr.filter((v): v is number => typeof v === 'number') : [];
        break;
      }
      case 'XR': evenOdd = nums(1)[0] === 1; break;
      case 'u': {
        ensureLayer();
        const g: GroupItem = { id: newId(), type: 'group', name: '', opacity: 1, blend: 'normal', clip: false, children: [] };
        top().items.push(g);
        containers.push({ items: g.children, group: g, kind: 'u' });
        break;
      }
      case 'q': {
        ensureLayer();
        const g: GroupItem = { id: newId(), type: 'group', name: '', opacity: 1, blend: 'normal', clip: true, children: [] };
        top().items.push(g);
        containers.push({ items: g.children, group: g, kind: 'q' });
        break;
      }
      case 'U': case 'Q': {
        const c = containers.length > 1 ? containers.pop()! : null;
        if (c?.group?.clip && (c.items[0]?.type !== 'path' || c.items.length < 2)) c.group.clip = false;
        break;
      }
      case '*u':
        compound = { id: newId(), type: 'path', name: '', opacity: 1, blend: 'normal', paths: [], fill: NONE, stroke: { ...strokeOf(), paint: NONE }, evenOdd };
        break;
      case '*U':
        if (compound && compound.paths.length) emit({ ...compound, evenOdd });
        compound = null;
        break;
      case 'Lb': {
        const visible = typeof ops[ops.length - 10] === 'number' ? ops[ops.length - 10] !== 0 : true;
        ops.length = 0;
        while (containers.length && top().kind !== 'layer') containers.pop();
        if (containers.length) containers.pop();
        layer = newLayer(`Layer ${doc.layers.length + 1}`, doc.layers.length);
        layer.hidden = !visible;
        doc.layers.push(layer);
        containers.push({ items: layer.children, group: null, kind: 'layer' });
        break;
      }
      case 'Ln': {
        const name = str(ops.pop());
        const l = layer as Layer | null;
        if (l && name) l.name = name;
        break;
      }
      case 'LB':
        while (containers.length && top().kind !== 'layer') containers.pop();
        if (containers.length) containers.pop();
        layer = null;
        break;
      case 'Bb':
        if (!gradientNote) {
          doc.notes.push('Gradients in this older file come in as solid colors.');
          gradientNote = true;
        }
        break;
      case 'To':
        nums(1);
        text0 = { m: [1, 0, 0, 1, 0, 0], runs: [], font: 'Helvetica', size: 12 };
        break;
      case 'Tp': {
        nums(1);
        const m = nums(6);
        if (text0) text0.m = m;
        break;
      }
      case 'Tf': {
        // /_Font size ascent? descent? Tf (older files: /_Font size Tf)
        const args: number[] = [];
        while (typeof ops[ops.length - 1] === 'number') args.unshift(ops.pop() as number);
        const f = ops.pop();
        if (text0) {
          if (f && typeof f === 'object' && 'name' in f) text0.font = f.name.replace(/^_/, '');
          if (args.length) text0.size = args[0];
        }
        break;
      }
      case 'Tx': case 'TX': case 'Tj': {
        const s = str(ops.pop());
        if (text0) text0.runs.push(s);
        break;
      }
      case 'T*': case 'Tk':
        if (text0 && t === 'T*') text0.runs.push('\n');
        ops.length = 0;
        break;
      case 'TO':
        if (text0 && text0.runs.join('').trim()) {
          const [a, b, c, d, e, f] = text0.m;
          const ps = text0.font;
          const family = ps.split('-')[0].replace(/([a-z])([A-Z])/g, '$1 $2');
          const style = (ps.split('-')[1] ?? 'Regular').replace(/It$/, 'Italic');
          const item: TextItem = {
            id: newId(),
            type: 'text',
            name: '',
            opacity: 1,
            blend: 'normal',
            // Text space y up to ours y down, then the page flip.
            matrix: [a, -b, -c, d, X(e), Y(f)],
            align: 'left',
            leading: 0,
            runs: [{ text: text0.runs.join('').replace(/\r/g, '\n'), font: { family, style, postscript: ps }, size: text0.size, fill, stroke: { ...strokeOf(), paint: NONE }, tracking: 0, hscale: 1, rise: 0 }],
          };
          emit(item);
        }
        text0 = null;
        break;
      case 'XI': case 'XG': case 'XF':
        if (!warnedImage) {
          doc.notes.push('Placed images in this older file are left out.');
          warnedImage = true;
        }
        ops.length = 0;
        break;
      default:
        // Operators that don't draw (overprint, locking, notes, procsets): drop their operands.
        if (/^[A-Za-z*_]/.test(t)) ops.length = 0;
    }
  }
  if (!doc.layers.length) doc.layers.push(newLayer('Layer 1', 0));
  return doc;
}
