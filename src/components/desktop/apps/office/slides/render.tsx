import { memo, useId, type CSSProperties, type ReactNode } from 'react';
import { isLineGeom, shapePath } from './geometry';
import { ChartView } from './chart';
import { cellLook } from './table';
import {
  PX,
  type FrameShape,
  type Line,
  type Para,
  type PicShape,
  type Shape,
  type SlideCtx,
  type SpShape,
  type TextBody,
  type Xfrm,
  hasText,
} from './model';
import {
  background,
  colorCss,
  css,
  effectiveXfrm,
  inheritChain,
  promptText,
  resolveColorModel,
  shade,
  shapeFill,
  shapeLine,
  textChain,
  type Paint,
  type Stroke,
  type TextStyleChain,
} from './resolve';
import { fieldText, fullRunCss, paraLooks, textEnv, type TextEnv } from './textStyle';

/**
 * Draws slides: the background, the master's and layout's own shapes, then
 * the slide's, each an absolutely placed box at 96 dpi holding an SVG of its
 * outline and its text as HTML. The same drawing serves the editor, the
 * thumbnails and the slide show, scaled with a CSS transform.
 */

export interface RenderOpts {
  /** Editing view: empty placeholders show their prompt and a dashed outline. */
  edit?: boolean;
  /** The shape whose text is being edited, and what to draw in its text's place. */
  editing?: string | null;
  editor?: (shape: Shape, info: TextInfo, cell?: [number, number]) => ReactNode;
  /** The table cell being edited, when it's a table. */
  editingCell?: [number, number] | null;
  /** Live links (the slide show). */
  links?: boolean;
  /** Shapes drawn elsewhere for now (being dragged). */
  hide?: Set<string>;
}

export interface TextInfo {
  chain: TextStyleChain;
  env: TextEnv;
}


// ---- Fills ---------------------------------------------------------------------------

function cssBackground(paint: Paint | null, ctx: SlideCtx): CSSProperties {
  if (!paint) return {};
  const f = paint.fill;
  const color = (c: Parameters<typeof colorCss>[0]) => colorCss(c, ctx, paint.phClr);
  switch (f.type) {
    case 'solid':
      return { backgroundColor: color(f.color) };
    case 'grad': {
      const stops = f.stops.map((s) => `${color(s.color)} ${(s.pos * 100).toFixed(1)}%`).join(', ');
      if (f.stops.length < 2) return { backgroundColor: f.stops[0] ? color(f.stops[0].color) : undefined };
      return { backgroundImage: f.path ? `radial-gradient(circle at 50% 50%, ${stops})` : `linear-gradient(${90 + f.angle}deg, ${stops})` };
    }
    case 'blip': {
      const url = ctx.media(f.media);
      if (!url) return { backgroundColor: '#ffffff' };
      return { backgroundImage: `url("${url}")`, backgroundSize: f.tile ? 'auto' : '100% 100%', backgroundRepeat: f.tile ? 'repeat' : 'no-repeat' };
    }
    case 'patt':
      return { backgroundColor: color(f.bg) };
  }
  return {};
}

interface SvgPaint {
  value: string;
  defs: ReactNode;
  /** The flat color, for shading cube sides. */
  hex?: string;
}

function svgFill(paint: Paint | null, ctx: SlideCtx, id: string, w: number, h: number, crop?: PicShape['crop']): SvgPaint {
  if (!paint) return { value: 'none', defs: null };
  const f = paint.fill;
  const resolve = (c: Parameters<typeof resolveColorModel>[0]) => resolveColorModel(c, ctx.theme, ctx.clrMap, paint.phClr);
  switch (f.type) {
    case 'solid': {
      const c = resolve(f.color);
      return { value: css(c) ?? 'none', defs: null, hex: c?.hex };
    }
    case 'grad': {
      if (!f.stops.length) return { value: 'none', defs: null };
      const stops = f.stops.map((s, i) => {
        const c = resolve(s.color);
        return <stop key={i} offset={s.pos} stopColor={c ? `#${c.hex}` : '#000'} stopOpacity={c?.alpha ?? 1} />;
      });
      const a = (f.angle * Math.PI) / 180;
      const defs = f.path ? (
        <radialGradient id={id} cx="50%" cy="50%" r="71%">
          {stops}
        </radialGradient>
      ) : (
        <linearGradient id={id} x1={0.5 - Math.cos(a) / 2} y1={0.5 - Math.sin(a) / 2} x2={0.5 + Math.cos(a) / 2} y2={0.5 + Math.sin(a) / 2}>
          {stops}
        </linearGradient>
      );
      return { value: `url(#${id})`, defs, hex: resolve(f.stops[0].color)?.hex };
    }
    case 'blip': {
      const url = ctx.media(f.media);
      if (!url) return { value: '#d9d9d9', defs: null };
      const c = crop ?? f.crop;
      const iw = w / (1 - (c?.l ?? 0) - (c?.r ?? 0));
      const ih = h / (1 - (c?.t ?? 0) - (c?.b ?? 0));
      return {
        value: `url(#${id})`,
        defs: (
          <pattern id={id} patternUnits="userSpaceOnUse" width={w} height={h}>
            <image href={url} x={-(c?.l ?? 0) * iw} y={-(c?.t ?? 0) * ih} width={iw} height={ih} preserveAspectRatio="none" />
          </pattern>
        ),
      };
    }
    case 'patt': {
      const fg = css(resolve(f.fg)) ?? '#000';
      const bg = css(resolve(f.bg)) ?? '#fff';
      return {
        value: `url(#${id})`,
        defs: (
          <pattern id={id} patternUnits="userSpaceOnUse" width={8} height={8}>
            <rect width={8} height={8} fill={bg} />
            {patternMarks(f.prst, fg)}
          </pattern>
        ),
      };
    }
  }
  return { value: 'none', defs: null };
}

function patternMarks(prst: string, fg: string): ReactNode {
  if (/horz/i.test(prst)) return <rect y={3} width={8} height={2} fill={fg} />;
  if (/vert/i.test(prst)) return <rect x={3} width={2} height={8} fill={fg} />;
  if (/dnDiag|wdDnDiag|ltDnDiag|dkDnDiag/.test(prst)) return <path d="M0 0L8 8M-2 6L2 10M6 -2L10 2" stroke={fg} strokeWidth={1.5} />;
  if (/upDiag/i.test(prst)) return <path d="M0 8L8 0M-2 2L2 -2M6 10L10 6" stroke={fg} strokeWidth={1.5} />;
  if (/cross|grid|Check/i.test(prst)) return <path d="M0 4H8M4 0V8" stroke={fg} strokeWidth={1} />;
  const pct = Number(/pct(\d+)/.exec(prst)?.[1] ?? 50);
  return <rect width={8} height={8} fill={fg} opacity={pct / 100} />;
}

const DASHES: Record<string, number[]> = {
  dash: [4, 3], sysDash: [3, 1], sysDot: [1, 1], dot: [1, 3], dashDot: [4, 3, 1, 3], lgDash: [8, 3],
  lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

interface SvgStroke {
  color: string;
  width: number;
  dash?: string;
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  head?: Line['head'];
  tail?: Line['tail'];
}

function svgStroke(stroke: Stroke | null, ctx: SlideCtx): SvgStroke | null {
  if (!stroke) return null;
  const { line } = stroke;
  const fill = line.fill;
  if (!fill || fill.type === 'none') return null;
  const color = fill.type === 'solid' ? css(resolveColorModel(fill.color, ctx.theme, ctx.clrMap, stroke.phClr)) : '#000';
  if (!color) return null;
  const width = Math.max(0.5, (line.w ?? 9525) * PX);
  const pattern = line.dash ? DASHES[line.dash] : undefined;
  return {
    color,
    width,
    dash: pattern?.map((n) => n * Math.max(width, 1)).join(' '),
    cap: line.cap === 'rnd' ? 'round' : line.cap === 'sq' ? 'square' : 'butt',
    join: line.raw?.round ? 'round' : line.raw?.bevel ? 'bevel' : 'miter',
    head: line.head,
    tail: line.tail,
  };
}

function marker(id: string, end: NonNullable<Line['head']>, color: string, start: boolean): ReactNode {
  const scale = (v: string | undefined) => (v === 'sm' ? 2 : v === 'lg' ? 5 : 3);
  const w = scale(end.w);
  const l = scale(end.len);
  let shape: ReactNode;
  let ref = l;
  switch (end.type) {
    case 'arrow':
      shape = <path d={`M0 0L${l} ${w / 2}L0 ${w}`} fill="none" stroke={color} strokeWidth={0.8} strokeLinejoin="miter" />;
      ref = l - 0.4;
      break;
    case 'stealth':
      shape = <path d={`M0 0L${l} ${w / 2}L0 ${w}L${l * 0.3} ${w / 2}Z`} fill={color} />;
      break;
    case 'diamond':
      shape = <path d={`M0 ${w / 2}L${l / 2} 0L${l} ${w / 2}L${l / 2} ${w}Z`} fill={color} />;
      ref = l / 2;
      break;
    case 'oval':
      shape = <ellipse cx={l / 2} cy={w / 2} rx={l / 2} ry={w / 2} fill={color} />;
      ref = l / 2;
      break;
    default:
      shape = <path d={`M0 0L${l} ${w / 2}L0 ${w}Z`} fill={color} />;
  }
  return (
    <marker id={id} viewBox={`0 0 ${l} ${w}`} markerWidth={l} markerHeight={w} refX={ref} refY={w / 2} orient={start ? 'auto-start-reverse' : 'auto'} markerUnits="strokeWidth" overflow="visible">
      {shape}
    </marker>
  );
}

// ---- Text ---------------------------------------------------------------------------

function promptParas(text: string, body: TextBody | undefined): Para[] {
  const first = body?.paras[0];
  return text.split('\n').map((line) => ({ props: first?.props ?? {}, runs: [{ kind: 'text' as const, text: line, props: first?.end ?? {} }] }));
}

export function TextParas({ paras, chain, env, links }: { paras: Para[]; chain: TextStyleChain; env: TextEnv; links?: boolean }) {
  const looks = paraLooks(paras, chain, env);
  return (
    <>
      {paras.map((p, i) => {
        const look = looks[i];
        const last = p.runs[p.runs.length - 1];
        return (
          <div key={i} className="sl-p" data-bu={look.bullet ?? undefined} style={look.style}>
            {p.runs.map((r, j) => {
              if (r.kind === 'br') return <br key={j} />;
              const style = fullRunCss(r.props, look.rp, env);
              const text = r.kind === 'field' ? fieldText(r.type, r.text, env) : r.text;
              if (links && r.props.link && /^(https?:|mailto:)/i.test(r.props.link)) {
                return (
                  <a key={j} href={r.props.link} target="_blank" rel="noopener noreferrer" style={{ ...style, cursor: 'pointer' }} onClick={(e) => e.stopPropagation()}>
                    {text}
                  </a>
                );
              }
              return (
                <span key={j} style={style}>
                  {text}
                </span>
              );
            })}
            {(!p.runs.length || last?.kind === 'br' || p.runs.every((r) => r.kind !== 'br' && !r.text)) && <br />}
          </div>
        );
      })}
    </>
  );
}

/** Where a text body goes in its shape, and how it sits there. */
function textBoxStyle(chain: TextStyleChain, rect: { l: number; t: number; r: number; b: number }): { outer: CSSProperties; inner: CSSProperties; nowrap: boolean } {
  const b = chain.body;
  const l = rect.l + (b.lIns ?? 91440) * PX;
  const t = rect.t + (b.tIns ?? 45720) * PX;
  const w = Math.max(0, rect.r - rect.l - ((b.lIns ?? 91440) + (b.rIns ?? 91440)) * PX);
  const h = Math.max(0, rect.b - rect.t - ((b.tIns ?? 45720) + (b.bIns ?? 45720)) * PX);
  const vertical = b.vert === 'vert' || b.vert === 'eaVert' || b.vert === 'vert270' || b.vert === 'wordArtVert';
  const turn = (b.vert === 'vert270' ? -90 : vertical ? 90 : 0) + (b.rot ?? 0);
  const [bw, bh] = vertical ? [h, w] : [w, h];
  const nowrap = b.wrap === 'none';
  const outer: CSSProperties = {
    position: 'absolute',
    left: l + (w - bw) / 2,
    top: t + (h - bh) / 2,
    width: bw,
    height: bh,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: b.anchor === 'ctr' ? 'center' : b.anchor === 'b' ? 'flex-end' : 'flex-start',
    transform: turn ? `rotate(${turn}deg)` : undefined,
  };
  const inner: CSSProperties = nowrap ? { width: 'max-content', minWidth: '100%' } : { width: '100%' };
  return { outer, inner, nowrap };
}

function TextBox({
  shape,
  body,
  chain,
  rect,
  ctx,
  opts,
  prompt,
}: {
  shape: Shape;
  body: TextBody | undefined;
  chain: TextStyleChain;
  rect: { l: number; t: number; r: number; b: number };
  ctx: SlideCtx;
  opts: RenderOpts;
  prompt: string | null;
}) {
  const env = textEnv(ctx, chain);
  const { outer, inner, nowrap } = textBoxStyle(chain, rect);
  const editing = opts.editing === shape.uid && opts.editor;
  let content: ReactNode = null;
  if (editing) content = opts.editor!(shape, { chain, env });
  else if (body && hasText(body)) content = <TextParas paras={body.paras} chain={chain} env={env} links={opts.links} />;
  else if (prompt && opts.edit) content = <TextParas paras={promptParas(prompt, body)} chain={chain} env={env} />;
  if (!content) return null;
  // A text box that doesn't wrap centers on its box when it's centered.
  const firstAlgn = body?.paras[0]?.props.algn;
  const alignItems = nowrap ? (firstAlgn === 'ctr' ? 'center' : firstAlgn === 'r' ? 'flex-end' : 'flex-start') : undefined;
  return (
    <div className={nowrap ? 'sl-text sl-nowrap' : 'sl-text'} style={{ ...outer, alignItems }}>
      <div style={inner}>{content}</div>
    </div>
  );
}

// ---- Shapes ---------------------------------------------------------------------------

interface ShapeProps {
  shape: Shape;
  ctx: SlideCtx;
  opts: RenderOpts;
  /** Inherited from: a slide placeholder's layout and master placeholders. */
  chain: Shape[];
  /** In a group: where it lands in the group's box. */
  box?: Xfrm;
  grpFill?: Paint | null;
  /** Selectable (slide-level, not a master or group member). */
  top?: boolean;
}

function boxStyle(x: Xfrm): CSSProperties {
  const t: string[] = [];
  if (x.rot) t.push(`rotate(${x.rot}deg)`);
  return {
    position: 'absolute',
    left: x.x * PX,
    top: x.y * PX,
    width: Math.max(0, x.w * PX),
    height: Math.max(0, x.h * PX),
    transform: t.length ? t.join(' ') : undefined,
  };
}

const flipTransform = (x: Xfrm, w: number, h: number) =>
  x.flipH || x.flipV ? `translate(${x.flipH ? w : 0} ${x.flipV ? h : 0}) scale(${x.flipH ? -1 : 1} ${x.flipV ? -1 : 1})` : undefined;

function SpView({ shape, ctx, opts, chain, box, grpFill, top }: ShapeProps & { shape: SpShape }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const x = box ?? effectiveXfrm(shape, chain);
  if (!x) return null;
  const w = x.w * PX;
  const h = x.h * PX;
  const geom = shape.geom ?? chain.find((s): s is SpShape => s.kind === 'sp' && !!s.geom)?.geom;
  const path = shapePath(geom, w, h);
  let paint = shapeFill(shape, chain, ctx);
  if (paint?.fill.type === 'grp') paint = grpFill ?? null;
  const line = isLineGeom(geom);
  const fill = line ? { value: 'none', defs: null } : svgFill(paint, ctx, `f${id}`, w, h);
  const stroke = svgStroke(shapeLine(shape, chain, ctx), ctx);
  const tc = textChain(shape, chain, ctx);
  const isPh = !!shape.ph;
  const empty = isPh && !hasText(shape.text);
  const prompt = empty ? promptText(shape, chain) : null;
  const outline = opts.edit && empty && prompt && !stroke && fill.value === 'none';
  let rect = path.text;
  if (x.flipH) rect = { l: w - rect.r, t: rect.t, r: w - rect.l, b: rect.b };
  if (x.flipV) rect = { l: rect.l, t: h - rect.b, r: rect.r, b: h - rect.t };
  const headId = `h${id}`;
  const tailId = `t${id}`;
  const fillOf = (kind: string) => {
    if (kind === 'none') return 'none';
    if (kind === 'norm' || !fill.hex) return fill.value;
    return `#${shade(fill.hex, kind)}`;
  };
  return (
    <div style={{ ...boxStyle(x), pointerEvents: line ? 'none' : undefined }} data-shape={top ? shape.uid : undefined} data-child={top ? undefined : shape.uid}>
      <svg width={Math.max(w, 1)} height={Math.max(h, 1)} overflow="visible" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>
          {fill.defs}
          {stroke?.head && marker(headId, stroke.head, stroke.color, true)}
          {stroke?.tail && marker(tailId, stroke.tail, stroke.color, false)}
        </defs>
        <g transform={flipTransform(x, w, h)}>
          {path.paths.map((p, i) => (
            <path
              key={i}
              d={p.d}
              fill={fillOf(p.fill)}
              fillRule="evenodd"
              stroke={p.stroke && stroke ? stroke.color : 'none'}
              strokeWidth={stroke?.width}
              strokeDasharray={stroke?.dash}
              strokeLinecap={stroke?.cap}
              strokeLinejoin={stroke?.join}
              markerStart={p.stroke && stroke?.head ? `url(#${headId})` : undefined}
              markerEnd={p.stroke && stroke?.tail ? `url(#${tailId})` : undefined}
            />
          ))}
          {line && top && <path d={path.paths[0]?.d} stroke="transparent" strokeWidth={10} fill="none" pointerEvents="stroke" />}
        </g>
        {outline && <rect x={0} y={0} width={w} height={h} fill="none" stroke="#a6a6a6" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
      </svg>
      <TextBox shape={shape} body={shape.text} chain={tc} rect={rect} ctx={ctx} opts={opts} prompt={prompt} />
      {opts.edit && top && empty && opts.editing !== shape.uid && (shape.ph?.type === undefined || shape.ph?.type === 'obj' || shape.ph?.type === 'pic' || shape.ph?.type === 'tbl') && (
        <PlaceholderIcons kinds={shape.ph?.type === 'pic' ? ['picture'] : shape.ph?.type === 'tbl' ? ['table'] : ['table', 'picture']} w={w} h={h} />
      )}
    </div>
  );
}

/** The insert icons in the middle of an empty content placeholder. */
function PlaceholderIcons({ kinds, w, h }: { kinds: ('table' | 'picture')[]; w: number; h: number }) {
  const s = Math.max(20, Math.min(40, Math.min(w, h) / 6));
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: s * 0.4, pointerEvents: 'none' }}>
      {kinds.map((k) => (
        <span
          key={k}
          data-ph-action={k}
          title={k === 'table' ? 'Insert Table' : 'Pictures'}
          style={{ width: s, height: s, pointerEvents: 'auto', cursor: 'pointer', display: 'grid', placeItems: 'center', borderRadius: s * 0.12 }}
          className="hover:bg-black/5"
        >
          <svg viewBox="0 0 24 24" width={s * 0.8} height={s * 0.8} fill="none" stroke="#8c8c8c" strokeWidth={1.4}>
            {k === 'table' ? (
              <>
                <rect x="3" y="4" width="18" height="16" />
                <path d="M3 9h18M3 14.5h18M9 4v16M15 4v16" />
              </>
            ) : (
              <>
                <rect x="3" y="5" width="18" height="14" rx="1" />
                <circle cx="8.5" cy="10" r="1.6" />
                <path d="M4 18l5.5-5.5 4 4 2.5-2.5 4 4" />
              </>
            )}
          </svg>
        </span>
      ))}
    </div>
  );
}

function PicView({ shape, ctx, opts, chain, box, top }: ShapeProps & { shape: PicShape }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const x = box ?? effectiveXfrm(shape, chain);
  if (!x) return null;
  const w = x.w * PX;
  const h = x.h * PX;
  const path = shapePath(shape.geom, w, h);
  const stroke = svgStroke(shapeLine(shape, chain, ctx), ctx);
  const url = ctx.media(shape.media);
  const c = shape.crop;
  const iw = w / (1 - (c?.l ?? 0) - (c?.r ?? 0));
  const ih = h / (1 - (c?.t ?? 0) - (c?.b ?? 0));
  const clip = `url(#c${id})`;
  const prompt = !shape.media && shape.ph && opts.edit ? 'Picture' : null;
  return (
    <div style={boxStyle(x)} data-shape={top ? shape.uid : undefined}>
      <svg width={Math.max(w, 1)} height={Math.max(h, 1)} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>
          {clip && (
            <clipPath id={`c${id}`}>
              {path.paths.map((p, i) => (
                <path key={i} d={p.d} />
              ))}
            </clipPath>
          )}
        </defs>
        <g transform={flipTransform(x, w, h)}>
          {url ? (
            <image href={url} x={-(c?.l ?? 0) * iw} y={-(c?.t ?? 0) * ih} width={iw} height={ih} preserveAspectRatio="none" clipPath={clip} />
          ) : (
            <rect width={w} height={h} fill={prompt ? 'none' : '#e7e6e6'} stroke="#a6a6a6" strokeDasharray={prompt ? '4 3' : undefined} vectorEffect="non-scaling-stroke" />
          )}
          {stroke &&
            path.paths.map((p, i) => (
              <path key={i} d={p.d} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeDasharray={stroke.dash} strokeLinejoin={stroke.join} />
            ))}
        </g>
      </svg>
      {!url && shape.media && <MissingPicture w={w} h={h} />}
    </div>
  );
}

function MissingPicture({ w, h }: { w: number; h: number }) {
  const s = Math.min(w, h) * 0.3;
  return (
    <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }} viewBox={`0 0 ${w} ${h}`}>
      <g transform={`translate(${(w - s) / 2} ${(h - s) / 2})`} stroke="#7f7f7f" fill="none" strokeWidth={Math.max(1, s / 24)}>
        <rect width={s} height={s * 0.8} rx={s * 0.06} />
        <circle cx={s * 0.3} cy={s * 0.28} r={s * 0.08} />
        <path d={`M${s * 0.08} ${s * 0.68}L${s * 0.38} ${s * 0.4}L${s * 0.62} ${s * 0.62}L${s * 0.75} ${s * 0.5}L${s * 0.92} ${s * 0.68}`} />
      </g>
    </svg>
  );
}

function GroupView({ shape, ctx, opts, box, top, grpFill }: ShapeProps & { shape: Extract<Shape, { kind: 'grp' }> }) {
  const x = box ?? shape.xfrm;
  const sx = shape.ch.w ? x.w / shape.ch.w : 1;
  const sy = shape.ch.h ? x.h / shape.ch.h : 1;
  const fill: Paint | null = shape.fill ? (shape.fill.type === 'grp' ? (grpFill ?? null) : { fill: shape.fill }) : (grpFill ?? null);
  const flip = x.flipH || x.flipV ? `scale(${x.flipH ? -1 : 1}, ${x.flipV ? -1 : 1})` : '';
  const style = boxStyle(x);
  if (flip) style.transform = `${style.transform ?? ''} ${flip}`.trim();
  return (
    <div style={style} data-shape={top ? shape.uid : undefined}>
      {shape.children.map((c) => {
        if (c.hidden) return null;
        const cx = 'xfrm' in c && c.xfrm ? c.xfrm : null;
        if (!cx) return null;
        const child: Xfrm = { ...cx, x: (cx.x - shape.ch.x) * sx, y: (cx.y - shape.ch.y) * sy, w: cx.w * sx, h: cx.h * sy };
        return <ShapeView key={c.uid} shape={c} ctx={ctx} opts={opts} chain={[]} box={child} grpFill={fill} />;
      })}
    </div>
  );
}

// ---- Tables -----------------------------------------------------------------------------

function TableView({ frame, ctx, opts }: { frame: FrameShape; ctx: SlideCtx; opts: RenderOpts }) {
  const table = frame.table!;
  const borderCss = (ln: Line | null | undefined): string | undefined => {
    if (!ln || !ln.fill || ln.fill.type !== 'solid') return ln === null ? 'none' : undefined;
    const color = colorCss(ln.fill.color, ctx);
    return `${Math.max(0.5, (ln.w ?? 12700) * PX)}px ${ln.dash && ln.dash !== 'solid' ? 'dashed' : 'solid'} ${color}`;
  };
  return (
    <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: table.cols.reduce((x, y) => x + y, 0) * PX, position: 'absolute', left: 0, top: 0 }}>
      <colgroup>
        {table.cols.map((w, i) => (
          <col key={i} style={{ width: w * PX }} />
        ))}
      </colgroup>
      <tbody>
        {table.rows.map((row, r) => (
          <tr key={r} style={{ height: row.h * PX }}>
            {row.cells.map((cell, c) => {
              if (cell.hMerge || cell.vMerge) return null;
              const look = cellLook(frame, r, c, ctx);
              const env = textEnv(ctx, look.chain);
              const [ml, mt, mr, mb] = look.margins;
              const editing = opts.editing === frame.uid && opts.editingCell?.[0] === r && opts.editingCell?.[1] === c && opts.editor;
              return (
                <td
                  key={c}
                  data-cell={`${r},${c}`}
                  colSpan={cell.gridSpan}
                  rowSpan={cell.rowSpan}
                  className="sl-text"
                  style={{
                    ...(look.fill ? cssBackground({ fill: look.fill }, ctx) : {}),
                    padding: `${mt * PX}px ${mr * PX}px ${mb * PX}px ${ml * PX}px`,
                    verticalAlign: look.anchor === 'ctr' ? 'middle' : look.anchor === 'b' ? 'bottom' : 'top',
                    borderLeft: borderCss(look.borders.l),
                    borderRight: borderCss(look.borders.r),
                    borderTop: borderCss(look.borders.t),
                    borderBottom: borderCss(look.borders.b),
                    overflow: 'hidden',
                  }}
                >
                  {editing ? opts.editor!(frame, { chain: look.chain, env }, [r, c]) : <TextParas paras={cell.text.paras} chain={look.chain} env={env} links={opts.links} />}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FrameView({ shape, ctx, opts, chain, box, top }: ShapeProps & { shape: FrameShape }) {
  const x = box ?? effectiveXfrm(shape, chain) ?? shape.xfrm;
  const w = x.w * PX;
  const h = x.h * PX;
  let content: ReactNode;
  if (shape.table) content = <TableView frame={shape} ctx={ctx} opts={opts} />;
  else if (shape.chartPart && ctx.chart) {
    const data = ctx.chart(shape.chartPart);
    content = data ? <ChartView chart={data} ctx={ctx} w={w} h={h} /> : null;
  }
  if (!content && shape.preview && shape.previewSpace) {
    const sp = shape.previewSpace;
    const sx = sp.w ? x.w / sp.w : 1;
    const sy = sp.h ? x.h / sp.h : 1;
    content = shape.preview.map((c) => {
      const cx = 'xfrm' in c && c.xfrm ? c.xfrm : null;
      if (!cx) return null;
      return <ShapeView key={c.uid} shape={c} ctx={ctx} opts={{ ...opts, edit: false }} chain={[]} box={{ ...cx, x: (cx.x - sp.x) * sx, y: (cx.y - sp.y) * sy, w: cx.w * sx, h: cx.h * sy }} />;
    });
  }
  if (!content) {
    content = (
      <div style={{ position: 'absolute', inset: 0, border: '1px solid #bfbfbf', background: 'rgba(242,242,242,0.85)', display: 'grid', placeItems: 'center', color: '#7f7f7f', fontFamily: 'Carlito, sans-serif', fontSize: Math.max(12, Math.min(w, h) / 8) }}>
        {shape.label ?? 'Object'}
      </div>
    );
  }
  return (
    <div style={boxStyle(x)} data-shape={top ? shape.uid : undefined}>
      {content}
    </div>
  );
}

export function ShapeView(props: ShapeProps) {
  const { shape, opts } = props;
  if (shape.hidden || opts.hide?.has(shape.uid)) return null;
  switch (shape.kind) {
    case 'sp':
      return <SpView {...props} shape={shape} />;
    case 'pic':
      return <PicView {...props} shape={shape} />;
    case 'grp':
      return <GroupView {...props} shape={shape} />;
    case 'frame':
      return <FrameView {...props} shape={shape} />;
    case 'raw': {
      if (!shape.fallback) return null;
      const fb = shape.fallback;
      const box = props.box ?? shape.xfrm;
      return (
        <div data-shape={props.top ? shape.uid : undefined} style={{ display: 'contents' }}>
          <ShapeView {...props} shape={fb} box={box} top={false} />
        </div>
      );
    }
  }
}

// ---- Slides ----------------------------------------------------------------------------

/** The master's and layout's own shapes (not their placeholders), behind the slide's. */
function MasterShapes({ ctx }: { ctx: SlideCtx }) {
  const showLayout = ctx.slide.showMasterSp !== false;
  const showMaster = showLayout && ctx.layout.showMasterSp;
  const opts: RenderOpts = {};
  const own = (s: Shape) => !('ph' in s && s.ph);
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {showMaster &&
        ctx.master.shapes.filter(own).map((s) => <ShapeView key={s.uid} shape={s} ctx={{ ...ctx, layout: ctx.layout }} opts={opts} chain={[]} />)}
      {showLayout && ctx.layout.shapes.filter(own).map((s) => <ShapeView key={s.uid} shape={s} ctx={ctx} opts={opts} chain={[]} />)}
    </div>
  );
}

/** The slide background; duotone pictures (a theme's textures) get an SVG filter. */
function Backdrop({ paint, ctx }: { paint: Paint | null; ctx: SlideCtx }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const style = cssBackground(paint, ctx);
  const duo = paint?.fill.type === 'blip' ? paint.fill.duotone : undefined;
  if (!duo) return <div style={{ position: 'absolute', inset: 0, ...style }} />;
  const [a, b] = duo.map((c) => resolveColorModel(c, ctx.theme, ctx.clrMap, paint?.phClr)?.hex ?? '808080');
  const ch = (hex: string, i: number) => (parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255).toFixed(3);
  return (
    <>
      <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden>
        <filter id={`d${id}`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="table" tableValues={`${ch(a, 0)} ${ch(b, 0)}`} />
            <feFuncG type="table" tableValues={`${ch(a, 1)} ${ch(b, 1)}`} />
            <feFuncB type="table" tableValues={`${ch(a, 2)} ${ch(b, 2)}`} />
          </feComponentTransfer>
        </filter>
      </svg>
      <div style={{ position: 'absolute', inset: 0, ...style, filter: `url(#d${id})` }} />
    </>
  );
}

export const SlideContent = memo(function SlideContent({ ctx, opts }: { ctx: SlideCtx; opts: RenderOpts }) {
  const bg = background(ctx);
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: ctx.deck.w * PX, height: ctx.deck.h * PX, overflow: 'hidden' }}>
      <Backdrop paint={bg} ctx={ctx} />
      <MasterShapes ctx={ctx} />
      {ctx.slide.shapes.map((s) => (
        <ShapeView key={s.uid} shape={s} ctx={ctx} opts={opts} chain={inheritChain(s, ctx)} top />
      ))}
    </div>
  );
});

/** A slide drawn `width` pixels wide. */
export function SlideImage({ ctx, width, opts = {}, className, style }: { ctx: SlideCtx; width: number; opts?: RenderOpts; className?: string; style?: CSSProperties }) {
  const scale = width / (ctx.deck.w * PX);
  return (
    <div className={className} style={{ position: 'relative', width, height: ctx.deck.h * PX * scale, overflow: 'hidden', ...style }}>
      <div style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: `scale(${scale})` }}>
        <SlideContent ctx={ctx} opts={opts} />
      </div>
    </div>
  );
}
